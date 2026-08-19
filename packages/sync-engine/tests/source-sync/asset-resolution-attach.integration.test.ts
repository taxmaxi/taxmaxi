import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import {
  AssetResolutionUpstreamFailure,
  type AssetResolutionProviderEvidence,
} from "@my/core/assets"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { AssetResolutionJobExecutorLive } from "../../src/layers/AssetResolutionJobExecutorLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseSyncClient } from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import {
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoRetryableError,
  AssetResolutionJobExecutor,
  ProviderAssetRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import { TaxCalculationService } from "../../../persistence/src/services/index.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_asset_resolution_attach_143",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-0000-0000-000000000161"
const principalId = "00000000-0000-0000-0000-000000000162"
const sourceId = "00000000-0000-0000-0000-000000000261"
const ORB_ASSET_ID = "00000000-0000-0000-0000-000000000561"
const ORB_MINT = "OrbTestMint1111111111111111111111111111111"
const ORB_COINGECKO_ID = "orb-test-coin"

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt,
    payload,
  })

const syncRecords = [
  makeCoinbaseRecord({
    recordType: "coinbase_account",
    externalRecordId: "coinbase-account-1",
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    payload: {
      id: "coinbase-account-1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-orb-buy-1",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-orb-buy-1",
      type: "buy",
      status: "completed",
      amount: { amount: "25.00000000", currency: "ORB" },
      native_amount: { amount: "1050.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-orb-buy-1",
      description: "ORB buy awaiting attach-only resolution",
    },
  }),
] as const

let providerFetchCount = 0

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.sync(() => ({
      records:
        providerFetchCount === 0
          ? syncRecords
              .filter((record) => record.recordType === "coinbase_account")
              .map((record) => ({
                id: record.externalRecordId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : [],
      nextCursor: null,
    })),
  fetchTransactionsPage: ({ accountId }) =>
    Effect.sync(() => {
      const records =
        providerFetchCount === 0
          ? syncRecords
              .filter((record) => record.recordType === "coinbase_transaction")
              .map((record) => ({
                id: record.externalRecordId,
                accountId: record.externalAccountId ?? accountId,
                parentId: record.externalParentId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : []

      providerFetchCount += 1

      return { records, nextCursor: null }
    }),
  fetchFiatCurrencies: () =>
    Effect.succeed([
      {
        currencyCode: "EUR",
        name: "Euro",
        minSize: "0.01",
        payload: { id: "EUR", name: "Euro", min_size: "0.01" },
      },
    ] as const),
  fetchCryptoCurrencies: () =>
    Effect.succeed([
      {
        currencyCode: "ORB",
        name: "Orb Test Coin",
        providerAssetId: "orb-provider-asset",
        exponent: 8,
        providerType: "crypto",
        payload: {
          code: "ORB",
          name: "Orb Test Coin",
          exponent: 8,
          type: "crypto",
          asset_id: "orb-provider-asset",
        },
      },
    ] as const),
})

const orbCoinGeckoUpstreamFailure = new AssetResolutionUpstreamFailure({ source: "coingecko" })

type FakeCoinGeckoMode = "success" | "retryable" | "terminal"

let coinGeckoMode: FakeCoinGeckoMode = "success"

const FakeAssetResolutionCoinGeckoClientLive = Layer.succeed(AssetResolutionCoinGeckoClient, {
  fetchCoin: ({
    coinGeckoCoinId,
  }): Effect.Effect<AssetResolutionProviderEvidence, AssetResolutionCoinGeckoRetryableError> => {
    if (coinGeckoMode === "retryable") {
      return Effect.fail(
        new AssetResolutionCoinGeckoRetryableError({ status: 429, cause: "rate limited" })
      )
    }

    if (coinGeckoMode === "terminal") {
      return Effect.succeed(orbCoinGeckoUpstreamFailure)
    }

    return coinGeckoCoinId === ORB_COINGECKO_ID
      ? Effect.succeed({
          _tag: "payload" as const,
          payload: {
            id: ORB_COINGECKO_ID,
            symbol: "orb",
            name: "Orb Test Coin",
            asset_platform_id: "solana",
            platforms: { solana: ORB_MINT },
            detail_platforms: { solana: { decimal_place: 8, contract_address: ORB_MINT } },
          },
        })
      : Effect.succeed(orbCoinGeckoUpstreamFailure)
  },
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(AssetRepositoryLive)
)

const CoinbaseReferenceDataWithDepsLive = CoinbaseReferenceDataServiceLive.pipe(
  Layer.provideMerge(CoinbaseSyncClientTestLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive)
)

const CoinbaseSourceSyncProviderWithDepsLive = CoinbaseSourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseRecordNormalizerLive),
  Layer.provide(CoinbaseLegDerivationServiceLive),
  Layer.provide(CoinbaseReferenceDataWithDepsLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(CoinbaseSyncClientTestLive),
  Layer.provide(AssetRepositoryLive)
)

const SourceSyncJobExecutorTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationServiceLive),
  Layer.provide(
    SourceProviderRegistryLive.pipe(
      Layer.provide(CoinbaseSourceSyncProviderWithDepsLive),
      Layer.provide(HeliusSolanaSourceSyncProviderLive)
    )
  ),
  Layer.provide(CoinbaseSourceSyncProviderWithDepsLive)
)

const SourceSyncLayer = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineExecutorTestLive),
  Layer.provide(SourceSyncJobExecutorTestLive)
)

const AssetResolutionJobExecutorTestLive = AssetResolutionJobExecutorLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(AssetRepositoryLive),
  Layer.provide(FakeAssetResolutionCoinGeckoClientLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(AssetResolutionJobExecutorTestLive),
  Layer.provideMerge(CoinbaseSourceSyncProviderWithDepsLive),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const seedCoinbaseSource = () =>
  seedSyncEngineRepositoryFixture({ userId, principalId, sourceId }).pipe(
    Effect.asVoid,
    Effect.provide(TestPgClientLive)
  )

const insertOrbAsset = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values({
      id: ORB_ASSET_ID,
      name: "Orb Test Coin",
      symbol: "ORB",
      coingeckoCoinId: ORB_COINGECKO_ID,
      type: "fungible",
    })
  }).pipe(Effect.provide(TestPgClientLive))

/**
 * Record the exact on-chain identity behind the ORB buy as evidence-only
 * provider-transfer history. A pending Coinbase observation has no transfer
 * or leg rows yet (leg derivation is skipped until the mapping resolves), so
 * this persists the same evidence a real on-chain-aware provider would have
 * recorded inline, without waiting on live sync/replay wiring.
 */
const recordOrbSolanaObservation = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [solanaBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "solana"))
      .limit(1)

    if (solanaBlockchain === undefined) {
      return yield* Effect.die("Missing seeded Solana blockchain")
    }

    const [transaction] = yield* db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, "tx-orb-buy-1")
        )
      )
      .limit(1)

    if (transaction === undefined) {
      return yield* Effect.die("Missing tx-orb-buy-1 transaction fixture")
    }

    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "ORB")
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die("Missing ORB provider asset fixture")
    }

    yield* db.insert(schema.providerTransfers).values({
      sourceId,
      transactionId: transaction.id,
      externalId: "tx-orb-buy-1:onchain-evidence",
      providerAssetId: providerAsset.id,
      timestamp: new Date("2025-05-01T10:00:00.000Z"),
      direction: "inbound",
      processingMode: "evidence_only",
      fromAccountRef: "external",
      toAccountRef: "coinbase-account-1",
      observedBlockchainId: solanaBlockchain.id,
      observedRepresentationType: "token",
      observedContractAddress: null,
      observedMintAddress: ORB_MINT,
      observedDecimals: 8,
      amount: "25",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const SECOND_PROVIDER_ASSET_ROW_ID = "00000000-4000-4000-8000-000000000661"

/**
 * A second provider surfaces the same ORB mint under its own provider asset
 * identity, as a later Solana integration would.
 */
const recordSecondProviderObservationOfOrbMint = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [solanaBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "solana"))
      .limit(1)

    if (solanaBlockchain === undefined) {
      return yield* Effect.die("Missing seeded Solana blockchain")
    }

    const [transaction] = yield* db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, "tx-orb-buy-1")
        )
      )
      .limit(1)

    if (transaction === undefined) {
      return yield* Effect.die("Missing tx-orb-buy-1 transaction fixture")
    }

    yield* db.insert(schema.providerAssets).values({
      id: SECOND_PROVIDER_ASSET_ROW_ID,
      provider: "helius-solana",
      providerAssetId: null,
      naturalKey: `solana:mint:${ORB_MINT}`,
      currencyCode: "ORB",
      name: "Orb Test Coin",
      exponent: 8,
      providerType: "crypto",
      rawProviderPayload: { source: "test" },
      retrievedAt: new Date("2025-05-01T10:00:00.000Z"),
    })

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: SECOND_PROVIDER_ASSET_ROW_ID,
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "pending_review",
      reviewerNotes: null,
      sourceNotes: "Default mapping awaiting resolution.",
    })

    yield* db.insert(schema.providerTransfers).values({
      sourceId,
      transactionId: transaction.id,
      externalId: "tx-orb-buy-1:second-provider-evidence",
      providerAssetId: SECOND_PROVIDER_ASSET_ROW_ID,
      timestamp: new Date("2025-05-01T10:00:00.000Z"),
      direction: "inbound",
      processingMode: "evidence_only",
      fromAccountRef: "external",
      toAccountRef: "coinbase-account-1",
      observedBlockchainId: solanaBlockchain.id,
      observedRepresentationType: "token",
      observedContractAddress: null,
      observedMintAddress: ORB_MINT,
      observedDecimals: 8,
      amount: "25",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const scheduleSecondProviderResolutionJob = () =>
  Effect.gen(function* () {
    const repository = yield* ProviderAssetRepository
    return yield* repository.scheduleUnresolvedResolutionJob({
      providerAssetRowId: SECOND_PROVIDER_ASSET_ROW_ID,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchPendingResolutionJobId = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [job] = yield* db
      .select({ id: schema.assetResolutionJobs.id })
      .from(schema.assetResolutionJobs)
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionJobs.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "ORB")
        )
      )
      .limit(1)

    if (job === undefined) {
      return yield* Effect.die("Missing durable resolution job for ORB provider asset")
    }

    return job.id
  }).pipe(Effect.provide(TestPgClientLive))

const fetchResolutionJobState = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [job] = yield* db
      .select({
        status: schema.assetResolutionJobs.status,
        attemptCount: schema.assetResolutionJobs.attemptCount,
        nextRetryAt: schema.assetResolutionJobs.nextRetryAt,
        errorMessage: schema.assetResolutionJobs.errorMessage,
      })
      .from(schema.assetResolutionJobs)
      .where(eq(schema.assetResolutionJobs.id, jobId))
      .limit(1)

    if (job === undefined) {
      return yield* Effect.die(`Missing asset resolution job ${jobId}`)
    }

    return job
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({ principalId, sourceId })
  }).pipe(Effect.provide(TestLayer))

const runResolutionJob = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const executor = yield* AssetResolutionJobExecutor
    return yield* executor.executeJob({ jobId })
  }).pipe(Effect.provide(TestLayer))

const replaySource = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    const summary = yield* sourceSync.replaySourceSyncJob({ principalId, sourceId })
    return yield* sourceSync.getSourceSyncJob({ principalId, sourceId, jobId: summary.jobId })
  }).pipe(Effect.provide(TestLayer))

const calculateTax = () =>
  Effect.gen(function* () {
    const taxCalculation = yield* TaxCalculationService
    return yield* taxCalculation.calculateTax({
      sourceId,
      jurisdiction: "germany",
      year: 2025,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchAttachState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [mapping] = yield* db
      .select({
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))
      .limit(1)

    const decisions = yield* db
      .select({
        outcome: schema.assetResolutionDecisions.outcome,
        assetId: schema.assetResolutionDecisions.assetId,
        assetRepresentationId: schema.assetResolutionDecisions.assetRepresentationId,
        policyRevision: schema.assetResolutionDecisions.policyRevision,
        actor: schema.assetResolutionDecisions.actor,
        reason: schema.assetResolutionDecisions.reason,
      })
      .from(schema.assetResolutionDecisions)
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))

    const evidence = yield* db
      .select({
        authority: schema.assetResolutionEvidence.authority,
        claimKind: schema.assetResolutionEvidence.claimKind,
        sourceLocator: schema.assetResolutionEvidence.sourceLocator,
        evidenceRevision: schema.assetResolutionEvidence.evidenceRevision,
        decodedClaim: schema.assetResolutionEvidence.decodedClaim,
        rawPayload: schema.assetResolutionEvidence.rawPayload,
      })
      .from(schema.assetResolutionEvidence)
      .innerJoin(
        schema.assetResolutionDecisions,
        eq(schema.assetResolutionEvidence.decisionId, schema.assetResolutionDecisions.id)
      )
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))
      .orderBy(schema.assetResolutionEvidence.authority)

    const representations = yield* db
      .select({
        assetId: schema.assetRepresentations.assetId,
        type: schema.assetRepresentations.type,
        mintAddress: schema.assetRepresentations.mintAddress,
        decimals: schema.assetRepresentations.decimals,
      })
      .from(schema.assetRepresentations)
      .where(eq(schema.assetRepresentations.assetId, ORB_ASSET_ID))

    const ownershipDecisions = yield* db
      .select({
        assetRepresentationId: schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
        assetId: schema.assetRepresentationOwnershipDecisions.assetId,
        status: schema.assetRepresentationOwnershipDecisions.status,
        actor: schema.assetRepresentationOwnershipDecisions.actor,
      })
      .from(schema.assetRepresentationOwnershipDecisions)
      .where(eq(schema.assetRepresentationOwnershipDecisions.assetId, ORB_ASSET_ID))

    const replayJobs = yield* db
      .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.sourceId, sourceId))

    return { mapping, decisions, evidence, ownershipDecisions, representations, replayJobs }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchAccountingState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const legs = yield* db
      .select({
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const fifoLots = yield* db
      .select({ sourceId: schema.fifoLots.sourceId })
      .from(schema.fifoLots)
      .where(eq(schema.fifoLots.sourceId, sourceId))

    return { legs, fifoLots }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("asset resolution attach and rematerialize", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      providerFetchCount = 0
      coinGeckoMode = "success"
      yield* context.recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it("attaches a new exact representation and rematerializes every affected source", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()

        const pendingTax = yield* calculateTax().pipe(Effect.result)
        expect(pendingTax._tag).toBe("Failure")

        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("attached")

        const attachState = yield* fetchAttachState()
        expect(attachState.mapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: ORB_ASSET_ID,
        })
        expect(attachState.mapping?.assetRepresentationId).not.toBeNull()
        expect(attachState.decisions).toEqual([
          expect.objectContaining({
            outcome: "attach",
            assetId: ORB_ASSET_ID,
            actor: "system:attach-only-policy",
          }),
        ])
        expect(attachState.representations).toEqual([
          expect.objectContaining({
            assetId: ORB_ASSET_ID,
            type: "token",
            mintAddress: ORB_MINT,
            decimals: 8,
          }),
        ])
        expect(attachState.evidence).toEqual([
          expect.objectContaining({
            authority: "chain",
            claimKind: "chain_fact",
            evidenceRevision: 1,
            decodedClaim: expect.objectContaining({ mintAddress: ORB_MINT, decimals: 8 }),
          }),
          expect.objectContaining({
            authority: "coingecko",
            claimKind: "registry_platform_mapping",
            sourceLocator: `coingecko://coins/${ORB_COINGECKO_ID}`,
            evidenceRevision: 1,
            rawPayload: expect.objectContaining({
              payload: expect.objectContaining({ id: ORB_COINGECKO_ID }),
            }),
          }),
        ])
        expect(attachState.ownershipDecisions).toEqual([
          expect.objectContaining({
            assetId: ORB_ASSET_ID,
            status: "active",
            actor: "system:attach-only-policy",
          }),
        ])
        expect(attachState.replayJobs).toContainEqual({ mode: "replay", status: "pending" })

        const duplicateResult = yield* runResolutionJob({ jobId })
        expect(duplicateResult.outcome).toBe("already_claimed")

        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const accountingState = yield* fetchAccountingState()
        expect(accountingState.legs).toEqual([
          expect.objectContaining({ kind: "acquisition", derivationRule: "coinbase_buy" }),
        ])
        expect(accountingState.fifoLots).toHaveLength(1)

        const taxAfterAttach = yield* calculateTax()
        expect(taxAfterAttach.taxableGains).toBe(0)
      })
    )
  })

  it("leaves a stale evidence revision without a decision and without attaching", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const staleJobId = yield* fetchPendingResolutionJobId()

        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
        }).pipe(Effect.provide(TestPgClientLive))

        const result = yield* runResolutionJob({ jobId: staleJobId })
        expect(result.outcome).toBe("stale")

        const attachState = yield* fetchAttachState()
        expect(attachState.mapping).toMatchObject({ mappingStatus: "pending_review" })
        expect(attachState.decisions).toEqual([])
        expect(attachState.representations).toEqual([])
      })
    )
  })

  it("releases the job for retry on a transient CoinGecko failure without recording a decision", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        coinGeckoMode = "retryable"
        const failed = yield* runResolutionJob({ jobId }).pipe(Effect.result)
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") {
          expect(failed.failure).toBeInstanceOf(AssetResolutionCoinGeckoRetryableError)
        }

        const stateAfterFailure = yield* fetchAttachState()
        expect(stateAfterFailure.decisions).toEqual([])
        expect(stateAfterFailure.representations).toEqual([])

        const jobAfterFailure = yield* fetchResolutionJobState({ jobId })
        expect(jobAfterFailure.status).toBe("pending")
        expect(jobAfterFailure.nextRetryAt).not.toBeNull()
        expect(jobAfterFailure.attemptCount).toBe(1)

        // Once the upstream recovers and the retry delay passes, the same job
        // reaches the same decision a first-attempt success would have.
        coinGeckoMode = "success"
        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ nextRetryAt: new Date(Date.now() - 1000) })
            .where(eq(schema.assetResolutionJobs.id, jobId))
        }).pipe(Effect.provide(TestPgClientLive))

        const retried = yield* runResolutionJob({ jobId })
        expect(retried.outcome).toBe("attached")

        const stateAfterRetry = yield* fetchAttachState()
        expect(stateAfterRetry.decisions).toEqual([
          expect.objectContaining({ outcome: "attach", assetId: ORB_ASSET_ID }),
        ])
      })
    )
  })

  it("re-executing at the same evidence revision keeps the original decision and repeats nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const first = yield* runResolutionJob({ jobId })
        expect(first.outcome).toBe("attached")

        // Simulate a crash after the decision was recorded but before the
        // job completed: the job goes back to pending and runs again at the
        // same evidence revision.
        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetResolutionJobs)
            .set({ status: "pending", nextRetryAt: null, workerId: null, heartbeatAt: null })
            .where(eq(schema.assetResolutionJobs.id, jobId))
        }).pipe(Effect.provide(TestPgClientLive))

        const replay = yield* runResolutionJob({ jobId })
        expect(replay.outcome).toBe("attached")

        const state = yield* fetchAttachState()
        expect(state.decisions).toHaveLength(1)
        expect(state.decisions[0]).toMatchObject({ outcome: "attach", assetId: ORB_ASSET_ID })
        expect(state.representations).toHaveLength(1)
      })
    )
  })

  it("resolves a second provider's observation of a settled representation without registry evidence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const firstJobId = yield* fetchPendingResolutionJobId()
        const first = yield* runResolutionJob({ jobId: firstJobId })
        expect(first.outcome).toBe("attached")

        // The registry is now unavailable; only the settled ownership can
        // resolve the second provider's observation of the same mint.
        coinGeckoMode = "terminal"
        yield* recordSecondProviderObservationOfOrbMint()
        const scheduled = yield* scheduleSecondProviderResolutionJob()
        expect(scheduled.created).toBe(true)

        const [secondJob] = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID))
            .limit(1)
        }).pipe(Effect.provide(TestPgClientLive))
        if (secondJob === undefined) {
          throw new Error("Expected a resolution job for the second provider asset")
        }

        const second = yield* runResolutionJob({ jobId: secondJob.id })
        expect(second.outcome).toBe("attached")

        const state = yield* fetchAttachState()
        // Still exactly one ORB representation and one settled owner.
        expect(state.representations).toHaveLength(1)
        expect(state.ownershipDecisions).toHaveLength(1)

        const [secondMapping] = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mappingStatus: schema.providerAssetMappings.mappingStatus,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            })
            .from(schema.providerAssetMappings)
            .where(
              eq(schema.providerAssetMappings.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
            )
            .limit(1)
        }).pipe(Effect.provide(TestPgClientLive))
        expect(secondMapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: ORB_ASSET_ID,
        })
      })
    )
  })

  it("records a fail_closed decision exactly once for a terminal CoinGecko failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        coinGeckoMode = "terminal"
        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("fail_closed")

        const state = yield* fetchAttachState()
        expect(state.decisions).toEqual([
          expect.objectContaining({ outcome: "fail_closed", reason: "upstream_failure" }),
        ])
        expect(state.representations).toEqual([])

        const job = yield* fetchResolutionJobState({ jobId })
        expect(job.status).toBe("completed")

        const duplicate = yield* runResolutionJob({ jobId })
        expect(duplicate.outcome).toBe("already_claimed")

        const stateAfterDuplicate = yield* fetchAttachState()
        expect(stateAfterDuplicate.decisions).toHaveLength(1)
      })
    )
  })
})
