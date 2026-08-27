import { eq, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetResolutionJobRepositoryLive } from "../../src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../src/layers/SyncEngineTransactionLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  AssetResolutionJobRepository,
  type AssetResolutionHumanConclusionRecord,
  ProviderAssetRepository,
  type ProviderAssetRecord,
  SourceNormalizationRepository,
  SyncEngineStorageError,
  SyncEngineTransaction,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_asset_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

const runJobRepository = <A, E>(effect: Effect.Effect<A, E, AssetResolutionJobRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetResolutionJobRepositoryLive }))

const AtomicNormalizationLayer = Layer.mergeAll(
  ProviderAssetRepositoryLive,
  SourceNormalizationRepositoryLive,
  SyncEngineTransactionLive
)

const runAtomicNormalization = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ProviderAssetRepository | SourceNormalizationRepository | SyncEngineTransaction
  >
) => Effect.runPromise(context.runWithLayer({ effect, layer: AtomicNormalizationLayer }))

const loadBitcoinObservation = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [representation] = yield* db
        .select({
          observedBlockchainId: schema.assetRepresentations.blockchainId,
          representationType: schema.assetRepresentations.type,
          contractAddress: schema.assetRepresentations.contractAddress,
          mintAddress: schema.assetRepresentations.mintAddress,
          decimals: schema.assetRepresentations.decimals,
        })
        .from(schema.assetRepresentations)
        .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
        .limit(1)
      if (representation === undefined) {
        return yield* Effect.die("Missing Bitcoin representation fixture")
      }
      return representation
    })
  )

const seedPendingApprovalAsset = async (
  suffix: string,
  { withProviderTransfer = true }: { readonly withProviderTransfer?: boolean } = {}
) => {
  const providerAsset = await runRepository(
    Effect.gen(function* () {
      const repository = yield* ProviderAssetRepository
      yield* repository.upsertProviderAssets({
        providerKey: "coinbase",
        entries: [
          {
            providerAssetId: `btc-approval-${suffix}`,
            naturalKey: null,
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            payload: { source: "test" },
          },
        ],
      })
      const result = yield* repository.findProviderAssetByProviderAssetId({
        providerKey: "coinbase",
        providerAssetId: `btc-approval-${suffix}`,
      })
      if (Option.isNone(result)) {
        return yield* Effect.die("Expected approval provider asset")
      }
      yield* repository.upsertProviderAssetMappings({
        mappings: [
          {
            providerAssetRowId: result.value.id,
            mappingKind: "asset",
            canonicalAssetId: null,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "pending_review",
            reviewerNotes: null,
            sourceNotes: "Pending transfer evidence",
          },
        ],
      })
      return result.value
    })
  )

  if (!withProviderTransfer) {
    return providerAsset
  }

  await runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const timestamp = new Date("2025-04-20T13:00:00.000Z")
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: TEST_SOURCE_ID,
          externalId: `approval-${suffix}-transaction`,
          timestamp,
          providerTransactionType: "send",
          providerStatus: "completed",
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.die("Expected approval replay transaction")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId: TEST_SOURCE_ID,
        transactionId: transaction.id,
        externalId: `approval-${suffix}-transfer`,
        providerAssetId: providerAsset.id,
        timestamp,
        direction: "outbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAddress: "bc1qapprovalreplay000000000000000000000000",
        amount: "0.25",
        metadata: { role: "principal" },
      })
    })
  )

  return providerAsset
}

const makeExcludedDecision = (providerAssetRowId: string) => ({
  providerAssetRowId,
  evidenceRevision: 1,
  policyRevision: "automatic-exclusion.1",
  outcome: "excluded" as const,
  assetId: null,
  assetRepresentationId: null,
  blockchain: null,
  representationType: null,
  contractAddress: null,
  mintAddress: null,
  decimals: null,
  reason: "explicit_banned_verdict",
  evidence: [],
  actor: "system:asset-resolution-policy",
})

const makeApprovalConclusion = ({
  providerAsset,
  assetRepresentationId,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly assetRepresentationId: string | null
}): AssetResolutionHumanConclusionRecord => ({
  providerAssetRowId: providerAsset.id,
  evidenceRevision: providerAsset.evidenceRevision,
  policyRevision: "test.manual-approval.1",
  claim: {
    _tag: "identity",
    assetId: TEST_BTC_ASSET_ID,
    newAsset: null,
    representation:
      assetRepresentationId === null
        ? null
        : {
            blockchain: "bitcoin",
            type: "token",
            contractAddress: "sync-engine-btc-fixture",
            mintAddress: null,
            decimals: 8,
          },
  },
  assetId: TEST_BTC_ASSET_ID,
  assetRepresentationId,
  rationale: "Approved by the repository integration test.",
  evidence: [],
  actor: "admin:repository-integration-test",
})

const scheduleResolutionJob = async (suffix: string) => {
  const providerAssetRowId = await runRepository(
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

describe("ProviderAssetRepositoryLive", () => {
  describe("current schema", () => {
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

    it("upserts provider assets by stable provider asset id and resolves mappings", async () => {
      const firstUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "btc",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset" },
              },
            ],
          })
        )
      )

      const secondUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin Updated",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset", revision: 2 },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-provider-asset",
          })
        )
      )

      expect(Option.isSome(providerAsset)).toBe(true)

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const providerAssetRecord = providerAsset.value

      const mappingUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAssetRecord.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Reviewed",
                sourceNotes: "Seeded in integration test",
              },
            ],
          })
        )
      )

      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({
            providerAssetRowId: providerAssetRecord.id,
          })
        )
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(firstUpsertCount).toBe(1)
      expect(secondUpsertCount).toBe(1)
      expect(mappingUpsertCount).toBe(1)
      expect(providerAssetRecord).toMatchObject({
        provider: "coinbase",
        providerAssetId: "btc-provider-asset",
        naturalKey: null,
        currencyCode: "BTC",
        name: "Bitcoin Updated",
        exponent: 8,
        providerType: "crypto",
      })
      expect(Option.getOrNull(mapping)).toMatchObject({
        providerAssetRowId: providerAssetRecord.id,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        mappingStatus: "approved",
      })
      expect(providerAssetRows).toHaveLength(1)
    })

    it("bumps evidence revision only when stored observation facts change", async () => {
      const upsertBtc = ({ name, payload }: { readonly name: string; readonly payload: unknown }) =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssets({
              providerKey: "coinbase",
              entries: [
                {
                  providerAssetId: "btc-provider-asset",
                  naturalKey: null,
                  currencyCode: "BTC",
                  name,
                  exponent: 8,
                  providerType: "crypto",
                  payload,
                },
              ],
            })
          )
        )

      await upsertBtc({
        name: "Bitcoin",
        payload: { code: "BTC", asset_id: "btc-provider-asset" },
      })
      const policyEvaluationId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.providerAssetId, "btc-provider-asset"))
          if (providerAsset === undefined) {
            return yield* Effect.die("Expected provider asset for policy pointer fixture")
          }
          const [policyEvaluation] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: providerAsset.id,
              evidenceRevision: 1,
              policyRevision: "test-policy.unchanged-upsert.1",
              outcome: "pending",
              reason: "display_collision",
              actor: "policy:test-policy.unchanged-upsert.1",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (policyEvaluation === undefined) {
            return yield* Effect.die("Expected policy evaluation fixture")
          }
          yield* db.insert(schema.assetResolutionCurrentState).values({
            providerAssetRowId: providerAsset.id,
            currentConclusionId: null,
            currentPolicyEvaluationId: policyEvaluation.id,
          })
          return policyEvaluation.id
        })
      )
      await upsertBtc({
        name: "Bitcoin",
        payload: { code: "BTC", asset_id: "btc-provider-asset" },
      })

      const afterUnchanged = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [row] = yield* db
            .select({
              evidenceRevision: schema.providerAssets.evidenceRevision,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.providerAssets)
            .leftJoin(
              schema.assetResolutionCurrentState,
              eq(schema.assetResolutionCurrentState.providerAssetRowId, schema.providerAssets.id)
            )
            .where(eq(schema.providerAssets.providerAssetId, "btc-provider-asset"))
            .limit(1)
          return row ?? null
        })
      )

      await upsertBtc({
        name: "Bitcoin",
        payload: { code: "BTC", asset_id: "btc-provider-asset", exponent: 8 },
      })

      const afterChanged = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [row] = yield* db
            .select({ evidenceRevision: schema.providerAssets.evidenceRevision })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.providerAssetId, "btc-provider-asset"))
            .limit(1)
          return row ?? null
        })
      )

      expect(afterUnchanged).toEqual({
        evidenceRevision: 1,
        currentPolicyEvaluationId: policyEvaluationId,
      })
      expect(afterChanged).toEqual({ evidenceRevision: 2 })
    })

    it("does not downgrade a settled mapping when a late pending write arrives", async () => {
      const providerAsset = await seedPendingApprovalAsset("late-pending", {
        withProviderTransfer: false,
      })
      const writeMapping = (mappingStatus: "approved" | "pending_review") =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssetMappings({
              mappings: [
                {
                  providerAssetRowId: providerAsset.id,
                  mappingKind: "asset",
                  canonicalAssetId: mappingStatus === "approved" ? TEST_BTC_ASSET_ID : null,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: null,
                  mappingStatus,
                  reviewerNotes: mappingStatus === "approved" ? "Accepted" : null,
                  sourceNotes: "Concurrent missing-mapping path",
                },
              ],
            })
          )
        )

      await writeMapping("approved")
      await writeMapping("pending_review")

      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.id })
        )
      )

      expect(Option.getOrNull(mapping)).toMatchObject({
        mappingStatus: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
      })
    })

    it("locks provider rows before racing trusted seeds with manual mapping writes", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "trusted-seed-manual-race",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "lock-order-test" },
              },
            ],
          })
          const found = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "trusted-seed-manual-race",
          })
          if (Option.isNone(found)) {
            return yield* Effect.die("Expected seed/manual race provider asset")
          }
          return found.value
        })
      )
      const providerLocked = await Effect.runPromise(Deferred.make<void>())
      const releaseManualMapping = await Effect.runPromise(Deferred.make<void>())
      const manualMapping = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.providerAssets.id })
                .from(schema.providerAssets)
                .where(eq(schema.providerAssets.id, providerAsset.id))
                .for("no key update")
              yield* Deferred.succeed(providerLocked, undefined)
              yield* Deferred.await(releaseManualMapping)
              yield* tx.insert(schema.providerAssetMappings).values({
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                mappingStatus: "approved",
                reviewerNotes: "Manual mapping won the race.",
                sourceNotes: "Manual lock-order regression.",
              })
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(providerLocked))
      const trustedSeed = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.seedProviderAssetMappingsIfMissing({
            mappings: [
              {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Trusted seed racing manual review.",
              },
            ],
          })
        )
      )

      await context.waitForQueryBlockedOnLock({ queryIncludes: "provider_assets" })
      await Effect.runPromise(Deferred.succeed(releaseManualMapping, undefined))
      await manualMapping
      expect(await trustedSeed).toBe(0)

      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.id })
        )
      )
      expect(Option.getOrNull(mapping)).toMatchObject({
        mappingStatus: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
      })
    })

    it("reevaluates later evidence without replacing a trusted mapping conclusion", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "trusted-reevaluation",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { version: 1 },
              },
            ],
          })
          const found = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "trusted-reevaluation",
          })
          if (Option.isNone(found)) {
            return yield* Effect.die("Expected trusted provider asset")
          }
          yield* repository.seedProviderAssetMappingsIfMissing({
            mappings: [
              {
                providerAssetRowId: found.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Trusted reference mapping",
              },
            ],
          })
          return found.value
        })
      )
      const [before] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "trusted-reevaluation",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { version: 2 },
              },
            ],
          })
        )
      )

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({ evidenceRevision: schema.assetResolutionJobs.evidenceRevision })
            .from(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.providerAssetRowId, providerAsset.id))
          const [current] = yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
          const evidence = yield* db
            .select({
              authority: schema.assetResolutionEvidence.authority,
              claimKind: schema.assetResolutionEvidence.claimKind,
              evidenceRevision: schema.assetResolutionEvidence.evidenceRevision,
            })
            .from(schema.assetResolutionEvidence)
            .where(
              eq(
                schema.assetResolutionEvidence.decisionId,
                current?.currentConclusionId ?? "00000000-0000-0000-0000-000000000000"
              )
            )
          return { jobs, current, evidence }
        })
      )

      expect(before?.currentConclusionId).not.toBeNull()
      expect(before?.currentPolicyEvaluationId).toBe(before?.currentConclusionId)
      expect(state.jobs).toEqual([{ evidenceRevision: 2 }])
      expect(state.current).toEqual({
        currentConclusionId: before?.currentConclusionId,
        currentPolicyEvaluationId: null,
      })
      expect(state.evidence).toEqual([
        {
          authority: "trusted_provider_mapping",
          claimKind: "mapping_conclusion",
          evidenceRevision: 1,
        },
      ])
    })

    it("approves once and attaches replay to an active job under concurrent retries", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-approval-replay",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "test" },
              },
            ],
          })
          const result = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-approval-replay",
          })
          if (Option.isNone(result)) {
            return yield* Effect.die("Expected approval provider asset")
          }

          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: result.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending transfer evidence",
              },
            ],
          })

          return result.value
        })
      )

      const pendingPolicyEvaluationId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const timestamp = new Date("2025-04-20T12:00:00.000Z")
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "approval-replay-transaction",
              timestamp,
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.die("Expected approval replay transaction")
          }

          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "approval-replay-transfer",
            providerAssetId: providerAsset.id,
            timestamp,
            direction: "outbound",
            processingMode: "accounting_and_evidence",
            fromAccountRef: "coinbase-account-1",
            toAddress: "bc1qapprovalreplay000000000000000000000000",
            amount: "0.25",
            metadata: { role: "principal" },
          })
          yield* db.insert(schema.processingJobs).values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "pending",
            attemptCount: 0,
            maxAttempts: 3,
            progressDetails: { mode: "sync" },
          })

          const [pendingPolicyEvaluation] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: providerAsset.id,
              evidenceRevision: 1,
              policyRevision: "test-policy.pending-approval",
              outcome: "pending",
              reason: "missing_existing_economic_asset",
              actor: "system:asset-resolution-policy",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (pendingPolicyEvaluation === undefined) {
            return yield* Effect.die("Expected pending approval policy evaluation")
          }
          yield* db.insert(schema.assetResolutionCurrentState).values({
            providerAssetRowId: providerAsset.id,
            currentConclusionId: null,
            currentPolicyEvaluationId: pendingPolicyEvaluation.id,
          })
          return pendingPolicyEvaluation.id
        })
      )

      const approve = () =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved",
                sourceNotes: "Approved from transfer evidence",
              },
              conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )

      const results = await Promise.all([approve(), approve()])
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({
              status: schema.providerAssetMappings.mappingStatus,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const jobs = yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const rematerializations = yield* db
            .select({
              decisionId: schema.assetDecisionRematerializations.decisionId,
              status: schema.assetDecisionRematerializations.status,
            })
            .from(schema.assetDecisionRematerializations)
            .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))

          return { jobs, mapping, rematerializations }
        })
      )

      expect(
        results
          .map(({ mappingChanged }) => mappingChanged)
          .sort((left, right) => Number(left) - Number(right))
      ).toEqual([false, true])
      expect(state.mapping).toEqual({
        status: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
      })
      expect(state.jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
      expect(state.rematerializations).toHaveLength(1)
      expect(state.rematerializations[0]?.status).toBe("pending")
      expect(state.rematerializations[0]?.decisionId).not.toBe(pendingPolicyEvaluationId)
    })

    it("rejects approval when no current conclusion owns the target", async () => {
      const providerAsset = await seedPendingApprovalAsset("no-active-owner")

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const currentState = yield* db
            .select({ providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
          return { currentState, jobs, mapping }
        })
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          operation:
            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.currentConclusion",
        },
      })
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.currentState).toEqual([])
      expect(state.jobs).toEqual([])
    })

    it("rejects inconsistent human conclusions without writing approval state", async () => {
      const providerAsset = await seedPendingApprovalAsset("invalid-human-conclusion")
      const validConclusion = makeApprovalConclusion({
        providerAsset,
        assetRepresentationId: null,
      })
      const invalidConclusions: ReadonlyArray<AssetResolutionHumanConclusionRecord> = [
        {
          ...validConclusion,
          claim: {
            ...validConclusion.claim,
            assetId: "00000000-0000-4000-8000-000000000299",
          },
        },
        {
          ...validConclusion,
          claim: {
            ...validConclusion.claim,
            representation: {
              blockchain: "bitcoin",
              type: "token",
              contractAddress: "different-representation",
              mintAddress: null,
              decimals: 8,
            },
          },
        },
        { ...validConclusion, evidenceRevision: providerAsset.evidenceRevision + 1 },
      ]

      const results = await Promise.all(
        invalidConclusions.map((conclusion) =>
          runRepository(
            Effect.flatMap(ProviderAssetRepository, (repository) =>
              repository.approveProviderAssetMappingAndRequestReplay({
                mapping: {
                  providerAssetRowId: providerAsset.id,
                  mappingKind: "asset",
                  canonicalAssetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: null,
                  mappingStatus: "approved",
                  reviewerNotes: "Approved",
                  sourceNotes: "Approved from transfer evidence",
                },
                conclusion,
                expectedObservedRepresentations: [],
                expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
              })
            ).pipe(Effect.result)
          )
        )
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
          const currentState = yield* db
            .select({ id: schema.assetResolutionCurrentState.providerAssetRowId })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
          const jobs = yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          return { currentState, decisions, jobs, mapping }
        })
      )

      expect(results).toHaveLength(3)
      expect(
        results.every(
          (result) =>
            result._tag === "Failure" &&
            result.failure.operation ===
              "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.conclusion"
        )
      ).toBe(true)
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.decisions).toEqual([])
      expect(state.currentState).toEqual([])
      expect(state.jobs).toEqual([])
    })

    it("rejects approval when the current conclusion owns a different target", async () => {
      const providerAsset = await seedPendingApprovalAsset("different-active-owner")
      const currentConclusionId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [currentConclusion] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: providerAsset.id,
              evidenceRevision: providerAsset.evidenceRevision,
              policyRevision: "test.different-current-conclusion.1",
              outcome: "identity",
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              humanClaim: {
                _tag: "identity",
                assetId: TEST_BTC_ASSET_ID,
                representation: { assetRepresentationId: TEST_BTC_REPRESENTATION_ID },
              },
              rationale: "Seed a conclusion for a different approved target.",
              actor: "admin:repository-integration-test",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (currentConclusion === undefined) {
            return yield* Effect.die("Expected current conclusion fixture")
          }
          yield* db.insert(schema.assetResolutionCurrentState).values({
            providerAssetRowId: providerAsset.id,
            currentConclusionId: currentConclusion.id,
            currentPolicyEvaluationId: null,
          })
          return currentConclusion.id
        })
      )

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const [currentState] = yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
          const rematerializations = yield* db
            .select({ id: schema.assetDecisionRematerializations.decisionId })
            .from(schema.assetDecisionRematerializations)
            .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
          const jobs = yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          return { currentState, decisions, jobs, mapping, rematerializations }
        })
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          operation:
            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.currentConclusion",
        },
      })
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.currentState).toEqual({
        currentConclusionId,
        currentPolicyEvaluationId: null,
      })
      expect(state.decisions).toEqual([{ id: currentConclusionId }])
      expect(state.rematerializations).toEqual([])
      expect(state.jobs).toEqual([])
    })

    it("rejects chainless approval when the current conclusion owns a different asset", async () => {
      const providerAsset = await seedPendingApprovalAsset("different-chainless-asset")
      const currentConclusionId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [otherAsset] = yield* db
            .insert(schema.assets)
            .values({ name: "Different Chainless Asset", symbol: "DCA", type: "fungible" })
            .returning({ id: schema.assets.id })
          if (otherAsset === undefined) {
            return yield* Effect.die("Expected alternate asset fixture")
          }
          const [currentConclusion] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: providerAsset.id,
              evidenceRevision: providerAsset.evidenceRevision,
              policyRevision: "test.different-chainless-asset.1",
              outcome: "identity",
              assetId: otherAsset.id,
              assetRepresentationId: null,
              humanClaim: {
                _tag: "identity",
                assetId: otherAsset.id,
                newAsset: null,
                representation: null,
              },
              rationale: "Seed a conclusion for another chainless asset.",
              actor: "admin:repository-integration-test",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (currentConclusion === undefined) {
            return yield* Effect.die("Expected chainless conclusion fixture")
          }
          yield* db.insert(schema.assetResolutionCurrentState).values({
            providerAssetRowId: providerAsset.id,
            currentConclusionId: currentConclusion.id,
            currentPolicyEvaluationId: null,
          })
          return currentConclusion.id
        })
      )

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
          const jobs = yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          return { decisions, jobs, mapping }
        })
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          operation:
            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.currentConclusion",
        },
      })
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.decisions).toEqual([{ id: currentConclusionId }])
      expect(state.jobs).toEqual([])
    })

    it("replays provider sources even when the asset has no provider-transfer row", async () => {
      const providerAsset = await seedPendingApprovalAsset("non-transfer-use", {
        withProviderTransfer: false,
      })
      const secondSourceId = "00000000-0000-4000-8000-000000000282"
      const otherProviderSourceId = "00000000-0000-4000-8000-000000000285"
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* seedSyncEngineRepositoryFixture({
            userId: "00000000-0000-4000-8000-000000000283",
            principalId: "00000000-0000-4000-8000-000000000284",
            sourceId: secondSourceId,
          })
          yield* seedSyncEngineRepositoryFixture({
            userId: "00000000-0000-4000-8000-000000000286",
            principalId: "00000000-0000-4000-8000-000000000287",
            sourceId: otherProviderSourceId,
          })
          yield* db
            .update(schema.sources)
            .set({ providerKey: "helius-solana" })
            .where(eq(schema.sources.id, otherProviderSourceId))
          yield* db.insert(schema.processingJobs).values({
            sourceId: secondSourceId,
            principalId: "00000000-0000-4000-8000-000000000284",
            mode: "sync",
            status: "pending",
            attemptCount: 0,
            maxAttempts: 3,
            progressDetails: { mode: "sync" },
          })
        })
      )
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          Effect.all([
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [],
            }),
            repository.recordProviderAssetSourceUses({
              sourceId: secondSourceId,
              providerAssetRowIds: [providerAsset.id],
              observations: [],
            }),
          ])
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved for a non-transfer transaction",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              followUpMode: schema.processingJobs.followUpMode,
              mode: schema.processingJobs.mode,
              sourceId: schema.processingJobs.sourceId,
              status: schema.processingJobs.status,
            })
            .from(schema.processingJobs)
            .orderBy(schema.processingJobs.sourceId)
        })
      )

      expect(jobs).toEqual([
        {
          followUpMode: null,
          mode: "replay",
          sourceId: TEST_SOURCE_ID,
          status: "pending",
        },
        {
          followUpMode: "replay",
          mode: "sync",
          sourceId: secondSourceId,
          status: "pending",
        },
      ])
    })

    it("backfills an unresolved asset from an appended provider-asset review segment", async () => {
      const providerAsset = await seedPendingApprovalAsset("legacy-appended-review", {
        withProviderTransfer: false,
      })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "legacy-appended-provider-asset-review",
              timestamp: new Date("2025-04-20T13:00:00.000Z"),
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.die("Expected legacy review transaction")
          }
          yield* db.insert(schema.transactionReviews).values({
            transactionId: transaction.id,
            principalId: TEST_PRINCIPAL_ID,
            reviewStatus: "needs_review",
            categorizationReason:
              "Coinbase send requires review. provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for BTC.",
            matchedLayer: "provider_asset_mapping",
            needsReview: true,
          })
          yield* db.execute(sql`
            insert into provider_asset_source_uses (provider_asset_row_id, source_id)
            select distinct provider_assets.id, transactions.source_id
            from provider_assets
            inner join provider_asset_mappings
              on provider_asset_mappings.provider_asset_row_id = provider_assets.id
            inner join sources on sources.provider_key = 'coinbase'
            inner join transactions on transactions.source_id = sources.id
            inner join transaction_reviews
              on transaction_reviews.transaction_id = transactions.id
            where provider_assets.provider = 'coinbase'
              and provider_asset_mappings.mapping_status = 'pending_review'
              and transaction_reviews.categorization_reason like '%provider_asset_mapping:%'
              and upper(provider_assets.currency_code) = any(
                string_to_array(
                  upper(trim(trailing '.' from split_part(
                    split_part(transaction_reviews.categorization_reason, 'provider_asset_mapping:', 2),
                    ' for ',
                    2
                  ))),
                  ', '
                )
              )
            on conflict do nothing
          `)
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved legacy reviewed asset",
              sourceNotes: "Approved legacy reviewed asset",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(jobs).toEqual([{ mode: "replay", status: "pending" }])
    })

    it("tracks policy-backed replay when a source use is recorded after approval", async () => {
      const providerAsset = await seedPendingApprovalAsset("approval-before-source-use", {
        withProviderTransfer: false,
      })
      const pendingPolicyEvaluationId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [evaluation] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: providerAsset.id,
              evidenceRevision: 1,
              policyRevision: "test-policy.approval-before-source-use",
              outcome: "pending",
              reason: "missing_existing_economic_asset",
              actor: "system:asset-resolution-policy",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (evaluation === undefined) {
            return yield* Effect.die("Expected pending policy evaluation")
          }
          yield* db.insert(schema.assetResolutionCurrentState).values({
            providerAssetRowId: providerAsset.id,
            currentConclusionId: null,
            currentPolicyEvaluationId: evaluation.id,
          })
          return evaluation.id
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved before source use was recorded",
              sourceNotes: "Approved before source use was recorded",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const recordedAgain = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const rematerializations = yield* db
            .select({
              decisionId: schema.assetDecisionRematerializations.decisionId,
              processingJobId: schema.assetDecisionRematerializations.processingJobId,
              status: schema.assetDecisionRematerializations.status,
            })
            .from(schema.assetDecisionRematerializations)
            .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
          return { jobs, rematerializations }
        })
      )

      expect(recorded).toBe(1)
      expect(recordedAgain).toBe(0)
      expect(state.jobs).toHaveLength(1)
      expect(state.jobs[0]?.mode).toBe("replay")
      expect(state.rematerializations).toHaveLength(1)
      expect(state.rematerializations[0]).toMatchObject({
        processingJobId: state.jobs[0]?.id,
        status: "pending",
      })
      expect(state.rematerializations[0]?.decisionId).not.toBe(pendingPolicyEvaluationId)
    })

    it("requests replay when a source use is recorded after exclusion", async () => {
      const providerAsset = await seedPendingApprovalAsset("exclusion-before-source-use", {
        withProviderTransfer: false,
      })

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Excluded before source use was recorded",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const recordedAgain = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const replayJobs = yield* db
            .select({
              id: schema.processingJobs.id,
              followUpMode: schema.processingJobs.followUpMode,
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const rematerializations = yield* db
            .select({
              decisionOutcome: schema.assetResolutionDecisions.outcome,
              processingJobId: schema.assetDecisionRematerializations.processingJobId,
              sourceId: schema.assetDecisionRematerializations.sourceId,
            })
            .from(schema.assetDecisionRematerializations)
            .innerJoin(
              schema.assetResolutionDecisions,
              eq(
                schema.assetResolutionDecisions.id,
                schema.assetDecisionRematerializations.decisionId
              )
            )
          return { rematerializations, replayJobs }
        })
      )

      expect(recorded).toBe(1)
      expect(recordedAgain).toBe(0)
      expect(jobs.replayJobs).toHaveLength(1)
      expect(jobs.replayJobs[0]).toMatchObject({
        followUpMode: null,
        mode: "replay",
        status: "pending",
      })
      expect(jobs.rematerializations).toEqual([
        {
          decisionOutcome: "excluded",
          processingJobId: jobs.replayJobs[0]?.id,
          sourceId: TEST_SOURCE_ID,
        },
      ])
    })

    it("tracks automatic exclusion replay work against the active decision", async () => {
      const providerAsset = await seedPendingApprovalAsset("tracked-automatic-exclusion")

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Automatic exclusion with tracked replay",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const work = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              decisionOutcome: schema.assetResolutionDecisions.outcome,
              sourceId: schema.assetDecisionRematerializations.sourceId,
              jobStatus: schema.processingJobs.status,
            })
            .from(schema.assetDecisionRematerializations)
            .innerJoin(
              schema.assetResolutionDecisions,
              eq(
                schema.assetResolutionDecisions.id,
                schema.assetDecisionRematerializations.decisionId
              )
            )
            .innerJoin(
              schema.processingJobs,
              eq(schema.processingJobs.id, schema.assetDecisionRematerializations.processingJobId)
            )
        })
      )

      expect(work).toEqual([
        {
          decisionOutcome: "excluded",
          sourceId: TEST_SOURCE_ID,
          jobStatus: "pending",
        },
      ])
    })

    it("rolls back the exclusion decision when the mapping transition fails", async () => {
      const providerAsset = await seedPendingApprovalAsset("atomic-exclusion-rollback", {
        withProviderTransfer: false,
      })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function reject_excluded_mapping_update() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mapping_status = 'excluded' then
                raise exception 'injected exclusion mapping failure';
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger reject_excluded_mapping_update_before_update
            before update on provider_asset_mappings
            for each row execute function reject_excluded_mapping_update()
          `)
        })
      )

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "This transaction must roll back",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            drop trigger reject_excluded_mapping_update_before_update
            on provider_asset_mappings
          `)
          yield* db.execute(sql`drop function reject_excluded_mapping_update()`)
        })
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
          return { decisions, mapping }
        })
      )

      expect(result._tag).toBe("Failure")
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.decisions).toEqual([])
    })

    it("rejects a chainless exclusion reversal outside the revision-bound review flow", async () => {
      const providerAssetId = "btc-approval-manual-exclusion-reversal"
      const providerAsset = await seedPendingApprovalAsset("manual-exclusion-reversal")
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Excluded by automatic policy",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const reviewedEvidenceIds = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [exclusionDecision] = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
            .limit(1)
          const [linkedEvidenceOwner] = yield* db
            .insert(schema.providerAssets)
            .values({
              provider: "coinbase",
              providerAssetId: "linked-reversal-evidence-owner",
              currencyCode: "LINKED",
              evidenceRevision: 1,
              retrievedAt: new Date("2026-08-21T12:00:00.000Z"),
            })
            .returning({ id: schema.providerAssets.id })
          if (exclusionDecision === undefined || linkedEvidenceOwner === undefined) {
            return yield* Effect.die("Failed to seed exclusion reversal evidence owners")
          }
          const [linkedEvidenceDecision] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: linkedEvidenceOwner.id,
              evidenceRevision: 1,
              policyRevision: "linked-evidence.1",
              outcome: "excluded",
              reason: "explicit_banned_verdict",
              actor: "system:asset-resolution-policy",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (linkedEvidenceDecision === undefined) {
            return yield* Effect.die("Failed to seed linked evidence decision")
          }
          const [ownedEvidence] = yield* db
            .insert(schema.assetResolutionEvidence)
            .values({
              decisionId: exclusionDecision.id,
              authority: "owned-authority",
              claimKind: "spam",
              retrievedAt: new Date("2026-08-21T12:01:00.000Z"),
              evidenceRevision: 1,
              decodedClaim: { verdict: "excluded" },
              rawPayload: { source: "owned" },
            })
            .returning({ id: schema.assetResolutionEvidence.id })
          const [linkedEvidence] = yield* db
            .insert(schema.assetResolutionEvidence)
            .values({
              decisionId: linkedEvidenceDecision.id,
              authority: "linked-authority",
              claimKind: "spam",
              retrievedAt: new Date("2026-08-21T12:02:00.000Z"),
              evidenceRevision: 1,
              decodedClaim: { verdict: "excluded" },
              rawPayload: { source: "linked" },
            })
            .returning({ id: schema.assetResolutionEvidence.id })
          if (ownedEvidence === undefined || linkedEvidence === undefined) {
            return yield* Effect.die("Failed to seed exclusion reversal evidence")
          }
          yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values([
            { decisionId: exclusionDecision.id, evidenceId: ownedEvidence.id },
            { decisionId: exclusionDecision.id, evidenceId: linkedEvidence.id },
          ])
          return [ownedEvidence.id, linkedEvidence.id].sort()
        })
      )
      const revisedProviderAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId,
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin with revised metadata",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "test", revision: 2 },
              },
            ],
          })
          const revised = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId,
          })
          if (Option.isNone(revised)) {
            return yield* Effect.die("Expected revised approval provider asset")
          }
          return revised.value
        })
      )

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Human reversed a false exclusion",
              sourceNotes: "Manual approval",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: revisedProviderAsset.retrievedAt,
          })
        )
      )
      await expect(approval).rejects.toThrow(
        "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.mappingState"
      )
      const state = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const mapping = yield* repository.findProviderAssetMapping({
            providerAssetRowId: providerAsset.id,
          })
          const history = yield* repository.listAssetResolutionDecisions({
            providerAssetRowId: providerAsset.id,
          })
          return { mapping, history }
        })
      )

      expect(Option.getOrNull(state.mapping)).toMatchObject({ mappingStatus: "excluded" })
      expect(state.history).toHaveLength(1)
      expect(state.history[0]).toMatchObject({
        evidenceRevision: 1,
        outcome: "excluded",
        isCurrentConclusion: true,
      })
      const reversalEvidenceIds = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return (yield* db
            .select({ evidenceId: schema.assetResolutionDecisionEvidenceLinks.evidenceId })
            .from(schema.assetResolutionDecisionEvidenceLinks)
            .where(
              eq(
                schema.assetResolutionDecisionEvidenceLinks.decisionId,
                state.history[0]?.id ?? "00000000-0000-0000-0000-000000000000"
              )
            ))
            .map(({ evidenceId }) => evidenceId)
            .sort()
        })
      )
      expect(reversalEvidenceIds).toEqual(reviewedEvidenceIds)
    })

    it("requests replay when a source use is recorded after exclusion", async () => {
      const providerAsset = await seedPendingApprovalAsset("exclusion-before-source-use", {
        withProviderTransfer: false,
      })

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Excluded before source use was recorded",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const recordedAgain = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              followUpMode: schema.processingJobs.followUpMode,
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(recorded).toBe(1)
      expect(recordedAgain).toBe(0)
      expect(jobs).toEqual([{ followUpMode: null, mode: "replay", status: "pending" }])
    })

    it("rolls back the exclusion decision when the mapping transition fails", async () => {
      const providerAsset = await seedPendingApprovalAsset("atomic-exclusion-rollback", {
        withProviderTransfer: false,
      })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function reject_excluded_mapping_update() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mapping_status = 'excluded' then
                raise exception 'injected exclusion mapping failure';
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger reject_excluded_mapping_update_before_update
            before update on provider_asset_mappings
            for each row execute function reject_excluded_mapping_update()
          `)
        })
      )

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "This transaction must roll back",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            drop trigger reject_excluded_mapping_update_before_update
            on provider_asset_mappings
          `)
          yield* db.execute(sql`drop function reject_excluded_mapping_update()`)
        })
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAsset.id))
          return { decisions, mapping }
        })
      )

      expect(result._tag).toBe("Failure")
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.decisions).toEqual([])
    })

    it("rejects an on-chain exclusion reversal outside the revision-bound review flow", async () => {
      const providerAssetId = "btc-approval-manual-exclusion-reversal"
      const providerAsset = await seedPendingApprovalAsset("manual-exclusion-reversal")
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Excluded by automatic policy",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const revisedProviderAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId,
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin with revised metadata",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "test", revision: 2 },
              },
            ],
          })
          const revised = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId,
          })
          if (Option.isNone(revised)) {
            return yield* Effect.die("Expected revised approval provider asset")
          }
          return revised.value
        })
      )

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Human reversed a false exclusion",
              sourceNotes: "Manual approval",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: revisedProviderAsset.retrievedAt,
          })
        )
      )
      await expect(approval).rejects.toThrow(
        "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.mappingState"
      )
      const state = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const mapping = yield* repository.findProviderAssetMapping({
            providerAssetRowId: providerAsset.id,
          })
          const history = yield* repository.listAssetResolutionDecisions({
            providerAssetRowId: providerAsset.id,
          })
          return { mapping, history }
        })
      )

      expect(Option.getOrNull(state.mapping)).toMatchObject({ mappingStatus: "excluded" })
      expect(state.history).toHaveLength(1)
      expect(state.history[0]).toMatchObject({
        evidenceRevision: 1,
        outcome: "excluded",
        isCurrentConclusion: true,
      })
    })

    it("accepts exact representation evidence observed after approval", async () => {
      const providerAsset = await seedPendingApprovalAsset("exact-approved-use", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Exact evidence regression fixture",
            },
            conclusion: makeApprovalConclusion({
              providerAsset,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [{ providerAssetRowId: providerAsset.id, ...observation }],
          })
        )
      )

      expect(recorded).toBe(1)
    })

    it("accepts weaker evidence that does not contradict an approved representation", async () => {
      const providerAsset = await seedPendingApprovalAsset("partial-approved-use", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Partial evidence regression fixture",
            },
            conclusion: makeApprovalConclusion({
              providerAsset,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [
              {
                providerAssetRowId: providerAsset.id,
                observedBlockchainId: observation.observedBlockchainId,
                representationType: null,
                contractAddress: null,
                mintAddress: null,
                decimals: null,
              },
            ],
          })
        )
      )

      expect(recorded).toBe(1)
    })

    it.each([
      ["blockchain", { observedBlockchainId: "00000000-0000-4000-8000-000000000999" }],
      ["representation type", { representationType: "nft" as const }],
      ["contract address", { contractAddress: "0x0000000000000000000000000000000000000001" }],
      ["mint address", { mintAddress: "conflicting-mint" }],
      ["decimals", { decimals: 9 }],
    ])("rejects approved evidence with a mismatched %s", async (_field, override) => {
      const providerAsset = await seedPendingApprovalAsset(`mismatched-${_field}`, {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Mismatched evidence regression fixture",
            },
            conclusion: makeApprovalConclusion({
              providerAsset,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const result = await runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [{ providerAssetRowId: providerAsset.id, ...observation, ...override }],
            })
          )
        )
      )

      expect(result._tag).toBe("Failure")
    })

    it("rejects newly persisted evidence that conflicts with an approved mapping", async () => {
      const providerAsset = await seedPendingApprovalAsset("conflicting-approved-use", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Approved before conflicting source evidence persisted",
            },
            conclusion: makeApprovalConclusion({
              providerAsset,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const result = await runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [
                {
                  providerAssetRowId: providerAsset.id,
                  observedBlockchainId: "00000000-0000-4000-8000-000000000999",
                  representationType: "token",
                  contractAddress: "0x0000000000000000000000000000000000000001",
                  mintAddress: null,
                  decimals: 18,
                },
              ],
            })
          )
        )
      )
      const sourceUses = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
        })
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          operation: "providerAssetRepository.recordProviderAssetSourceUses",
          cause: {
            operation:
              "providerAssetRepository.recordProviderAssetSourceUses.validateApprovedMapping",
          },
        })
      }
      expect(sourceUses).toEqual([])
    })

    it("rolls back normalized artifacts when approval wins before conflicting evidence persists", async () => {
      const providerAsset = await seedPendingApprovalAsset("approval-wins-persistence-race", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approval won before persistence",
              sourceNotes: "Concurrency regression fixture",
            },
            conclusion: makeApprovalConclusion({
              providerAsset,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const conflictingBlockchainId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const blockchains = yield* db
            .select({ id: schema.blockchains.id, name: schema.blockchains.name })
            .from(schema.blockchains)
          const conflicting = blockchains.find(({ name }) => name.toLowerCase() !== "bitcoin")
          if (conflicting === undefined) {
            return yield* Effect.die("Missing conflicting blockchain fixture")
          }
          return conflicting.id
        })
      )

      const result = await runAtomicNormalization(
        Effect.result(
          Effect.gen(function* () {
            const providerAssetRepository = yield* ProviderAssetRepository
            const sourceNormalizationRepository = yield* SourceNormalizationRepository
            const syncEngineTransaction = yield* SyncEngineTransaction

            yield* syncEngineTransaction.run(
              sourceNormalizationRepository.persistNormalizedArtifacts({
                beforePersist: providerAssetRepository
                  .recordProviderAssetSourceUses({
                    sourceId: TEST_SOURCE_ID,
                    providerAssetRowIds: [providerAsset.id],
                    observations: [
                      {
                        providerAssetRowId: providerAsset.id,
                        observedBlockchainId: conflictingBlockchainId,
                        representationType: "token",
                        contractAddress: "0x0000000000000000000000000000000000000003",
                        mintAddress: null,
                        decimals: 18,
                      },
                    ],
                  })
                  .pipe(Effect.asVoid),
                transaction: {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "approval-wins-persistence-race",
                  externalGroupId: null,
                  timestamp: new Date("2025-04-21T10:00:00.000Z"),
                  transactionType: "internal_transfer",
                  providerTransactionType: "send",
                  providerStatus: "completed",
                  providerResourcePath: null,
                  providerDescription: "Conflicting approval race fixture",
                  providerCreatedAt: null,
                  providerUpdatedAt: null,
                  metadata: null,
                  providerFiatAmount: null,
                  providerFiatCurrency: null,
                  principalId: TEST_PRINCIPAL_ID,
                },
                venueContext: {
                  venueType: "cex",
                  cexAccountId: null,
                  externalAccountId: null,
                  externalOrderId: null,
                  externalFillId: null,
                  side: null,
                  instrument: null,
                  fillPrice: null,
                  commissionAmount: null,
                  commissionCurrency: null,
                  metadata: null,
                },
                providerTransfers: [
                  {
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: null,
                    externalId: "approval-wins-persistence-race:transfer",
                    externalGroupId: null,
                    providerAssetId: providerAsset.id,
                    timestamp: new Date("2025-04-21T10:00:00.000Z"),
                    direction: "outbound",
                    processingMode: "evidence_only",
                    fromAccountRef: null,
                    toAccountRef: null,
                    fromAddress: "0x0000000000000000000000000000000000000001",
                    toAddress: "0x0000000000000000000000000000000000000002",
                    networkName: "ethereum",
                    networkHash: "0xapproval-wins-persistence-race",
                    observedBlockchainId: conflictingBlockchainId,
                    observedRepresentationType: "token",
                    observedContractAddress: "0x0000000000000000000000000000000000000003",
                    observedMintAddress: null,
                    observedDecimals: 18,
                    amount: "0.10000000",
                    metadata: { role: "principal" },
                  },
                ],
                canonicalTransfers: [],
                providerAssetRowIds: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: {
                  providerTransactionType: "send",
                  transactionType: "internal_transfer",
                  inventoryEffect: "internal_transfer",
                  taxTreatment: "requires_additional_rule_logic",
                  resolutionStrategy: "static",
                  pairedRecordRequired: false,
                  mappingStatus: "approved",
                },
              })
            )
          })
        )
      )
      const persistedState = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const transactions = yield* db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(eq(schema.transactions.externalId, "approval-wins-persistence-race"))
          const sourceUses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
          return { sourceUses, transactions }
        })
      )

      expect(result._tag).toBe("Failure")
      expect(persistedState).toEqual({ sourceUses: [], transactions: [] })
    })

    it("keeps approval pending when conflicting normalization reserves the mapping first", async () => {
      const providerAsset = await seedPendingApprovalAsset("normalization-wins-persistence-race", {
        withProviderTransfer: false,
      })
      const conflictingBlockchainId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const blockchains = yield* db
            .select({ id: schema.blockchains.id, name: schema.blockchains.name })
            .from(schema.blockchains)
          const conflicting = blockchains.find(({ name }) => name.toLowerCase() !== "bitcoin")
          if (conflicting === undefined) {
            return yield* Effect.die("Missing conflicting blockchain fixture")
          }
          return conflicting.id
        })
      )
      const sourceUseReserved = await Effect.runPromise(Deferred.make<void>())
      const allowPersistence = await Effect.runPromise(Deferred.make<void>())
      const observation = {
        providerAssetRowId: providerAsset.id,
        observedBlockchainId: conflictingBlockchainId,
        representationType: "token" as const,
        contractAddress: "0x0000000000000000000000000000000000000003",
        mintAddress: null,
        decimals: 18,
      }

      const normalization = runAtomicNormalization(
        Effect.gen(function* () {
          const providerAssetRepository = yield* ProviderAssetRepository
          const sourceNormalizationRepository = yield* SourceNormalizationRepository
          const syncEngineTransaction = yield* SyncEngineTransaction
          yield* syncEngineTransaction.run(
            sourceNormalizationRepository.persistNormalizedArtifacts({
              beforePersist: providerAssetRepository
                .recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [observation],
                })
                .pipe(
                  Effect.tap(() => Deferred.succeed(sourceUseReserved, undefined)),
                  Effect.andThen(Deferred.await(allowPersistence))
                ),
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "normalization-wins-persistence-race",
                externalGroupId: null,
                timestamp: new Date("2025-04-21T11:00:00.000Z"),
                transactionType: "internal_transfer",
                providerTransactionType: "send",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Normalization-first race fixture",
                providerCreatedAt: null,
                providerUpdatedAt: null,
                metadata: null,
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: null,
                externalAccountId: null,
                externalOrderId: null,
                externalFillId: null,
                side: null,
                instrument: null,
                fillPrice: null,
                commissionAmount: null,
                commissionCurrency: null,
                metadata: null,
              },
              providerTransfers: [
                {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "normalization-wins-persistence-race:transfer",
                  externalGroupId: null,
                  providerAssetId: providerAsset.id,
                  timestamp: new Date("2025-04-21T11:00:00.000Z"),
                  direction: "outbound",
                  processingMode: "evidence_only",
                  fromAccountRef: null,
                  toAccountRef: null,
                  fromAddress: "0x0000000000000000000000000000000000000001",
                  toAddress: "0x0000000000000000000000000000000000000002",
                  networkName: "ethereum",
                  networkHash: "0xnormalization-wins-persistence-race",
                  observedBlockchainId: conflictingBlockchainId,
                  observedRepresentationType: "token",
                  observedContractAddress: observation.contractAddress,
                  observedMintAddress: null,
                  observedDecimals: observation.decimals,
                  amount: "0.10000000",
                  metadata: { role: "principal" },
                },
              ],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: {
                providerTransactionType: "send",
                transactionType: "internal_transfer",
                inventoryEffect: "internal_transfer",
                taxTreatment: "requires_additional_rule_logic",
                resolutionStrategy: "static",
                pairedRecordRequired: false,
                mappingStatus: "approved",
              },
            })
          )
        })
      )

      await Effect.runPromise(Deferred.await(sourceUseReserved))
      const approval = runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Conflicting approval must not win",
                sourceNotes: "Normalization-first race fixture",
              },
              conclusion: makeApprovalConclusion({
                providerAsset,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              }),
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )
      )
      await Effect.runPromise(Deferred.succeed(allowPersistence, undefined))
      const [, approvalResult] = await Promise.all([normalization, approval])
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const transactions = yield* db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(eq(schema.transactions.externalId, "normalization-wins-persistence-race"))
          const sourceUses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
          return { mapping, sourceUses, transactions }
        })
      )

      expect(approvalResult._tag).toBe("Failure")
      expect(state.mapping).toEqual({ status: "pending_review" })
      expect(state.transactions).toHaveLength(1)
      expect(state.sourceUses).toEqual([{ sourceId: TEST_SOURCE_ID }])
    })

    it.each(["pending", "processing"] as const)(
      "attaches replay to an active %s job when a new approved use is recorded",
      async (status) => {
        const providerAsset = await seedPendingApprovalAsset(`approved-use-${status}`, {
          withProviderTransfer: false,
        })
        await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved before active source use",
                sourceNotes: "Approved before active source use",
              },
              conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )
        await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "sync",
              status,
              attemptCount: status === "processing" ? 1 : 0,
              maxAttempts: 3,
              progressDetails: { mode: "sync" },
            })
          })
        )

        const [firstCount, secondCount] = await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            Effect.all(
              [
                repository.recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [],
                }),
                repository.recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [],
                }),
              ],
              { concurrency: 1 }
            )
          )
        )
        const jobs = await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                followUpMode: schema.processingJobs.followUpMode,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          })
        )

        expect([firstCount, secondCount]).toEqual([1, 0])
        expect(jobs).toEqual([{ followUpMode: "replay", mode: "sync", status }])
      }
    )

    it("locks observation sources before provider assets", async () => {
      const providerAsset = await seedPendingApprovalAsset("source-first-lock")
      const sourceLockAcquired = await Effect.runPromise(Deferred.make<void>())
      const updateProviderAsset = await Effect.runPromise(Deferred.make<void>())
      const heldNormalizationLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(sourceLockAcquired, undefined)
              yield* Deferred.await(updateProviderAsset)
              yield* tx
                .update(schema.providerAssets)
                .set({ retrievedAt: new Date("2026-08-16T12:00:00.000Z") })
                .where(eq(schema.providerAssets.id, providerAsset.id))
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(sourceLockAcquired))

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Source-first lock ordering",
              sourceNotes: "Source-first lock ordering",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      await context.waitForQueryBlockedOnLock({ queryIncludes: 'from "sources"' })
      await Effect.runPromise(Deferred.succeed(updateProviderAsset, undefined))
      const [, result] = await Promise.all([heldNormalizationLock, approval])

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(SyncEngineStorageError)
      }
    })

    it("holds exclusion snapshot locks until the decision commits", async () => {
      const providerAsset = await seedPendingApprovalAsset("exclusion-holds-snapshot-locks")
      const advisoryLockAcquired = await Effect.runPromise(Deferred.make<void>())
      const releaseAdvisoryLock = await Effect.runPromise(Deferred.make<void>())
      const heldAdvisoryLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(sql`select pg_advisory_xact_lock(147173)`)
              yield* Deferred.succeed(advisoryLockAcquired, undefined)
              yield* Deferred.await(releaseAdvisoryLock)
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(advisoryLockAcquired))
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function pause_exclusion_decision() returns trigger
            language plpgsql as $trigger$
            begin
              perform pg_advisory_xact_lock(147173);
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger pause_exclusion_decision_before_insert
            before insert on asset_resolution_decisions
            for each row execute function pause_exclusion_decision()
          `)
        })
      )

      const exclusion = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: providerAsset.id,
            decision: makeExcludedDecision(providerAsset.id),
            sourceNotes: "Snapshot locks must cover the decision",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      await context.waitForQueryBlockedOnLock({
        queryIncludes: 'insert into "asset_resolution_decisions"',
      })
      const sourceLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(eq(schema.sources.id, TEST_SOURCE_ID))
            .for("update")
        })
      )
      await context.waitForQueryBlockedOnLock({ queryIncludes: 'from "sources"' })
      await Effect.runPromise(Deferred.succeed(releaseAdvisoryLock, undefined))
      const [, result] = await Promise.all([heldAdvisoryLock, exclusion, sourceLock])

      expect(result).toEqual({ mappingChanged: true, decisionRecorded: true })
    })

    it("reattaches replay when another active owner wins the insert race", async () => {
      const providerAsset = await seedPendingApprovalAsset("insert-race-owner")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function inject_active_replay_owner() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mode = 'replay' then
                insert into processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  attempt_count,
                  max_attempts,
                  progress_details
                ) values (
                  new.source_id,
                  new.principal_id,
                  'sync',
                  'pending',
                  0,
                  3,
                  '{"mode":"sync"}'::jsonb
                ) on conflict do nothing;
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger inject_active_replay_owner_before_insert
            before insert on processing_jobs
            for each row execute function inject_active_replay_owner()
          `)
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
    })

    it("reattaches replay when a source-use insert loses the active-owner race", async () => {
      const providerAsset = await seedPendingApprovalAsset("source-use-insert-race-owner", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved before source use",
              sourceNotes: "Approved before source use",
            },
            conclusion: makeApprovalConclusion({ providerAsset, assetRepresentationId: null }),
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function inject_active_source_use_owner() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mode = 'replay' then
                insert into processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  attempt_count,
                  max_attempts,
                  progress_details
                ) values (
                  new.source_id,
                  new.principal_id,
                  'sync',
                  'pending',
                  0,
                  3,
                  '{"mode":"sync"}'::jsonb
                ) on conflict do nothing;
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger inject_active_source_use_owner_before_insert
            before insert on processing_jobs
            for each row execute function inject_active_source_use_owner()
          `)
        })
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(recorded).toBe(1)
      expect(jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
    })

    it("falls back to provider-scoped natural-key lookup when provider asset id is absent", async () => {
      const upsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:EUR",
                currencyCode: "eur",
                name: "Euro",
                exponent: 2,
                providerType: "fiat",
                payload: { id: "EUR" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:EUR",
          })
        )
      )

      expect(upsertCount).toBe(1)
      expect(Option.getOrNull(providerAsset)).toMatchObject({
        provider: "coinbase",
        providerAssetId: null,
        naturalKey: "currency_code:EUR",
        currencyCode: "EUR",
        name: "Euro",
        exponent: 2,
        providerType: "fiat",
      })
    })

    it("rejects a network representation that belongs to another economic asset", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "mismatched-representation-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "mismatched-representation-fixture" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "mismatched-representation-fixture",
          })
        )
      )

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Invalid cross-asset representation fixture",
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      expect(error).toBeInstanceOf(SyncEngineStorageError)
    })

    it("pages provider asset reviews with a stable provider asset cursor", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "ada-provider-asset",
                naturalKey: null,
                currencyCode: "ADA",
                name: "Cardano",
                exponent: 6,
                providerType: "crypto",
                payload: { code: "ADA" },
              },
              {
                providerAssetId: "eth-provider-asset",
                naturalKey: null,
                currencyCode: "ETH",
                name: "Ethereum",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "ETH" },
              },
              {
                providerAssetId: "sol-provider-asset",
                naturalKey: null,
                currencyCode: "SOL",
                name: "Solana",
                exponent: 9,
                providerType: "crypto",
                payload: { code: "SOL" },
              },
            ],
          })
        )
      )

      const providerAssets = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const cardano = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "ada-provider-asset",
          })
          const ethereum = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "eth-provider-asset",
          })
          const solana = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "sol-provider-asset",
          })

          if (Option.isNone(cardano) || Option.isNone(ethereum) || Option.isNone(solana)) {
            return yield* Effect.die("Expected provider assets to exist")
          }

          return [cardano.value, ethereum.value, solana.value] as const
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: providerAssets.map((providerAsset) => ({
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review",
              reviewerNotes: null,
              sourceNotes: "Needs review",
            })),
          })
        )
      )

      const firstPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            cursor: null,
            limit: 2,
          })
        )
      )

      expect(firstPage).toHaveLength(2)
      const lastFirstPageRow = firstPage.at(-1)

      if (lastFirstPageRow === undefined) {
        throw new Error("Expected the first provider asset page to contain rows.")
      }

      const secondPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            cursor: {
              providerAssetRowId: lastFirstPageRow.providerAsset.id,
            },
            limit: 2,
          })
        )
      )

      expect(secondPage).toHaveLength(1)
      expect(
        new Set([...firstPage, ...secondPage].map((review) => review.providerAsset.currencyCode))
      ).toEqual(new Set(["ADA", "ETH", "SOL"]))
    })

    it("keeps reviewed natural-key mappings preferred when a stable provider asset id arrives later", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:HYPE",
                currencyCode: "hype",
                name: "Hyperliquid",
                exponent: null,
                providerType: null,
                payload: { code: "HYPE" },
              },
            ],
          })
        )
      )

      const naturalKeyProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:HYPE",
          })
        )
      )

      if (Option.isNone(naturalKeyProviderAsset)) {
        expect.fail("Expected natural-key provider asset row to exist")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: naturalKeyProviderAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Admin reviewed placeholder asset",
                sourceNotes: "Admin decision",
              },
            ],
          })
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "hype-provider-asset",
                naturalKey: null,
                currencyCode: "HYPE",
                name: "Hyperliquid",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "HYPE", asset_id: "hype-provider-asset" },
              },
            ],
          })
        )
      )

      const resolvedProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByCurrencyCode({
            providerKey: "coinbase",
            currencyCode: "HYPE",
          })
        )
      )

      expect(Option.getOrNull(resolvedProviderAsset)).toMatchObject({
        id: naturalKeyProviderAsset.value.id,
        naturalKey: "currency_code:HYPE",
        providerAssetId: null,
        currencyCode: "HYPE",
      })
    })

    it("keeps excluded natural-key mappings preferred over newer unmapped stable ids", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:EXCL",
                currencyCode: "excl",
                name: "Excluded asset",
                exponent: null,
                providerType: null,
                payload: { code: "EXCL" },
              },
            ],
          })
        )
      )

      const naturalKeyProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:EXCL",
          })
        )
      )

      if (Option.isNone(naturalKeyProviderAsset)) {
        expect.fail("Expected natural-key provider asset row to exist")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: naturalKeyProviderAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Needs review",
              },
            ],
          })
        )
      )
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.excludeProviderAssetMappingAndRequestReplay({
            providerAssetRowId: naturalKeyProviderAsset.value.id,
            decision: makeExcludedDecision(naturalKeyProviderAsset.value.id),
            sourceNotes: "Admin excluded placeholder asset",
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: naturalKeyProviderAsset.value.retrievedAt,
          })
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "excluded-provider-asset",
                naturalKey: null,
                currencyCode: "EXCL",
                name: "Excluded asset",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "EXCL", asset_id: "excluded-provider-asset" },
              },
            ],
          })
        )
      )

      const resolvedProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByCurrencyCode({
            providerKey: "coinbase",
            currencyCode: "EXCL",
          })
        )
      )

      expect(Option.getOrNull(resolvedProviderAsset)).toMatchObject({
        id: naturalKeyProviderAsset.value.id,
        naturalKey: "currency_code:EXCL",
        providerAssetId: null,
        currencyCode: "EXCL",
      })
    })

    it("fails when a provider asset entry has neither stable id nor natural key", async () => {
      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: null,
                currencyCode: "mystery",
                name: "Mystery Asset",
                exponent: null,
                providerType: null,
                payload: { code: "MYSTERY" },
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(error).toEqual(
        new SyncEngineStorageError({
          operation: "providerAssetRepository.upsertProviderAssets",
          cause: {
            providerKey: "coinbase",
            currencyCode: "mystery",
            message: "Provider asset entries require either providerAssetId or naturalKey.",
          },
        })
      )
      expect(providerAssetRows).toHaveLength(0)
    })
  })

  describe("decision history", () => {
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

    const makePendingDecision = ({
      providerAssetRowId,
      evidenceRevision = 1,
      policyRevision = "2026-08-19.attach-only.1",
      reason = "missing_existing_economic_asset",
    }: {
      readonly providerAssetRowId: string
      readonly evidenceRevision?: number
      readonly policyRevision?: string
      readonly reason?: string
    }) => ({
      providerAssetRowId,
      evidenceRevision,
      policyRevision,
      outcome: "pending" as const,
      assetId: null,
      assetRepresentationId: null,
      blockchain: null,
      representationType: null,
      contractAddress: null,
      mintAddress: null,
      decimals: null,
      reason,
      evidence: [],
      actor: "system:attach-only-policy",
    })

    it("re-recording at the same evidence revision reports recorded: false and keeps the original", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-duplicate")

      const first = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({ providerAssetRowId }),
            requireCurrentEvidenceRevision: true,
          })
        )
      )
      expect(first).toEqual({ recorded: true })

      const second = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({
              providerAssetRowId,
              reason: "non_exact_platform_match",
            }),
            requireCurrentEvidenceRevision: true,
          })
        )
      )
      expect(second).toEqual({ recorded: false })

      const history = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listAssetResolutionDecisions({ providerAssetRowId })
        )
      )
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        isCurrentPolicyEvaluation: true,
        reason: "missing_existing_economic_asset",
      })
    })

    it("rejects stale job evaluations without persisting decision or evidence history", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-stale-job")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAssetRowId))
        })
      )

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: {
              ...makePendingDecision({ providerAssetRowId }),
              evidence: [
                {
                  authority: "registry",
                  claimKind: "stale_job_fixture",
                  sourceLocator: "test://stale-job",
                  retrievedAt: new Date("2026-08-26T20:00:00.000Z"),
                  evidenceRevision: 1,
                  decodedClaim: { revision: 1 },
                  rawPayload: { revision: 1 },
                },
              ],
            },
            requireCurrentEvidenceRevision: true,
          })
        )
      )
      const persisted = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAssetRowId))
          const evidence = yield* db
            .select({ id: schema.assetResolutionEvidence.id })
            .from(schema.assetResolutionEvidence)
          return { decisions, evidence }
        })
      )

      expect(result).toEqual({ recorded: false, stale: true })
      expect(persisted).toEqual({ decisions: [], evidence: [] })
    })

    it("preserves legacy automatic supersession rows with the same evaluation key", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-legacy-supersession")

      const history = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [original] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId,
              evidenceRevision: 1,
              policyRevision: "2026-08-19.attach-only.1",
              outcome: "pending",
              reason: "missing_existing_economic_asset",
              actor: "system:attach-only-policy",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (original === undefined) {
            return yield* Effect.die("Expected original legacy evaluation")
          }
          yield* db.insert(schema.assetResolutionDecisions).values({
            providerAssetRowId,
            evidenceRevision: 1,
            policyRevision: "2026-08-19.attach-only.1",
            outcome: "pending",
            supersedesDecisionId: original.id,
            reason: "non_exact_platform_match",
            actor: "system:attach-only-policy",
          })
          return yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
            .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAssetRowId))
        })
      )

      expect(history).toHaveLength(2)
    })

    it("rejects supersession links that cross observation histories", async () => {
      const { providerAssetRowId: firstObservationId } =
        await scheduleResolutionJob("history-cross-first")
      const { providerAssetRowId: secondObservationId } =
        await scheduleResolutionJob("history-cross-second")

      const crossObservation = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [secondDecision] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: secondObservationId,
              evidenceRevision: 1,
              policyRevision: "2026-08-19.attach-only.1",
              outcome: "excluded",
              actor: "system:attach-only-policy",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (secondDecision === undefined) {
            return yield* Effect.die("Expected second observation decision")
          }
          return yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: firstObservationId,
              evidenceRevision: 1,
              policyRevision: "2026-08-26.human-supersession.1",
              outcome: "excluded",
              supersedesDecisionId: secondDecision.id,
              actor: "human:admin",
            })
            .pipe(Effect.result)
        })
      )

      expect(crossObservation._tag).toBe("Failure")
    })

    it("establishes the first settled policy result as the conclusion without replacing one later", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-first-conclusion")

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({ providerAssetRowId }),
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAssetRowId))
        })
      )
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: {
              ...makePendingDecision({
                providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "2026-08-26.attach-only.2",
              }),
              outcome: "attach" as const,
              assetId: TEST_BTC_ASSET_ID,
            },
          })
        )
      )
      const [state] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAssetRowId))
        })
      )

      expect(state?.currentConclusionId).not.toBeNull()
      expect(state?.currentConclusionId).toBe(state?.currentPolicyEvaluationId)

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 3 })
            .where(eq(schema.providerAssets.id, providerAssetRowId))
        })
      )
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({
              providerAssetRowId,
              evidenceRevision: 3,
              policyRevision: "2026-08-26.attach-only.3",
            }),
          })
        )
      )
      const [advancedState] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAssetRowId))
        })
      )

      expect(advancedState?.currentConclusionId).toBe(state?.currentConclusionId)
      expect(advancedState?.currentPolicyEvaluationId).not.toBe(state?.currentPolicyEvaluationId)
    })

    it("keeps a late older evaluation from regressing either current pointer", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-late-evaluation")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAssetRowId))
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({
              providerAssetRowId,
              evidenceRevision: 2,
              policyRevision: "2026-08-26.attach-only.2",
            }),
          })
        )
      )
      const before = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [state] = yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAssetRowId))
          return state
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: {
              ...makePendingDecision({
                providerAssetRowId,
                evidenceRevision: 1,
                policyRevision: "2026-08-26.attach-only.1",
              }),
              outcome: "attach" as const,
              assetId: TEST_BTC_ASSET_ID,
            },
          })
        )
      )
      const after = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [state] = yield* db
            .select({
              currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              currentPolicyEvaluationId:
                schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            })
            .from(schema.assetResolutionCurrentState)
            .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAssetRowId))
          return state
        })
      )
      const history = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listAssetResolutionDecisions({ providerAssetRowId })
        )
      )

      expect(after).toEqual(before)
      expect(after?.currentConclusionId).toBeNull()
      expect(history).toHaveLength(2)
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            evidenceRevision: 2,
            isCurrentConclusion: false,
            isCurrentPolicyEvaluation: true,
          }),
          expect.objectContaining({
            evidenceRevision: 1,
            isCurrentConclusion: false,
            isCurrentPolicyEvaluation: false,
          }),
        ])
      )
    })

    it("appends a new policy revision without changing the prior evaluation", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-supersede")

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({ providerAssetRowId }),
          })
        )
      )

      const original = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findCurrentAssetResolutionPolicyEvaluation({
            providerAssetRowId,
            evidenceRevision: 1,
          })
        )
      )
      if (Option.isNone(original)) {
        throw new Error("Expected a current policy evaluation")
      }

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({
              providerAssetRowId,
              policyRevision: "2026-08-19.attach-only.2",
              reason: "non_exact_platform_match",
            }),
          })
        )
      )
      expect(recorded).toEqual({ recorded: true })

      const history = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listAssetResolutionDecisions({ providerAssetRowId })
        )
      )
      expect(history).toHaveLength(2)
      expect(history[0]).toMatchObject({
        id: original.value.id,
        reason: "missing_existing_economic_asset",
        supersedesConclusionId: null,
        isCurrentPolicyEvaluation: false,
      })
      expect(history[1]).toMatchObject({
        reason: "non_exact_platform_match",
        supersedesConclusionId: null,
        isCurrentPolicyEvaluation: true,
      })

      const current = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findCurrentAssetResolutionPolicyEvaluation({
            providerAssetRowId,
            evidenceRevision: 1,
          })
        )
      )
      if (Option.isNone(current)) {
        throw new Error("Expected the newer policy evaluation")
      }
      expect(current.value.reason).toBe("non_exact_platform_match")
    })

    it("stores authority-scoped evidence records behind a decision and reads them back", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-evidence")
      const retrievedAt = new Date("2025-06-01T12:00:00.000Z")

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: {
              ...makePendingDecision({ providerAssetRowId }),
              evidence: [
                {
                  authority: "chain",
                  claimKind: "chain_fact",
                  sourceLocator: `taxmaxi://provider-assets/${providerAssetRowId}/observed-representations`,
                  retrievedAt,
                  evidenceRevision: 1,
                  decodedClaim: { blockchain: "solana", decimals: 8 },
                  rawPayload: [{ observation: "raw" }],
                },
                {
                  authority: "coingecko",
                  claimKind: "registry_platform_mapping",
                  sourceLocator: "coingecko://coins/orb-test-coin",
                  retrievedAt,
                  evidenceRevision: 1,
                  decodedClaim: null,
                  rawPayload: { _tag: "upstream_failure", source: "coingecko" },
                },
              ],
            },
          })
        )
      )
      expect(recorded).toEqual({ recorded: true })

      const decision = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findCurrentAssetResolutionPolicyEvaluation({
            providerAssetRowId,
            evidenceRevision: 1,
          })
        )
      )
      if (Option.isNone(decision)) {
        throw new Error("Expected an active decision")
      }

      const evidence = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listAssetResolutionEvidence({ decisionId: decision.value.id })
        )
      )
      expect(evidence).toEqual([
        expect.objectContaining({
          authority: "chain",
          claimKind: "chain_fact",
          evidenceRevision: 1,
          decodedClaim: { blockchain: "solana", decimals: 8 },
          rawPayload: [{ observation: "raw" }],
        }),
        expect.objectContaining({
          authority: "coingecko",
          claimKind: "registry_platform_mapping",
          decodedClaim: null,
          rawPayload: { _tag: "upstream_failure", source: "coingecko" },
        }),
      ])
      expect(evidence[0]?.retrievedAt.toISOString()).toBe(retrievedAt.toISOString())
    })

    it("rejects a second evidence record for the same authority and claim kind on one decision", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-evidence-duplicate")

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: {
              ...makePendingDecision({ providerAssetRowId }),
              evidence: [
                {
                  authority: "chain",
                  claimKind: "chain_fact",
                  sourceLocator: null,
                  retrievedAt: new Date(),
                  evidenceRevision: 1,
                  decodedClaim: null,
                  rawPayload: null,
                },
              ],
            },
          })
        )
      )

      const decision = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findCurrentAssetResolutionPolicyEvaluation({
            providerAssetRowId,
            evidenceRevision: 1,
          })
        )
      )
      if (Option.isNone(decision)) {
        throw new Error("Expected an active decision")
      }

      const duplicateInsert = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.assetResolutionEvidence).values({
            decisionId: decision.value.id,
            authority: "chain",
            claimKind: "chain_fact",
            sourceLocator: null,
            retrievedAt: new Date(),
            evidenceRevision: 1,
            decodedClaim: null,
            rawPayload: null,
          })
        })
      )

      await expect(duplicateInsert).rejects.toThrow()
    })

    it("lets the database reject a second active decision for one observation and revision", async () => {
      const { providerAssetRowId } = await scheduleResolutionJob("history-db-guard")

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordAssetResolutionPolicyEvaluation({
            decision: makePendingDecision({ providerAssetRowId }),
          })
        )
      )

      const directInsert = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.assetResolutionDecisions).values({
            providerAssetRowId,
            evidenceRevision: 1,
            policyRevision: "2026-08-19.attach-only.1",
            outcome: "pending",
            reason: "missing_existing_economic_asset",
            actor: "test:direct-insert",
          })
        })
      )

      await expect(directInsert).rejects.toThrow()
    })
  })
})
