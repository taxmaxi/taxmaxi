import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetResolutionJobRepositoryLive } from "../../src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../src/layers/SyncEngineTransactionLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  AssetResolutionJobRepository,
  ProviderAssetRepository,
  SyncEngineStorageError,
  SyncEngineTransaction,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_resolution_job_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runProviderAssetRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

const runJobRepository = <A, E>(effect: Effect.Effect<A, E, AssetResolutionJobRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetResolutionJobRepositoryLive }))

const TransactionalJobLayer = Layer.mergeAll(
  AssetResolutionJobRepositoryLive,
  SyncEngineTransactionLive
)

const runTransactionalJob = <A, E>(
  effect: Effect.Effect<A, E, AssetResolutionJobRepository | SyncEngineTransaction>
) => Effect.runPromise(context.runWithLayer({ effect, layer: TransactionalJobLayer }))

const selectAssetResolutionJob = ({ jobId }: { readonly jobId: string }) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [job] = yield* db
        .select({
          status: schema.assetResolutionJobs.status,
          attemptCount: schema.assetResolutionJobs.attemptCount,
          startedAt: schema.assetResolutionJobs.startedAt,
          heartbeatAt: schema.assetResolutionJobs.heartbeatAt,
          workerId: schema.assetResolutionJobs.workerId,
          errorMessage: schema.assetResolutionJobs.errorMessage,
        })
        .from(schema.assetResolutionJobs)
        .where(eq(schema.assetResolutionJobs.id, jobId))
        .limit(1)

      if (job === undefined) {
        return yield* Effect.die(`Missing asset resolution job ${jobId}`)
      }

      return job
    })
  )

const scheduleResolutionJob = async (suffix: string) => {
  const providerAssetRowId = await runProviderAssetRepository(
    Effect.gen(function* () {
      const repository = yield* ProviderAssetRepository
      yield* repository.upsertProviderAssets({
        providerKey: "coinbase",
        entries: [
          {
            providerAssetId: `resolution-job-${suffix}`,
            naturalKey: null,
            currencyCode: "ORB",
            name: "Orb",
            exponent: 8,
            providerType: "crypto",
            payload: { source: "test" },
          },
        ],
      })
      const result = yield* repository.findProviderAssetByProviderAssetId({
        providerKey: "coinbase",
        providerAssetId: `resolution-job-${suffix}`,
      })
      if (Option.isNone(result)) {
        return yield* Effect.die("Expected resolution job provider asset")
      }
      return result.value.id
    })
  )

  await runJobRepository(
    Effect.flatMap(AssetResolutionJobRepository, (repository) =>
      repository.scheduleUnresolvedResolutionJob({ providerAssetRowId })
    )
  )

  const [job] = await runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      return yield* db
        .select({ id: schema.assetResolutionJobs.id })
        .from(schema.assetResolutionJobs)
        .where(eq(schema.assetResolutionJobs.providerAssetRowId, providerAssetRowId))
        .limit(1)
    })
  )

  if (job === undefined) {
    throw new Error("Expected a resolution job to be scheduled")
  }

  return { providerAssetRowId, jobId: job.id }
}

const claimResolutionJobForTest = ({
  jobId,
  workerId,
  startedAt = new Date(),
  staleBefore = new Date(Date.now() - 5 * 60 * 1000),
}: {
  readonly jobId: string
  readonly workerId: string
  readonly startedAt?: Date
  readonly staleBefore?: Date
}) =>
  runJobRepository(
    Effect.flatMap(AssetResolutionJobRepository, (repository) =>
      repository.claimResolutionJob({ jobId, workerId, startedAt, staleBefore })
    )
  )

describe("AssetResolutionJobRepositoryLive", () => {
  describe("resolution job lease and retry", () => {
    beforeEach(async () => {
      await Effect.runPromise(context.recreateTestDatabase())
      const fixture = await runPg(seedSyncEngineRepositoryFixture())
      await runPg(
        seedSyncEngineAssets({
          baseBlockchainId: fixture.baseBlockchainId,
          bitcoinBlockchainId: fixture.bitcoinBlockchainId,
        })
      )
    })

    it("claims a pending job, increments the attempt count, and records the worker and start time", async () => {
      const { jobId } = await scheduleResolutionJob("claim")
      const startedAt = new Date("2025-01-02T00:00:00.000Z")

      const claimed = await claimResolutionJobForTest({ jobId, workerId: "worker-1", startedAt })

      expect(claimed).toEqual({
        _tag: "claimed",
        providerAssetRowId: expect.any(String),
        evidenceRevision: expect.any(Number),
        attemptCount: 1,
      })

      const job = await selectAssetResolutionJob({ jobId })
      expect(job.status).toBe("processing")
      expect(job.workerId).toBe("worker-1")
      expect(job.attemptCount).toBe(1)
      expect(job.startedAt?.toISOString()).toBe(startedAt.toISOString())
      expect(job.heartbeatAt?.toISOString()).toBe(startedAt.toISOString())
    })

    it("lets exactly one of two concurrently racing claims win", async () => {
      const { jobId } = await scheduleResolutionJob("concurrent")

      const [first, second] = await Promise.all([
        claimResolutionJobForTest({ jobId, workerId: "worker-1" }),
        claimResolutionJobForTest({ jobId, workerId: "worker-2" }),
      ])

      const tags = [first._tag, second._tag].sort()
      expect(tags).toEqual(["claimed", "not_claimable"])

      const job = await selectAssetResolutionJob({ jobId })
      expect(job.status).toBe("processing")
      expect(job.attemptCount).toBe(1)
      expect(["worker-1", "worker-2"]).toContain(job.workerId)
    })

    it("keeps a processing job with a fresh heartbeat un-claimable by another worker", async () => {
      const { jobId } = await scheduleResolutionJob("fresh-lease")
      await claimResolutionJobForTest({ jobId, workerId: "worker-1" })

      const secondClaim = await claimResolutionJobForTest({ jobId, workerId: "worker-2" })

      expect(secondClaim).toEqual({ _tag: "not_claimable" })
      const job = await selectAssetResolutionJob({ jobId })
      expect(job.workerId).toBe("worker-1")
    })

    it("lets another worker reclaim a job whose owner stopped heartbeating", async () => {
      const { jobId } = await scheduleResolutionJob("stale-lease")
      await claimResolutionJobForTest({ jobId, workerId: "worker-1" })

      const staleHeartbeatAt = new Date(Date.now() - 10 * 60 * 1000)
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ heartbeatAt: staleHeartbeatAt, updatedAt: staleHeartbeatAt })
            .where(eq(schema.assetResolutionJobs.id, jobId))
        })
      )

      const staleBefore = new Date(Date.now() - 5 * 60 * 1000)
      const reclaimed = await claimResolutionJobForTest({
        jobId,
        workerId: "worker-2",
        staleBefore,
      })

      expect(reclaimed).toMatchObject({ _tag: "claimed", attemptCount: 2 })
      const job = await selectAssetResolutionJob({ jobId })
      expect(job.status).toBe("processing")
      expect(job.workerId).toBe("worker-2")
    })

    it("releases a job for retry with a delay that grows with the attempt count", async () => {
      const { jobId } = await scheduleResolutionJob("retry")
      await claimResolutionJobForTest({ jobId, workerId: "worker-1" })

      const firstRelease = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.releaseResolutionJobAfterFailure({
            jobId,
            workerId: "worker-1",
            message: "CoinGecko timeout",
          })
        )
      )

      if (firstRelease._tag !== "retry_scheduled") {
        return expect.fail("Expected the first failure to schedule a retry")
      }

      const jobAfterFirstFailure = await selectAssetResolutionJob({ jobId })
      expect(jobAfterFirstFailure.status).toBe("pending")
      expect(jobAfterFirstFailure.attemptCount).toBe(1)
      expect(jobAfterFirstFailure.errorMessage).toBe("CoinGecko timeout")
      expect(jobAfterFirstFailure.workerId).toBeNull()
      expect(firstRelease.nextRetryAt.getTime()).toBeGreaterThan(Date.now())

      const tooEarlyClaim = await claimResolutionJobForTest({ jobId, workerId: "worker-2" })
      expect(tooEarlyClaim).toEqual({ _tag: "not_claimable" })

      const firstDelayMs = firstRelease.nextRetryAt.getTime() - Date.now()

      const reclaimed = await claimResolutionJobForTest({
        jobId,
        workerId: "worker-2",
        startedAt: firstRelease.nextRetryAt,
        staleBefore: new Date(firstRelease.nextRetryAt.getTime() - 5 * 60 * 1000),
      })
      expect(reclaimed).toMatchObject({ _tag: "claimed", attemptCount: 2 })

      const secondRelease = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.releaseResolutionJobAfterFailure({
            jobId,
            workerId: "worker-2",
            message: "CoinGecko timeout again",
          })
        )
      )

      if (secondRelease._tag !== "retry_scheduled") {
        return expect.fail("Expected the second failure to schedule a retry")
      }

      const secondDelayMs = secondRelease.nextRetryAt.getTime() - Date.now()
      expect(secondDelayMs).toBeGreaterThan(firstDelayMs)
    })

    it("fails a job once its attempt limit is reached and never hands it out again", async () => {
      const { jobId } = await scheduleResolutionJob("exhausted")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ maxAttempts: 1 })
            .where(eq(schema.assetResolutionJobs.id, jobId))
        })
      )
      await claimResolutionJobForTest({ jobId, workerId: "worker-1" })

      const release = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.releaseResolutionJobAfterFailure({
            jobId,
            workerId: "worker-1",
            message: "Permanent failure",
          })
        )
      )

      expect(release).toEqual({ _tag: "attempts_exhausted", attemptCount: 1 })

      const job = await selectAssetResolutionJob({ jobId })
      expect(job.status).toBe("failed")
      expect(job.errorMessage).toBe("Permanent failure")
      expect(job.workerId).toBeNull()

      const claimAfterExhaustion = await claimResolutionJobForTest({
        jobId,
        workerId: "worker-2",
        staleBefore: new Date(0),
      })
      expect(claimAfterExhaustion).toEqual({ _tag: "not_claimable" })
    })

    it("heartbeats a processing job only when the worker id matches", async () => {
      const { jobId } = await scheduleResolutionJob("heartbeat")
      await claimResolutionJobForTest({ jobId, workerId: "worker-1" })

      const rejected = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.heartbeatResolutionJob({
            jobId,
            workerId: "worker-2",
            heartbeatAt: new Date(),
          })
        )
      )
      expect(rejected).toBe("not_owned")

      const heartbeatAt = new Date("2025-01-02T00:05:00.000Z")
      const accepted = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.heartbeatResolutionJob({ jobId, workerId: "worker-1", heartbeatAt })
        )
      )
      expect(accepted).toBe("heartbeated")

      const job = await selectAssetResolutionJob({ jobId })
      expect(job.heartbeatAt?.toISOString()).toBe(heartbeatAt.toISOString())
    })

    it("lists only runnable pending jobs and stale processing jobs as dispatchable", async () => {
      const runnable = await scheduleResolutionJob("dispatch-runnable")
      const delayed = await scheduleResolutionJob("dispatch-delayed")
      const freshProcessing = await scheduleResolutionJob("dispatch-fresh-processing")
      const staleProcessing = await scheduleResolutionJob("dispatch-stale-processing")
      const completed = await scheduleResolutionJob("dispatch-completed")

      const now = new Date()
      const staleHeartbeatAt = new Date(now.getTime() - 10 * 60 * 1000)
      await claimResolutionJobForTest({ jobId: freshProcessing.jobId, workerId: "worker-1" })
      await claimResolutionJobForTest({ jobId: staleProcessing.jobId, workerId: "worker-1" })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ nextRetryAt: new Date(now.getTime() + 60 * 60 * 1000) })
            .where(eq(schema.assetResolutionJobs.id, delayed.jobId))
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ heartbeatAt: staleHeartbeatAt, updatedAt: staleHeartbeatAt })
            .where(eq(schema.assetResolutionJobs.id, staleProcessing.jobId))
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ status: "completed" })
            .where(eq(schema.assetResolutionJobs.id, completed.jobId))
        })
      )

      const dispatchable = await runJobRepository(
        Effect.flatMap(AssetResolutionJobRepository, (repository) =>
          repository.listDispatchableResolutionJobs({
            now,
            staleBefore: new Date(now.getTime() - 5 * 60 * 1000),
            limit: 10,
          })
        )
      )

      const jobIds = dispatchable.map((job) => job.jobId)
      expect(jobIds).toContain(runnable.jobId)
      expect(jobIds).toContain(staleProcessing.jobId)
      expect(jobIds).not.toContain(delayed.jobId)
      expect(jobIds).not.toContain(freshProcessing.jobId)
      expect(jobIds).not.toContain(completed.jobId)
    })
  })

  describe("resolution job scheduling paths", () => {
    beforeEach(async () => {
      await Effect.runPromise(context.recreateTestDatabase())
      const fixture = await runPg(seedSyncEngineRepositoryFixture())
      await runPg(
        seedSyncEngineAssets({
          baseBlockchainId: fixture.baseBlockchainId,
          bitcoinBlockchainId: fixture.bitcoinBlockchainId,
        })
      )
    })

    const upsertCatalogAsset = ({
      providerAssetId,
      payload = { source: "test" },
    }: {
      readonly providerAssetId: string
      readonly payload?: unknown
    }) =>
      runProviderAssetRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId,
                naturalKey: null,
                currencyCode: "ORB",
                name: "Orb",
                exponent: 8,
                providerType: "crypto",
                payload,
              },
            ],
          })
          const found = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId,
          })
          if (Option.isNone(found)) {
            return yield* Effect.die("Expected upserted provider asset")
          }
          return found.value.id
        })
      )

    const selectJobsFor = (providerAssetRowId: string) =>
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              status: schema.assetResolutionJobs.status,
              evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
            })
            .from(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.providerAssetRowId, providerAssetRowId))
        })
      )

    it("does not schedule research for a never-observed catalog asset", async () => {
      // A mapping row appears once an asset is observed in a transaction, so
      // a bare catalog entry has never been seen and must not burn research.
      const providerAssetRowId = await upsertCatalogAsset({
        providerAssetId: "schedule-new-catalog-asset",
      })

      const jobs = await selectJobsFor(providerAssetRowId)
      expect(jobs).toEqual([])
    })

    it("schedules a new job when catalog evidence changes for an observed unresolved asset", async () => {
      const providerAssetRowId = await upsertCatalogAsset({
        providerAssetId: "schedule-observed-unresolved",
      })
      await runProviderAssetRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: null,
              },
            ],
          })
        )
      )

      await upsertCatalogAsset({
        providerAssetId: "schedule-observed-unresolved",
        payload: { source: "test", refreshed: true },
      })

      const jobs = await selectJobsFor(providerAssetRowId)
      expect(jobs).toContainEqual({ status: "pending", evidenceRevision: 2 })
    })

    it("schedules an approved mapping that has no current policy evaluation", async () => {
      const providerAssetRowId = await upsertCatalogAsset({
        providerAssetId: "schedule-approved-asset",
      })

      await runProviderAssetRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: null,
              },
            ],
          })
        )
      )

      // A mapping projection without a revision-bound conclusion is not a
      // complete settled state, so changed evidence must schedule evaluation.
      await upsertCatalogAsset({
        providerAssetId: "schedule-approved-asset",
        payload: { source: "test", refreshed: true },
      })

      const jobs = await selectJobsFor(providerAssetRowId)
      expect(jobs).toContainEqual({ status: "pending", evidenceRevision: 2 })
    })

    it("keeps a scheduled job when the transaction around scheduling rolls back", async () => {
      const providerAssetRowId = await upsertCatalogAsset({
        providerAssetId: "schedule-rollback-survivor",
      })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .delete(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.providerAssetRowId, providerAssetRowId))
        })
      )

      const result = await runTransactionalJob(
        Effect.result(
          Effect.gen(function* () {
            const repository = yield* AssetResolutionJobRepository
            const syncEngineTransaction = yield* SyncEngineTransaction

            return yield* syncEngineTransaction.run(
              Effect.gen(function* () {
                yield* repository.scheduleUnresolvedResolutionJob({ providerAssetRowId })
                return yield* new SyncEngineStorageError({
                  operation: "test.mappingNotApproved",
                  cause: "The mapping is still pending review.",
                })
              })
            )
          })
        )
      )
      expect(result._tag).toBe("Failure")

      const jobs = await selectJobsFor(providerAssetRowId)
      expect(jobs).toEqual([{ status: "pending", evidenceRevision: 1 }])
    })
  })
})
