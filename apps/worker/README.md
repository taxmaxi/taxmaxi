# Source Sync Worker

Runs the BullMQ source sync consumer and a lightweight `/health` endpoint for liveness checks.

Required runtime configuration:

- `QUEUE_REDIS_URL`
- Postgres `PG*` variables used by `@effect/sql-pg`
- Coinbase OAuth client config for Coinbase source execution

Optional configuration:

- `WORKER_HEALTH_PORT`, default `4001`
- `SYNC_WORKER_CONCURRENCY`, default `1`
- `SYNC_WORKER_LOCK_DURATION_MS`, default `30000`
- `SYNC_WORKER_MAX_ATTEMPTS`, default `3` when `SOURCE_SYNC_QUEUE_ATTEMPTS` is unset
- `WORKER_ID`, default generated once at process start
- `SOURCE_SYNC_QUEUE_PREFIX`, default `taxmaxi`
- `SOURCE_SYNC_QUEUE_ATTEMPTS`, default `3`, falls back to `SYNC_WORKER_MAX_ATTEMPTS`
- `SOURCE_SYNC_QUEUE_BACKOFF_DELAY_MS`, default `5000`
- `SOURCE_SYNC_QUEUE_REMOVE_ON_COMPLETE_COUNT`, default `1000`
- `SOURCE_SYNC_QUEUE_REMOVE_ON_FAIL_COUNT`, default `5000`
- `SOURCE_SYNC_REPAIR_STALE_AFTER_MS`, default `120000`
- `SOURCE_SYNC_REPAIR_BATCH_SIZE`, default `100`

Startup repair uses the same `SOURCE_SYNC_QUEUE_*` job option environment variables as the API producer so requeued jobs behave like freshly queued jobs.
