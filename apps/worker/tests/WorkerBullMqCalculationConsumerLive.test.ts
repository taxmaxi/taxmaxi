import { ConfigProvider, DateTime, Effect, Layer, Result, Schema } from "effect"
import { UnrecoverableError, type JobsOptions } from "bullmq"
import { describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import {
  CalculationRunId,
  CalculationRunAlreadyStoredError,
  CalculationRunService,
  InputLedgerRevision,
  ValuationRevision,
  type CalculationRunServiceShape,
} from "@my/persistence/services"
import {
  makeWorkerBullMqCalculationConsumerLive,
  makeWorkerCalculationRecomputeQueueLive,
  type BullMqCalculationRecomputeQueue,
  type BullMqCalculationRecomputeWorker,
  type WorkerBullMqCalculationJob,
  type WorkerBullMqCalculationProcessor,
} from "../src/layers/WorkerBullMqCalculationConsumerLive.ts"
import {
  CALCULATION_RECOMPUTE_JOB_NAME,
  CalculationRecomputeQueue,
  CalculationRecomputeQueuePayload,
} from "@my/sync-engine/services"

class WorkerTestPromiseRejectionError extends Schema.TaggedError<WorkerTestPromiseRejectionError>()(
  "WorkerTestPromiseRejectionError",
  { cause: Schema.Unknown }
) {}

const principalId = PrincipalId.make("00000000-0000-4000-8000-000000000013")

const makeConfigProvider = () =>
  ConfigProvider.fromEnvRecord({
    QUEUE_REDIS_URL: "redis://localhost:6379",
    CALCULATION_QUEUE_PREFIX: "test-prefix",
    CALCULATION_WORKER_CONCURRENCY: "2",
    WORKER_ID: "worker-test-1",
  })

const makeJob = (data: unknown): WorkerBullMqCalculationJob => ({
  id: "queue-job-1",
  name: CALCULATION_RECOMPUTE_JOB_NAME,
  data,
})

const provideConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider()))

const writeResult = {
  activated: true,
  inputLedgerRevision: InputLedgerRevision.make(`v1:1:${"a".repeat(64)}`),
  valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
  status: "complete",
} as const

const runWithCalculationConsumer = <A>({
  effect,
  service,
  acquireWorker,
}: {
  readonly effect: Effect.Effect<A>
  readonly service: CalculationRunServiceShape
  readonly acquireWorker: (
    processor: WorkerBullMqCalculationProcessor
  ) => Effect.Effect<BullMqCalculationRecomputeWorker>
}) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          makeWorkerBullMqCalculationConsumerLive({
            acquireWorker: (_config, processor) => acquireWorker(processor),
          }).pipe(
            Layer.provide(Layer.succeed(CalculationRunService, CalculationRunService.of(service)))
          )
        ),
        provideConfig
      )
    )
  )

describe("WorkerCalculationRecomputeQueueLive", () => {
  it.effect(
    "asks BullMQ to coalesce concurrent requests and retain one trailing active request",
    () =>
      Effect.gen(function* () {
        const additions: Array<{
          payload: CalculationRecomputeQueuePayload
          options: JobsOptions
        }> = []
        const queue: BullMqCalculationRecomputeQueue = {
          add: (_name, payload, options) => {
            additions.push({ payload, options })
            return Promise.resolve({ id: `job-${additions.length}` })
          },
          close: Effect.void,
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const recomputeQueue = yield* CalculationRecomputeQueue
            yield* Effect.all(
              [
                recomputeQueue.enqueuePrincipalRecompute(principalId),
                recomputeQueue.enqueuePrincipalRecompute(principalId),
                recomputeQueue.enqueuePrincipalRecompute(principalId),
              ],
              { concurrency: "unbounded" }
            )
          }).pipe(
            Effect.provide(
              makeWorkerCalculationRecomputeQueueLive({ acquireQueue: () => Effect.succeed(queue) })
            ),
            provideConfig
          )
        )

        expect(additions).toHaveLength(3)
        expect(additions.map(({ payload }) => payload)).toEqual([
          CalculationRecomputeQueuePayload.make({ principalId }),
          CalculationRecomputeQueuePayload.make({ principalId }),
          CalculationRecomputeQueuePayload.make({ principalId }),
        ])
        for (const { options } of additions) {
          expect(options.jobId).toBeUndefined()
          expect(options.deduplication).toEqual({ id: principalId, keepLastIfActive: true })
        }
      })
  )
})

describe("WorkerBullMqCalculationConsumerLive", () => {
  it.effect("recomputes the principal for the current German scope", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      const recomputes: Array<Parameters<CalculationRunServiceShape["recompute"]>[0]> = []
      const service = CalculationRunService.of({
        recompute: (params) =>
          Effect.sync(() => {
            recomputes.push(params)
            return writeResult
          }),
      })

      yield* Effect.promise(() =>
        runWithCalculationConsumer({
          service,
          acquireWorker: (acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor
            yield* Effect.promise(() =>
              acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId })))
            )
          }),
        })
      )

      expect(recomputes).toHaveLength(1)
      expect(recomputes[0]).toMatchObject({
        principalId,
        jurisdiction: JurisdictionCode.make("DE"),
        reportingCurrency: EUR,
        accountingChoices: [],
      })
      expect(CalculationRunId.make(recomputes[0]?.id ?? "")).toBe(recomputes[0]?.id)
      const expectedYear = DateTime.toParts(
        DateTime.setZoneNamedUnsafe(DateTime.nowUnsafe(), "Europe/Berlin")
      ).year
      expect(recomputes[0]?.taxYear).toBe(TaxYear.make(expectedYear))
    })
  )

  it.effect("rejects malformed payloads without invoking the calculation service", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      let recomputeCount = 0
      const service = CalculationRunService.of({
        recompute: () =>
          Effect.sync(() => {
            recomputeCount += 1
            return writeResult
          }),
      })

      yield* Effect.promise(() =>
        runWithCalculationConsumer({
          service,
          acquireWorker: (acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor
            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(makeJob({ principalId: "not-a-uuid" })),
              catch: (cause) => new WorkerTestPromiseRejectionError({ cause }),
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(UnrecoverableError)
            }
          }),
        })
      )

      expect(recomputeCount).toBe(0)
    })
  )

  it.effect("reports calculation execution failure only through the calculation job", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      const runId = CalculationRunId.make("00000000-0000-4000-8000-000000000014")
      const service = CalculationRunService.of({
        recompute: () => Effect.fail(new CalculationRunAlreadyStoredError({ runId })),
      })

      yield* Effect.promise(() =>
        runWithCalculationConsumer({
          service,
          acquireWorker: (acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor
            const result = yield* Effect.tryPromise({
              try: () =>
                acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId }))),
              catch: (cause) => new WorkerTestPromiseRejectionError({ cause }),
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(CalculationRunAlreadyStoredError)
            }
          }),
        })
      )
    })
  )
})
