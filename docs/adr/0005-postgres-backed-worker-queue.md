# Postgres-backed worker queue

The worker claims sync and asset resolution jobs straight from Postgres with `FOR UPDATE SKIP LOCKED` instead of consuming a BullMQ queue. The pending `processing_jobs` row is the whole hand-off, so BullMQ and Redis are removed entirely.

## Status

Accepted

## Context

Postgres was already the source of truth for job state: status, attempts, retry timing, heartbeats, prerequisites, and replay boundaries all lived in `processing_jobs` and `asset_resolution_jobs`. BullMQ only moved job ids between processes, but keeping the two systems aligned cost around three thousand lines of glue: startup repair and requeue, retry translation between BullMQ options and DB columns, `moveToDelayed` handling, enqueue plus `attachQueueMetadata`, dispatch-readiness checks, and two stall detectors (BullMQ locks and DB heartbeats).

Redis served nothing else. Sessions, OAuth state, and caches were already Postgres. The two queues also used opposite retry models: BullMQ owned source sync retries while the DB owned asset resolution retries.

Job creation must be atomic with business writes (a source row and its sync job in one transaction), which a Redis queue can never give us. That made Postgres the owner of job truth from the start and reduced BullMQ to a cache of "what is ready" that needed constant reconciliation.

## Decision

- The API writes the pending job row and returns. There is no enqueue step and no queue metadata.
- One shared poll loop in the worker (`WorkerJobPoller`) lists ready jobs and runs them with bounded concurrency; thin layers wire it to the source sync and asset resolution executors.
- Claims use `FOR UPDATE SKIP LOCKED`, so any number of worker processes can poll the same table and a lost claim race is a no-op.
- Both job types use the DB-owned retry model that asset resolution already used: claiming counts the attempt, a retryable failure writes an exponential `next_retry_at` and releases the row, and the poll loop picks it up once due. Waiting on replay scheduling hands its attempt back.
- Crashed source sync jobs are recovered by a periodic stale-heartbeat sweep that terminally fails the job, materializes its owed follow-up replay, and cascade-fails dependents - the same semantics the old startup repair had, now running continuously. Asset resolution reclaims stale jobs inside the claim, as before.
- Shutdown drains in-flight jobs up to a timeout before the fibers are interrupted.

## Consequences

- One state machine. No Redis in development, CI, or production.
- The claim, lease, and retry behavior is now our own code. The claim-contention and stale-recovery integration tests replace the safety net BullMQ's stall detection provided.
- The continuous sweep slightly widens the stale-worker race window compared to the old boot-only repair: a worker that stalls longer than `SOURCE_SYNC_STALE_AFTER_MS` between heartbeats can be swept while still alive. The durable fix is the claim-lease hardening chain (#110, #111, #112), which this change deliberately leaves open and makes easier: there is now a single claim site and a single sweep for the lease work to build on.
- Stale source sync jobs are terminally failed even when attempts remain, preserving the old repair semantics. Releasing them back to pending is a possible follow-up.
- Poll latency (default 5s) replaces push delivery. That is well within tolerance for sync jobs and can be tightened with `LISTEN/NOTIFY` later without changing ownership.
