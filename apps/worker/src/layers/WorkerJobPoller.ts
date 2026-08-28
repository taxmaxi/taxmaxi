/**
 * WorkerJobPoller - Shared poll loop that moves jobs from Postgres to an executor.
 *
 * One loop shape serves every job type: list ready work, run each item with
 * bounded concurrency, sleep, repeat. Errors never stop the loop - a failed
 * job or a failed tick is logged and the next tick starts fresh. On scope
 * close the loop stops listing new work and the finalizer waits for in-flight
 * jobs up to a drain timeout; the scope's own fiber interruption is the
 * backstop for jobs that outlive the drain.
 *
 * A tick waits for its whole batch before listing again, so with concurrency
 * above one a slow job delays the next list until the batch finishes. The
 * default concurrency of one makes this identical to one-job-at-a-time.
 *
 * @module WorkerJobPoller
 */

import { Deferred, Effect, Fiber, type Scope } from "effect"

/**
 * WorkerJobPollerOptions - One poll loop over a Postgres-backed job list.
 */
export interface WorkerJobPollerOptions<Job> {
  /** Log identifier, e.g. "source-sync-poller". */
  readonly name: string
  readonly pollIntervalMs: number
  readonly concurrency: number
  /** How long the finalizer waits for in-flight jobs before giving up. */
  readonly drainTimeoutMs: number
  readonly listJobs: Effect.Effect<ReadonlyArray<Job>>
  readonly runJob: (job: Job) => Effect.Effect<unknown>
}

/**
 * Run one list-and-execute pass. Exported so layers can run a first pass
 * inline at boot before forking the loop.
 */
export const runJobPollerTick = <Job>({
  name,
  concurrency,
  listJobs,
  runJob,
}: Pick<WorkerJobPollerOptions<Job>, "name" | "concurrency" | "listJobs" | "runJob">) =>
  listJobs.pipe(
    Effect.flatMap((jobs) =>
      Effect.forEach(
        jobs,
        (job) =>
          runJob(job).pipe(
            Effect.catchCause((cause) => Effect.logWarning({ cause }, `${name}:job-crashed`))
          ),
        { concurrency, discard: true }
      )
    ),
    Effect.catchCause((cause) => Effect.logWarning({ cause }, `${name}:tick-failed`))
  )

/**
 * Fork the poll loop into the current scope. The loop ticks immediately,
 * then every `pollIntervalMs`. Closing the scope drains in-flight jobs up
 * to `drainTimeoutMs` before the fiber is interrupted.
 */
export const forkJobPoller = <Job>(
  options: WorkerJobPollerOptions<Job>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const shutdown = yield* Deferred.make<void>()
    const tick = runJobPollerTick(options)

    const loop = Effect.gen(function* () {
      while (!(yield* Deferred.isDone(shutdown))) {
        yield* tick
        yield* Effect.sleep(options.pollIntervalMs).pipe(Effect.raceFirst(Deferred.await(shutdown)))
      }
    })

    const fiber = yield* Effect.forkScoped(loop)

    // Finalizers run in reverse order, so this drain runs before the scope
    // interrupts the forked fiber.
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(shutdown, void 0).pipe(
        Effect.andThen(
          Fiber.join(fiber).pipe(
            Effect.timeout(options.drainTimeoutMs),
            Effect.catchCause(() =>
              Effect.logWarning(
                { drainTimeoutMs: options.drainTimeoutMs },
                `${options.name}:drain-timed-out`
              )
            )
          )
        )
      )
    )
  })
