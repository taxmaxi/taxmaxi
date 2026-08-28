# Source Sync Worker

Polls Postgres for ready source sync and asset resolution jobs, runs them with bounded concurrency, and serves a lightweight `/health` endpoint for liveness checks. There is no message broker: the pending job row is the hand-off, and claims use `FOR UPDATE SKIP LOCKED` so several worker processes can run side by side.

Required runtime configuration:

- Postgres `PG*` variables used by `@effect/sql-pg`
- Coinbase OAuth client config for Coinbase source execution

Optional configuration:

- `WORKER_HEALTH_PORT`, default `4001`
- `WORKER_ID`, default generated once at process start
- `WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS`, default `30000`

Source sync loop:

- `SYNC_WORKER_CONCURRENCY`, default `1`
- `SOURCE_SYNC_POLL_INTERVAL_MS`, default `5000`
- `SOURCE_SYNC_DISPATCH_BATCH_SIZE`, default `100`
- `SOURCE_SYNC_STALE_AFTER_MS`, default `120000`
- `SOURCE_SYNC_STALE_SWEEP_INTERVAL_MS`, default `60000`
- `SOURCE_SYNC_RETRY_BASE_DELAY_MS`, default `5000`
- `SOURCE_SYNC_HEARTBEAT_INTERVAL_MS`, default `10000`

Asset resolution loop:

- `ASSET_RESOLUTION_WORKER_CONCURRENCY`, default `1`
- `ASSET_RESOLUTION_POLL_INTERVAL_MS`, default `5000`
- `ASSET_RESOLUTION_DISPATCH_BATCH_SIZE`, default `100`
- `ASSET_RESOLUTION_STALE_AFTER_MS`, default `300000`

Crashed source sync jobs are recovered by a periodic stale-heartbeat sweep: the job is failed, its owed follow-up replay is created, and dependent jobs are cascade-failed. Asset resolution jobs with a stale heartbeat are simply reclaimed by the next worker.
