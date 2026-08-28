import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { forkJobPoller } from "../src/layers/WorkerJobPoller.ts"

describe("WorkerJobPoller", () => {
  it("runs listed jobs with bounded concurrency", async () => {
    let active = 0
    let maxActive = 0
    const ran: Array<number> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>()

          yield* forkJobPoller({
            name: "test-poller",
            pollIntervalMs: 60_000,
            concurrency: 2,
            drainTimeoutMs: 1_000,
            listJobs: Effect.succeed([1, 2, 3, 4]),
            runJob: (job: number) =>
              Effect.gen(function* () {
                active += 1
                maxActive = Math.max(maxActive, active)
                yield* Effect.sleep(20)
                active -= 1
                ran.push(job)
                if (ran.length === 4) {
                  yield* Deferred.succeed(done, void 0)
                }
              }),
          })

          yield* Deferred.await(done)
        })
      )
    )

    expect([...ran].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(maxActive).toBe(2)
  })

  it("keeps polling after a job crashes", async () => {
    let tick = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>()

          yield* forkJobPoller({
            name: "test-poller",
            pollIntervalMs: 10,
            concurrency: 1,
            drainTimeoutMs: 1_000,
            listJobs: Effect.sync(() => {
              tick += 1
              return [tick]
            }),
            runJob: (job: number) =>
              job === 1 ? Effect.die(new Error("job crashed")) : Deferred.succeed(done, void 0),
          })

          yield* Deferred.await(done)
        })
      )
    )

    expect(tick).toBeGreaterThanOrEqual(2)
  })

  it("drains the in-flight job before the scope closes", async () => {
    let finished = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()

          yield* forkJobPoller({
            name: "test-poller",
            pollIntervalMs: 60_000,
            concurrency: 1,
            drainTimeoutMs: 1_000,
            listJobs: Effect.succeed(["job"]),
            runJob: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, void 0)
                yield* Effect.sleep(50)
                finished = true
              }),
          })

          yield* Deferred.await(started)
        })
      )
    )

    expect(finished).toBe(true)
  })

  // A job sleeping far past the drain timeout must not block scope close;
  // the vitest test timeout is the enforcement.
  it("gives up draining after the timeout instead of hanging", async () => {
    let closed = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()

          yield* forkJobPoller({
            name: "test-poller",
            pollIntervalMs: 60_000,
            concurrency: 1,
            drainTimeoutMs: 50,
            listJobs: Effect.succeed(["job"]),
            runJob: () =>
              Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.sleep(60_000))),
          })

          yield* Deferred.await(started)
        })
      )
    )
    closed = true

    expect(closed).toBe(true)
  })
})
