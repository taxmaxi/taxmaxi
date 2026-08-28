# Replace BullMQ/Redis with a PostgreSQL-backed worker loop

## Context

PostgreSQL already owns all durable job state: `processing_jobs` (status, attempts, heartbeat, retry timing, credit state, checkpoints), `processing_job_dependencies` (prerequisites), `asset_resolution_jobs`, and replay boundaries. BullMQ adds a second state machine in Redis that must be kept aligned with the database, which costs ~3,000 lines of glue: startup repair and requeue (755-line `WorkerSourceSyncStartupRepairLive`), retry translation between BullMQ options and DB columns, `moveToDelayed` handling, enqueue + `attachQueueMetadata`, dispatch-readiness checks, and duplicated stall detection (BullMQ locks _and_ DB heartbeats). Redis serves nothing else — sessions, OAuth state, and caches are all Postgres.

This change removes BullMQ and Redis entirely. The worker claims ready jobs directly from Postgres with `FOR UPDATE SKIP LOCKED`, processes them with bounded concurrency, and recovers crashed jobs via the existing `heartbeat_at` lease. The dependency graph, replay planning, principal isolation, and atomic replay reset are unchanged — only how ready work reaches a worker changes. Both job types unify on the DB-owned retry model asset-resolution already uses. Pre-launch stance: hard migration, no compatibility bridge.

Deliverables: (1) this plan saved as `docs/plans/2026-08-28-replace-bullmq-with-postgres-worker-loop.md` (maintainer asked for the plan in `docs/`); (2) one PR, ordered commits below; (3) `docs/adr/0005-postgres-backed-worker-queue.md`.

## Verified current state

- Queues `source-sync` / `asset-resolution`; contracts in `packages/sync-engine/src/services/SourceSyncQueue.ts`, `AssetResolutionQueue.ts`. Producer `apps/server/src/layers/ApiBullMqSourceSyncQueueLive.ts`; consumers + repair in `apps/worker/src/layers/`. Job repositories: `packages/persistence/src/layers/SourceSyncJobRepositoryLive.ts` (claim at :620, plain `FOR UPDATE` + double-check), `AssetResolutionJobRepositoryLive.ts` (claim at :101 with evidence/policy-revision checks).
- Retry models differ: source-sync → BullMQ owns retries; asset-resolution → DB owns retries (`nextRetryAt`, consumer always throws `UnrecoverableError`). Target = the asset-resolution model.
- Both consumers already fork a 5s dispatch poller; the poll loop concept exists.
- `queued_at` is exposed via the sources report API (`SourcesApi.ts:313`) — keep it. `queue_name`/`queue_job_id` have no consumers outside the glue — drop them.
- Redis: `ioredis` in exactly 4 files, all BullMQ transport. CI (`.github/workflows/pr.yml`) boots a redis service; `compose.yaml` has one; `internal/.env.prod.example` has a vestigial `REDIS_URL` no code reads.
- Architecture guardrail tests banning bullmq/ioredis in core/persistence/rest-api stay untouched and keep passing.
- Replay-dependency prerequisite work (#206, #208) is merged — sequencing precondition satisfied.

## Design

### Claim path: list-then-claim, SKIP LOCKED on the claim

Keep the two-step shape because both claims run per-job logic under lock that a set-based UPDATE can't express (source-sync re-checks the prerequisite predicate; asset-resolution auto-completes stale evidence revisions and skips policy-revision mismatches).

- New `listClaimableJobs` in `SourceSyncJobRepositoryLive.ts` (replaces `listPendingJobsNeedingDispatch`): `status = 'pending' AND principal_id IS NOT NULL AND <prerequisite predicate, existing sql fragment :49> AND (next_retry_at IS NULL OR next_retry_at <= now)`, ordered by `created_at`, limited.
- `claimJob` gains `.for("update", { skipLocked: true })` so a concurrent claimer no-ops (existing Conflict path) instead of queuing on the row lock; it now also gates on `nextRetryAt`, increments `attempt_count`, and returns `attemptCount`/`maxAttempts` on `SourceSyncExecutionJob`.
- `claimResolutionJob` only gains `{ skipLocked: true }` — its `undefined → not_claimable` branch already handles it.
- The one-active-job-per-source partial index is unaffected (`pending → processing` stays inside its predicate).
- Verify early that the effect-drizzle wrapper passes `.for("update", { skipLocked: true })` through (plain `.for("update")` already works).

### Worker loop: one shared helper, two thin layers

New `apps/worker/src/layers/WorkerJobPoller.ts` (~60 lines, plain scoped function): loop of `listJobs → Effect.forEach(runJob, { concurrency, discard })`, per-job and per-tick error isolation to `logWarning`, shutdown via `Deferred` + finalizer that drains in-flight jobs with `WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS`. Used by:

- `WorkerSourceSyncPollerLive.ts` — `runJob = executor.execute({ jobId, workerId })`, plus a second forked loop: the stale sweep (below).
- `WorkerAssetResolutionPollerLive.ts` — `runJob = executor.executeJob({ jobId, workerId })`.

No per-claim lease fiber: source-sync already heartbeats inside the executor (`withActiveJobHeartbeat`, batch boundaries); asset-resolution jobs are short with a 5-minute stale window. `apps/worker/src/index.ts` changes are mostly import swaps; `WorkerHealthServerLive` and `TracingLive` stay.

### Crash recovery: asymmetric on purpose

- Asset-resolution: reclaim-in-claim already exists (`claimableStaleProcessing`) — nothing to build.
- Source-sync: keep today's semantics — a stale `processing` job is terminally failed via the existing `recoverStaleActiveJob` (which also materializes the follow-up replay and cascade-fails dependents in one transaction). Promote it from boot-only to a periodic sweep loop (`listStaleActiveJobs` → `recoverStaleActiveJob`, cutoff `SOURCE_SYNC_STALE_AFTER_MS` 120s, interval 60s, plus one sweep at boot before the first dispatch tick). This replaces all of `WorkerSourceSyncStartupRepairLive.ts`. Releasing stale jobs back to pending when attempts remain is a possible follow-up, deliberately not in this PR (behavior-preserving).

### Retry unification (DB-owned)

In `SourceSyncJobExecutorLive.ts`: drop the `retryPolicy` param and `SourceSyncJobRetryableExecutionError`. On retryable failure with `attemptCount < maxAttempts`, write `nextRetryAt = now + SOURCE_SYNC_RETRY_BASE_DELAY_MS * 2^(attemptCount-1)` via `persistRetryableSyncFailure` and return a `"queued"` summary (no throw); else `finalizeSyncFailure`. `moveToDelayed`'s replacement is the `nextRetryAt` gate itself — `returnReplaySchedulingToDispatcher` already writes it. Subtlety: the replay-scheduling-pending path must decrement the claim's attempt increment so waiting doesn't burn attempts (today `moveToDelayed` consumes none). `max_attempts` stays tunable via config in `SourceSyncServiceLive` at row creation.

### Producer: the pending row is the enqueue

Delete the `SourceSyncQueue` port, `AssetResolutionQueue.ts`, `ApiBullMqSourceSyncQueueLive.ts`, and `attachQueueMetadata`. `SourceSyncServiceLive.ts` loses `enqueuePendingJob`, `shouldEnqueuePendingJob`, and the readiness probe — reused-pending-job branches collapse to "return its status". `SourceSyncQueueError` leaves the error unions (`SourcesApiLive.ts:189,399`, `SourceCreationServiceLive.ts:373`, `SourceSyncRunServiceLive.ts:42,152`). `createProcessingJob` sets `queued_at` at insert (column stays, API exposes it). Follow-up dispatch after job completion is deleted entirely — `materializeFollowUpJob` writes a pending row and the poller finds it within one interval.

## Commit plan (each compiles, tests green)

1. **feat(persistence,sync-engine): DB-owned retries + SKIP LOCKED claims** — `SourceSyncModels.ts`, `SourceSyncJobRepository.ts` (+`listClaimableJobs`), `SourceSyncJobRepositoryLive.ts`, `AssetResolutionJobRepositoryLive.ts`, `SourceSyncJobExecutor.ts`, `SourceSyncJobExecutorLive.ts`; temporary shim in the BullMQ consumer (stop passing `retryPolicy`); update `source-sync-job-executor.test.ts`.
2. **feat(worker): Postgres poller cutover** — add `WorkerJobPoller.ts`, `WorkerSourceSyncPollerLive.ts`, `WorkerAssetResolutionPollerLive.ts`; delete both BullMQ consumers + `WorkerSourceSyncStartupRepairLive.ts` + their 3 test files; rewrite `apps/worker/src/index.ts`; drop `bullmq`/`ioredis` from `apps/worker/package.json`; add `WorkerJobPoller.test.ts` (concurrency bound, tick error isolation, drain).
3. **feat(server,sync-engine): delete queue producer** — remove the files above; strip `SourceSyncServiceLive.ts`; error-union cleanup in rest-api and `SourceSyncRunServiceLive.ts`; delete `attachQueueMetadata`, `listPendingJobsNeedingDispatch`, `listRepairableActiveJobs`; clean `apps/server`. Replace `packages/sync-engine/tests/support/SourceSyncQueueInlineExecutorTestLive.ts` with a `runSourceSyncJobInline(jobId)` helper and update its 5 sync-engine integration suites + `SourcesApiLive.integration.test.ts` + `SyncRunsApiLive.integration.test.ts`; delete `source-sync-queue-payload.test.ts`; rewrite `source-sync-service-queue.test.ts` around row creation/reuse.
4. **feat(persistence)!: drop queue metadata columns** — `ProcessingJobsTable.ts`: remove `queueName`, `queueJobId`, `idx_processing_jobs_queue_job`, `processing_jobs_queue_job_unique`; add partial index `(status, next_retry_at) WHERE status = 'pending'`; `migration:generate`.
5. **test(persistence,worker): concurrency + recovery integration tests** — in `packages/persistence/tests/source-sync/` (template-DB setup via `tests/support/vitest.integration.setup.ts` already exists): two concurrent `claimJob`s → one wins, loser no-ops; stale source-sync job swept → failed + follow-up materialized + dependents cascaded; stale asset-resolution job reclaimed by second worker; prerequisite gating in `listClaimableJobs` (blocked → excluded, prerequisite completes → included); `nextRetryAt` gate; replay-pending delay; shutdown drain (worker unit test).
6. **chore(repo): remove Redis from infra + env** — `compose.yaml`, `.github/workflows/pr.yml` (redis service, wait steps, `QUEUE_REDIS_URL`), `.env.example` files, `internal/.env.prod.example` (`REDIS_URL` too).
7. **docs: rewrite queue architecture docs + ADR 0005** — `docs/sync-data-layer-lifecycle.md` Chapter 3 + retry paragraph (:266); `apps/worker/README.md` env table; `AGENTS.md:30`; new `docs/adr/0005-postgres-backed-worker-queue.md` (decision, retry-model unification, stale-fail semantics); add `docs/plans/2026-08-28-replace-bullmq-with-postgres-worker-loop.md` (this plan — written first, as commit 0 or part of this commit per maintainer's "plan inside docs" request).

Env changes: remove `QUEUE_REDIS_URL`, queue prefixes, lock durations, BullMQ attempt/backoff/removeOn vars, `SOURCE_SYNC_REPAIR_*`; rename `*_PENDING_DISPATCH_INTERVAL_MS` → `*_POLL_INTERVAL_MS`; new `SOURCE_SYNC_DISPATCH_BATCH_SIZE` (100), `SOURCE_SYNC_STALE_AFTER_MS` (120000), `SOURCE_SYNC_STALE_SWEEP_INTERVAL_MS` (60000), `SOURCE_SYNC_RETRY_BASE_DELAY_MS` (5000), `WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS` (30000); keep concurrency vars, `WORKER_ID`, `WORKER_HEALTH_PORT`, `SOURCE_SYNC_HEARTBEAT_INTERVAL_MS`, `ASSET_RESOLUTION_STALE_AFTER_MS`, `ASSET_RESOLUTION_DISPATCH_BATCH_SIZE`.

## Related open issues (scope decision)

- **#159 (consumer bootstrap + representation cascade):** Part 1 (shared BullMQ consumer bootstrap) is made obsolete by this PR — both consumers are deleted and `WorkerJobPoller.ts` _is_ the shared bootstrap, without Redis. Part 2 (one discriminator for the native/contract/mint cascade in core/persistence/sync-engine) is unrelated to the queue and stays open. After merge: comment on #159 that part 1 is superseded by this PR and re-scope the issue to part 2 only.
- **#110 → #111 → #112 (claim-lease identity → job-scoped heartbeat loop → fenced job-owned writes):** a dependency chain hardening the claim/lease model against stale-worker races. **Not obsoleted** by this PR — the races they describe exist today under BullMQ and still exist after the swap (the plan deliberately preserves today's semantics). **Not included** either: each needs schema changes, executor-wide transitions, and race-ordering integration tests; folding them in breaks the one-session/one-PR envelope and muddies "behavior-preserving". Doing the queue swap _first_ helps them: it leaves a single claim site, a single sweep, and no BullMQ lock layer for the lease work to reason around. The claim changes here stay lease-compatible (claim returns the updated job; adding a lease id later is a column + signature addition, no rework). Note in the ADR: the continuous stale sweep slightly widens the #110/#112 race window vs today's boot-only repair, which raises the priority of that chain as the immediate follow-up.

## Known risks (accepted, documented in ADR)

- Stale source-sync jobs are terminally failed even with attempts remaining (today's semantics; revisit separately).
- A provider page slower than the 120s stale cutoff would be swept mid-run — same exposure as today's repair, but the sweep is now continuous. The durable fix is the #110/#111/#112 chain (full-lifetime heartbeat loop + fencing), tracked there, not here.
- `revision_mismatch` resolution jobs re-list every tick during rolling deploys (log noise only, same as today).
- First implementation step: confirm effect-drizzle passes `skipLocked` through; if not, fall back to a raw `sql` fragment in the same repository method.

## Verification

- Per commit: `mise x -- pnpm run type-check`, `type-check:tests`, `lint`, `mise x -- pnpm run test --project=unit`.
- Integration: `mise x -- pnpm run test --project=integration` (template-DB setup, run from repo root) — must cover the six scenarios in commit 5.
- End-to-end: `mise x -- pnpm --filter @my/persistence run migration:run`, start server + worker via package dev scripts with no Redis running, create a source through the API, watch the job go `pending → processing → completed` and the follow-up replay job get claimed; kill the worker mid-sync and watch the sweep fail the stale job and cascade correctly on restart.
- Grep gate before merge: zero hits for `bullmq|ioredis|QUEUE_REDIS_URL` outside `repos/` and lockfile history.
