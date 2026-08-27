import { and, eq, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import { TaxCalculationServiceLive } from "../src/layers/TaxCalculationServiceLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { sourceInventoryLockQuery } from "../src/layers/SourceInventoryLock.ts"
import { schema } from "../src/schema/index.ts"
import { TaxCalculationService } from "../src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "./support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_persistence_tax_calc",
})

const TestLayer = TaxCalculationServiceLive.pipe(Layer.provideMerge(context.TestPgClientLive))

const userId = "00000000-0000-0000-0000-000000000111"
const principalId = "00000000-0000-0000-0000-000000000112"
const sourceId = "00000000-0000-0000-0000-000000000222"
const btcContractAddress = "btc-tax-calculation"

const calculateTax = ({
  sourceId: calculationSourceId = sourceId,
  jurisdiction = "germany",
  year = 2025,
}: {
  readonly sourceId?: string
  readonly jurisdiction?: string
  readonly year?: number
} = {}) =>
  Effect.gen(function* () {
    const taxCalculation = yield* TaxCalculationService
    return yield* taxCalculation.calculateTax({
      sourceId: calculationSourceId,
      jurisdiction,
      year,
    })
  }).pipe(Effect.provide(TestLayer))

const seedTaxFixtures = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: "tax-calculation@taxmaxi.test",
      name: "Tax Calculation Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })

    const [coinbaseCex] = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)

    if (coinbaseCex === undefined) {
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
    }

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: coinbaseCex.id,
        principalId,
        providerUserId: "coinbase-tax-user",
        providerAccountId: "coinbase-tax-account",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (createdAccount === undefined) {
      return yield* Effect.die("Failed to create cex account fixture")
    }

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.die("Failed to load base blockchain fixture")
    }

    const [btcAsset] = yield* db
      .insert(schema.assets)
      .values({
        name: "Bitcoin",
        symbol: "BTC",
        type: "fungible",
      })
      .returning({ id: schema.assets.id })

    if (btcAsset === undefined) {
      return yield* Effect.die("Failed to create BTC asset fixture")
    }

    yield* db.insert(schema.assetRepresentations).values({
      assetId: btcAsset.id,
      blockchainId: baseBlockchain.id,
      contractAddress: btcContractAddress,
      mintAddress: null,
      decimals: 8,
      type: "token",
    })

    yield* db.insert(schema.sources).values({
      id: sourceId,
      name: "Coinbase",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      principalId,
    })

    const shortTermAcquisitionLegId = "00000000-0000-0000-0000-000000000301"
    const longTermAcquisitionLegId = "00000000-0000-0000-0000-000000000302"
    const shortTermDisposalLegId = "00000000-0000-0000-0000-000000000303"
    const longTermDisposalLegId = "00000000-0000-0000-0000-000000000304"
    const incomeLegId = "00000000-0000-0000-0000-000000000305"
    const shortTermLotId = "00000000-0000-0000-0000-000000000401"
    const longTermLotId = "00000000-0000-0000-0000-000000000402"

    yield* db.insert(schema.transactionLegs).values([
      {
        id: shortTermAcquisitionLegId,
        sourceId,
        externalId: "short-term-acquisition",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        principalId,
        assetId: btcAsset.id,
        amount: "100000000",
        kind: "acquisition",
        provenance: "deterministic",
        fiatAmount: "10000.00",
        fiatCurrency: "EUR",
      },
      {
        id: longTermAcquisitionLegId,
        sourceId,
        externalId: "long-term-acquisition",
        timestamp: new Date("2023-12-01T10:00:00.000Z"),
        principalId,
        assetId: btcAsset.id,
        amount: "20000000",
        kind: "acquisition",
        provenance: "deterministic",
        fiatAmount: "1000.00",
        fiatCurrency: "EUR",
      },
      {
        id: shortTermDisposalLegId,
        sourceId,
        externalId: "short-term-disposal",
        timestamp: new Date("2025-02-01T10:00:00.000Z"),
        principalId,
        assetId: btcAsset.id,
        amount: "40000000",
        kind: "disposal",
        provenance: "deterministic",
        fiatAmount: "6000.00",
        fiatCurrency: "EUR",
      },
      {
        id: longTermDisposalLegId,
        sourceId,
        externalId: "long-term-disposal",
        timestamp: new Date("2025-04-01T10:00:00.000Z"),
        principalId,
        assetId: btcAsset.id,
        amount: "10000000",
        kind: "disposal",
        provenance: "deterministic",
        fiatAmount: "900.00",
        fiatCurrency: "EUR",
      },
      {
        id: incomeLegId,
        sourceId,
        externalId: "income-leg",
        timestamp: new Date("2025-03-01T10:00:00.000Z"),
        principalId,
        assetId: btcAsset.id,
        amount: "5000000",
        kind: "income",
        provenance: "deterministic",
        fiatAmount: "700.00",
        fiatCurrency: "EUR",
      },
    ])

    yield* db.insert(schema.fifoLots).values([
      {
        id: shortTermLotId,
        principalId,
        sourceId,
        assetId: btcAsset.id,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "100000000",
        remainingAmount: "60000000",
        costBasisPerToken: "0.000100000000000000",
        costBasisCurrency: "EUR",
        sourceLegId: shortTermAcquisitionLegId,
        sourceLegSequence: 0,
      },
      {
        id: longTermLotId,
        principalId,
        sourceId,
        assetId: btcAsset.id,
        acquiredAt: new Date("2023-12-01T10:00:00.000Z"),
        originalAmount: "20000000",
        remainingAmount: "10000000",
        costBasisPerToken: "0.000050000000000000",
        costBasisCurrency: "EUR",
        sourceLegId: longTermAcquisitionLegId,
        sourceLegSequence: 0,
      },
    ])

    yield* db.insert(schema.disposalMatches).values([
      {
        disposalLegId: shortTermDisposalLegId,
        fifoLotId: shortTermLotId,
        matchedAmount: "40000000",
        costBasis: "4000.00",
        proceeds: "6000.00",
        gainLoss: "2000.00",
      },
      {
        disposalLegId: longTermDisposalLegId,
        fifoLotId: longTermLotId,
        matchedAmount: "10000000",
        costBasis: "500.00",
        proceeds: "900.00",
        gainLoss: "400.00",
      },
    ])
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertIncompleteIncomeLeg = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [asset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assetRepresentations)
      .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
      .where(eq(schema.assetRepresentations.contractAddress, btcContractAddress))
      .limit(1)

    if (asset === undefined) {
      return yield* Effect.die("Failed to load BTC asset fixture")
    }

    yield* db.insert(schema.transactionLegs).values({
      id: "00000000-0000-0000-0000-000000000306",
      sourceId,
      externalId: "income-leg-missing-valuation",
      timestamp: new Date("2025-05-01T10:00:00.000Z"),
      principalId,
      assetId: asset.id,
      amount: "1000000",
      kind: "income",
      provenance: "deterministic",
      fiatAmount: null,
      fiatCurrency: null,
    })
  }).pipe(Effect.provide(context.TestPgClientLive))

const updateIncomeLegCurrency = (fiatCurrency: string | null) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db
      .update(schema.transactionLegs)
      .set({
        fiatCurrency,
      })
      .where(eq(schema.transactionLegs.externalId, "income-leg"))
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertPendingTransactionReview = ({
  matchedLayer,
  withAccountingLeg = false,
}: {
  readonly matchedLayer: string | null
  readonly withAccountingLeg?: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId,
        externalId: `pending-review-${matchedLayer ?? "unknown"}`,
        timestamp: new Date("2025-06-01T10:00:00.000Z"),
        principalId,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create pending transaction review fixture")
    }

    yield* db.insert(schema.transactionReviews).values({
      transactionId: transaction.id,
      principalId,
      matchedLayer,
    })

    if (withAccountingLeg) {
      const [asset] = yield* db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(eq(schema.assets.symbol, "BTC"))
        .limit(1)

      if (asset === undefined) {
        return yield* Effect.die("Missing reviewed transaction asset fixture")
      }

      yield* db.insert(schema.transactionLegs).values({
        sourceId,
        externalId: `reviewed-accounting-leg-${matchedLayer ?? "unknown"}`,
        timestamp: new Date("2025-06-01T10:00:00.000Z"),
        principalId,
        assetId: asset.id,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: transaction.id,
      })
    }
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertUnresolvedProviderAssetSourceUse = ({
  mappingStatus,
}: {
  readonly mappingStatus?: "pending_review" | "rejected"
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        naturalKey: "coinbase-unresolved-asset",
        currencyCode: "XYZ",
        retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create unresolved provider asset fixture")
    }

    yield* db.insert(schema.providerAssetSourceUses).values({
      providerAssetRowId: providerAsset.id,
      sourceId,
      hasChainlessObservation: true,
    })

    if (mappingStatus !== undefined) {
      yield* db.insert(schema.providerAssetMappings).values({
        providerAssetRowId: providerAsset.id,
        mappingKind: "asset",
        canonicalAssetId: null,
        mappingStatus,
        sourceNotes: "Tax calculation blocking fixture",
      })
    }
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertExcludedProviderAssetSourceUseWithRematerialization = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        naturalKey: "coinbase-excluded-asset",
        currencyCode: "EXCLUDED",
        retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create excluded provider asset fixture")
    }

    yield* db.insert(schema.providerAssetSourceUses).values({
      providerAssetRowId: providerAsset.id,
      sourceId,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: null,
      mappingStatus: "excluded",
      sourceNotes: "Human exclusion awaiting replay",
    })

    const [decision] = yield* db
      .insert(schema.assetResolutionDecisions)
      .values({
        providerAssetRowId: providerAsset.id,
        evidenceRevision: 1,
        policyRevision: "human:test",
        outcome: "excluded",
        status: "active",
        reason: "not_economic_activity",
        actor: userId,
      })
      .returning({ id: schema.assetResolutionDecisions.id })
    const [job] = yield* db
      .insert(schema.processingJobs)
      .values({
        sourceId,
        principalId,
        mode: "replay",
        status: "pending",
      })
      .returning({ id: schema.processingJobs.id })

    if (decision === undefined || job === undefined) {
      return yield* Effect.die("Failed to create exclusion replay fixture")
    }

    yield* db.insert(schema.assetDecisionRematerializations).values({
      decisionId: decision.id,
      sourceId,
      processingJobId: job.id,
      status: "pending",
    })

    return { decisionId: decision.id, jobId: job.id, providerAssetRowId: providerAsset.id }
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertRejectedOverrideFixture = ({
  exponent = 8,
  observedContracts = [],
  observedDecimals = 8,
  observedRepresentationType = "token",
  providerType = "crypto",
}: {
  readonly exponent?: number | null
  readonly observedContracts?: ReadonlyArray<string>
  readonly observedDecimals?: number | null
  readonly observedRepresentationType?: "token" | null
  readonly providerType?: "crypto" | "nft" | "unsupported" | null
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [canonicalAsset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)
    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (canonicalAsset === undefined || baseBlockchain === undefined) {
      return yield* Effect.die("Missing override tax calculation fixtures")
    }

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        naturalKey: `coinbase-rejected-${observedContracts.join("-") || "chainless"}`,
        currencyCode: "XYZ",
        exponent,
        providerType,
        retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create override provider asset fixture")
    }

    yield* db.insert(schema.providerAssetSourceUses).values({
      providerAssetRowId: providerAsset.id,
      sourceId,
      hasChainlessObservation:
        observedRepresentationType === null || observedContracts.length === 0,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: canonicalAsset.id,
      mappingStatus: "rejected",
      sourceNotes: "Rejected mapping retained for principal inclusion",
    })

    for (const [index, contractAddress] of observedContracts.entries()) {
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId,
          externalId: `override-coverage-transaction-${index}`,
          timestamp: new Date(`2025-06-0${index + 1}T10:00:00.000Z`),
          principalId,
        })
        .returning({ id: schema.transactions.id })

      if (transaction === undefined) {
        return yield* Effect.die("Failed to create override coverage transaction")
      }

      yield* db.insert(schema.providerTransfers).values({
        sourceId,
        transactionId: transaction.id,
        externalId: `override-coverage-transfer-${index}`,
        timestamp: new Date(`2025-06-0${index + 1}T10:00:00.000Z`),
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "external",
        toAccountRef: "coinbase-tax-account",
        providerAssetId: providerAsset.id,
        observedBlockchainId: baseBlockchain.id,
        observedRepresentationType,
        observedContractAddress: contractAddress,
        observedDecimals,
        amount: "100000000",
      })
    }

    return {
      blockchainId: baseBlockchain.id,
      providerAssetRowId: providerAsset.id,
    }
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertInclusionOverride = ({
  blockchainId,
  contractAddress,
  providerAssetRowId,
  replacementState = "included",
  replayFailedRecords = 0,
  replayStatus = "completed",
}: {
  readonly blockchainId?: string
  readonly contractAddress?: string
  readonly providerAssetRowId?: string
  readonly replacementState?: "included" | "excluded"
  readonly replayFailedRecords?: number
  readonly replayStatus?: "pending" | "failed" | "credit_required" | "completed" | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [override] = yield* db
      .insert(schema.principalAssetOverrides)
      .values({
        principalId,
        kind: "inclusion",
        targetKind: providerAssetRowId === undefined ? "representation" : "provider_asset",
        blockchainId: blockchainId ?? null,
        representationType: blockchainId === undefined ? null : "token",
        contractAddress: contractAddress ?? null,
        providerAssetRowId: providerAssetRowId ?? null,
        action: "set",
        inspectedSystemRevision: "tax-calculation-fixture",
        inspectedInclusionState: "excluded",
        inspectedInclusionReason: "taxmaxi_policy",
        replacementInclusionState: replacementState,
        actorId: userId,
        reason: "Include the reviewed asset in tax calculation",
      })
      .returning({
        id: schema.principalAssetOverrides.id,
        createdAt: schema.principalAssetOverrides.createdAt,
      })
    if (override === undefined) return yield* Effect.die("Failed to insert inclusion override")
    if (replayStatus !== null) {
      const [job] = yield* db
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode: "replay",
          status: replayStatus,
          createdAt: sql`(
            select ${schema.principalAssetOverrides.createdAt}
            from ${schema.principalAssetOverrides}
            where ${schema.principalAssetOverrides.id} = ${override.id}
          )`,
          progressDetails:
            replayStatus === "completed" ? { failedRecords: replayFailedRecords } : null,
          completedAt:
            replayStatus === "completed" ? new Date(override.createdAt.getTime() + 1) : null,
        })
        .returning({ id: schema.processingJobs.id })
      if (job === undefined) return yield* Effect.die("Failed to insert inclusion replay job")
      yield* db.insert(schema.principalAssetOverrideApplications).values({
        overrideId: override.id,
        sourceId,
        replayJobId: job.id,
        requiresReplay: true,
      })
    }
    return override.createdAt
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertIdentityOverride = ({
  blockchainId,
  contractAddress,
  providerAssetRowId,
}: {
  readonly blockchainId?: string
  readonly contractAddress?: string
  readonly providerAssetRowId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [asset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)
    if (asset === undefined) return yield* Effect.die("Missing identity override asset fixture")

    const [override] = yield* db
      .insert(schema.principalAssetOverrides)
      .values({
        principalId,
        kind: "identity",
        targetKind: providerAssetRowId === undefined ? "representation" : "provider_asset",
        blockchainId: blockchainId ?? null,
        representationType: blockchainId === undefined ? null : "token",
        contractAddress: contractAddress ?? null,
        providerAssetRowId: providerAssetRowId ?? null,
        action: "set",
        inspectedSystemRevision: "tax-calculation-identity-fixture",
        inspectedIdentityState: "unresolved",
        replacementAssetId: asset.id,
        actorId: userId,
        reason: "Use the reviewed identity for tax calculation",
      })
      .returning({
        id: schema.principalAssetOverrides.id,
        createdAt: schema.principalAssetOverrides.createdAt,
      })
    if (override === undefined) return yield* Effect.die("Failed to insert identity override")

    const [job] = yield* db
      .insert(schema.processingJobs)
      .values({
        sourceId,
        principalId,
        mode: "replay",
        status: "completed",
        progressDetails: { failedRecords: 0 },
        createdAt: sql`(
          select ${schema.principalAssetOverrides.createdAt}
          from ${schema.principalAssetOverrides}
          where ${schema.principalAssetOverrides.id} = ${override.id}
        )`,
        completedAt: new Date(override.createdAt.getTime() + 1),
      })
      .returning({ id: schema.processingJobs.id })
    if (job === undefined) return yield* Effect.die("Failed to insert identity replay job")
    yield* db.insert(schema.principalAssetOverrideApplications).values({
      overrideId: override.id,
      sourceId,
      replayJobId: job.id,
      requiresReplay: true,
    })
    return override
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertProviderlessExactObservation = ({
  contractAddress,
  observedDecimals,
}: {
  readonly contractAddress: string
  readonly observedDecimals: number | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [blockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)
    if (blockchain === undefined) return yield* Effect.die("Missing base blockchain")
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId,
        externalId: `providerless-tax-${contractAddress}`,
        timestamp: new Date("2025-06-12T10:00:00.000Z"),
        principalId,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
    yield* db.insert(schema.providerTransfers).values({
      sourceId,
      transactionId: transaction.id,
      externalId: `providerless-tax-transfer-${contractAddress}`,
      providerAssetId: null,
      timestamp: new Date("2025-06-12T10:00:00.000Z"),
      direction: "inbound",
      processingMode: "accounting_and_evidence",
      fromAccountRef: "external",
      toAccountRef: "coinbase-tax-account",
      observedBlockchainId: blockchain.id,
      observedRepresentationType: "token",
      observedContractAddress: contractAddress,
      observedDecimals,
      amount: "1",
    })
    return blockchain.id
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertDependentSources = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [coinbaseCex] = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)
    if (coinbaseCex === undefined) return yield* Effect.die("Missing dependent source CEX")

    const accounts = yield* db
      .insert(schema.cexAccount)
      .values(
        ["b", "c", "sibling"].map((suffix) => ({
          cexId: coinbaseCex.id,
          principalId,
          providerUserId: `dependent-user-${suffix}`,
          providerAccountId: `dependent-account-${suffix}`,
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scopes: "wallet:accounts:read wallet:transactions:read",
        }))
      )
      .returning({
        id: schema.cexAccount.id,
        providerAccountId: schema.cexAccount.providerAccountId,
      })
    const dependentSources = accounts.map((account) => ({
      providerAccountId: account.providerAccountId,
      insert: {
        id: crypto.randomUUID(),
        name: account.providerAccountId ?? "dependent-account",
        providerKey: "coinbase",
        sourceableType: "cex" as const,
        cexAccountId: account.id,
        principalId,
      },
    }))
    yield* db.insert(schema.sources).values(dependentSources.map(({ insert }) => insert))
    const sourceIds = new Map(
      dependentSources.map(
        ({ insert, providerAccountId }) => [providerAccountId, insert.id] as const
      )
    )
    const dependentSourceId = sourceIds.get("dependent-account-b")
    const transitiveSourceId = sourceIds.get("dependent-account-c")
    const siblingSourceId = sourceIds.get("dependent-account-sibling")
    if (
      dependentSourceId === undefined ||
      transitiveSourceId === undefined ||
      siblingSourceId === undefined
    ) {
      return yield* Effect.die("Failed to create dependent source fixtures")
    }
    return { dependentSourceId, transitiveSourceId, siblingSourceId }
  }).pipe(Effect.provide(context.TestPgClientLive))

const holdPendingOverrideReplayMutation = ({
  acquired,
  release,
}: {
  readonly acquired: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sourceInventoryLockQuery([sourceId]))
          const [representation] = yield* tx
            .select({
              assetId: schema.assetRepresentations.assetId,
              blockchainId: schema.assetRepresentations.blockchainId,
              contractAddress: schema.assetRepresentations.contractAddress,
              mintAddress: schema.assetRepresentations.mintAddress,
              type: schema.assetRepresentations.type,
            })
            .from(schema.assetRepresentations)
            .where(eq(schema.assetRepresentations.contractAddress, btcContractAddress))
            .limit(1)
          if (representation === undefined) {
            return yield* Effect.die("Missing tax race representation fixture")
          }
          const [override] = yield* tx
            .insert(schema.principalAssetOverrides)
            .values({
              principalId,
              kind: "identity",
              targetKind: "representation",
              blockchainId: representation.blockchainId,
              representationType: representation.type,
              contractAddress: representation.contractAddress,
              mintAddress: representation.mintAddress,
              action: "set",
              inspectedSystemRevision: "tax-race-system-revision",
              inspectedIdentityState: "resolved",
              inspectedAssetId: representation.assetId,
              replacementAssetId: representation.assetId,
              actorId: userId,
              reason: "Exercise the tax/replay inventory lock contract.",
            })
            .returning({ id: schema.principalAssetOverrides.id })
          const [job] = yield* tx
            .insert(schema.processingJobs)
            .values({
              sourceId,
              principalId,
              mode: "replay",
              status: "pending",
            })
            .returning({ id: schema.processingJobs.id })
          if (override === undefined || job === undefined) {
            return yield* Effect.die("Failed to seed tax race override replay")
          }
          yield* tx.insert(schema.principalAssetOverrideApplications).values({
            overrideId: override.id,
            sourceId,
            replayJobId: job.id,
            requiresReplay: true,
          })
          yield* tx.update(schema.disposalMatches).set({ gainLoss: "0.00" })
          yield* Deferred.succeed(acquired, undefined)
          yield* Deferred.await(release)
        })
      )
    })
  )

const holdTaxReadDependencyTableLock = ({
  acquired,
  release,
}: {
  readonly acquired: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(
            sql`lock table ${schema.providerAssetSourceUses} in access exclusive mode`
          )
          yield* Deferred.succeed(acquired, undefined)
          yield* Deferred.await(release)
        })
      )
    })
  )

await Effect.runPromise(context.recreateTestDatabase())

describe("TaxCalculationServiceLive", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      yield* seedTaxFixtures()
    }).pipe(Effect.runPromise)
  )

  it("returns deterministic yearly tax totals for taxable, tax-free, and income events", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tax = yield* calculateTax()
        expect(tax.year).toBe(2025)
        expect(tax.currency).toBe("EUR")
        expect(tax.calculationState).toBe("complete")
        expect(tax.unpricedEventCount).toBe(0)
        expect(tax.taxableGains).toBe(2000)
        expect(tax.taxableLosses).toBe(0)
        expect(tax.taxFreeGains).toBe(400)
        expect(tax.incomeTotal).toBe(700)
      })
    )
  })

  it("returns the complete old snapshot when tax owns the inventory lock before replay mutation", async () => {
    const tableLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseTableLock = await Effect.runPromise(Deferred.make<void>())
    const heldTableLock = holdTaxReadDependencyTableLock({
      acquired: tableLockAcquired,
      release: releaseTableLock,
    })
    await Effect.runPromise(Deferred.await(tableLockAcquired))

    const taxCalculation = Effect.runPromise(calculateTax())
    await context.waitForQueryBlockedOnLock({ queryIncludes: "provider_asset_source_uses" })

    const mutationLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseMutationLock = await Effect.runPromise(Deferred.make<void>())
    const mutation = holdPendingOverrideReplayMutation({
      acquired: mutationLockAcquired,
      release: releaseMutationLock,
    })
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })

    await Effect.runPromise(Deferred.succeed(releaseTableLock, undefined))
    const tax = await taxCalculation
    expect(tax).toMatchObject({ taxableGains: 2000, incomeTotal: 700 })

    await Effect.runPromise(Deferred.await(mutationLockAcquired))
    await Effect.runPromise(Deferred.succeed(releaseMutationLock, undefined))
    await Promise.all([heldTableLock, mutation])
  })

  it("returns pending instead of partial totals when replay mutation owns the inventory lock first", async () => {
    const mutationLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseMutationLock = await Effect.runPromise(Deferred.make<void>())
    const mutation = holdPendingOverrideReplayMutation({
      acquired: mutationLockAcquired,
      release: releaseMutationLock,
    })
    await Effect.runPromise(Deferred.await(mutationLockAcquired))

    const taxCalculation = Effect.runPromise(calculateTax().pipe(Effect.flip))
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })
    await Effect.runPromise(Deferred.succeed(releaseMutationLock, undefined))

    const [error] = await Promise.all([taxCalculation, mutation])
    expect(error).toMatchObject({
      _tag: "TaxCalculationPendingRecomputationError",
      pendingOverrideReplay: true,
    })
  })

  it("returns a partial calculation when income valuation data is incomplete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertIncompleteIncomeLeg()
        const tax = yield* calculateTax()
        expect(tax.calculationState).toBe("partial")
        expect(tax.unpricedEventCount).toBe(1)
        expect(tax.incomeTotal).toBe(700)
      })
    )
  })

  it("keeps disposal gains partial when their acquisition cost basis is unknown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.fifoLots)
          .set({ costBasisStatus: "pending_review" })
          .where(eq(schema.fifoLots.id, "00000000-0000-0000-0000-000000000401"))

        const tax = yield* calculateTax()
        expect(tax.calculationState).toBe("partial")
        expect(tax.unpricedEventCount).toBe(1)
        expect(tax.taxableGains).toBe(0)
        expect(tax.taxFreeGains).toBe(400)
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
  })

  it("fails with a typed error when the jurisdiction is unsupported", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* calculateTax({
          jurisdiction: "united-states",
        }).pipe(Effect.flip)

        expect(error._tag).toBe("UnsupportedJurisdictionError")
        if (error._tag === "UnsupportedJurisdictionError") {
          expect(error.jurisdiction).toBe("united-states")
        }
      })
    )
  })

  it("fails with a typed error when tax-visible values use an unsupported currency", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* updateIncomeLegCurrency("USD")
        const error = yield* calculateTax().pipe(Effect.flip)

        expect(error._tag).toBe("TaxCalculationUnsupportedCurrencyError")
        if (error._tag === "TaxCalculationUnsupportedCurrencyError") {
          expect(error.expectedCurrency).toBe("EUR")
          expect(error.actualCurrency).toBe("USD")
          expect(error.field).toContain("income leg")
        }
      })
    )
  })

  it("fails with SourceNotFoundError for an unknown source", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* calculateTax({
          sourceId: "00000000-0000-0000-0000-000000000999",
        }).pipe(Effect.flip)

        expect(error._tag).toBe("SourceNotFoundError")
        if (error._tag === "SourceNotFoundError") {
          expect(error.sourceId).toBe("00000000-0000-0000-0000-000000000999")
        }
      })
    )
  })

  it("fails with a pending error instead of a zero total when a provider observation is unresolved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertUnresolvedProviderAssetSourceUse()
        const error = yield* calculateTax().pipe(Effect.flip)

        expect(error._tag).toBe("TaxCalculationPendingObservationsError")
        if (error._tag === "TaxCalculationPendingObservationsError") {
          expect(error.sourceId).toBe(sourceId)
          expect(error.pendingObservationCount).toBe(1)
          expect(error.blockingObservations).toEqual([
            { provider: "coinbase", currencyCode: "XYZ" },
          ])
        }
      })
    )
  })

  it("fails with a pending error when an observation's mapping was rejected", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // A rejected mapping still keeps its transactions out of legs and
        // FIFO, so totals without it would be silently short.
        yield* insertUnresolvedProviderAssetSourceUse({ mappingStatus: "rejected" })
        const error = yield* calculateTax().pipe(Effect.flip)

        expect(error._tag).toBe("TaxCalculationPendingObservationsError")
        if (error._tag === "TaxCalculationPendingObservationsError") {
          expect(error.pendingObservationCount).toBe(1)
          expect(error.blockingObservations).toEqual([
            { provider: "coinbase", currencyCode: "XYZ" },
          ])
        }
      })
    )
  })

  it("blocks an excluded observation until its rematerialization replay completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* insertExcludedProviderAssetSourceUseWithRematerialization()
        const db = yield* drizzle

        // The stored rebuild status is the authority: while the row is
        // unfinished, no job status alone unblocks the calculation. The job
        // lifecycle writes the row status when replays finish, which
        // source-sync-job-repository tests cover.
        for (const status of ["pending", "processing", "failed", "completed"] as const) {
          yield* db
            .update(schema.processingJobs)
            .set({ status })
            .where(eq(schema.processingJobs.id, fixture.jobId))

          const error = yield* calculateTax().pipe(Effect.flip)
          expect(error._tag).toBe("TaxCalculationPendingObservationsError")
        }

        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "complete" })
          .where(eq(schema.assetDecisionRematerializations.decisionId, fixture.decisionId))

        const taxAfterCompletedRebuild = yield* calculateTax()
        expect(taxAfterCompletedRebuild.taxableGains).toBe(2000)

        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "operator_attention" })
          .where(eq(schema.assetDecisionRematerializations.decisionId, fixture.decisionId))
        const operatorAttentionError = yield* calculateTax().pipe(Effect.flip)
        expect(operatorAttentionError._tag).toBe("TaxCalculationPendingObservationsError")

        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "complete" })
          .where(eq(schema.assetDecisionRematerializations.decisionId, fixture.decisionId))

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(2000)
        expect(tax.incomeTotal).toBe(700)

        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "operator_attention" })
          .where(eq(schema.assetDecisionRematerializations.decisionId, fixture.decisionId))
        yield* db
          .update(schema.assetResolutionDecisions)
          .set({ status: "superseded" })
          .where(eq(schema.assetResolutionDecisions.id, fixture.decisionId))
        const [activeDecision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 1,
            policyRevision: "human:test:latest",
            outcome: "excluded",
            status: "active",
            supersedesDecisionId: fixture.decisionId,
            reason: "not_economic_activity",
            actor: userId,
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        const [completedJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId,
            principalId,
            mode: "replay",
            status: "completed",
          })
          .returning({ id: schema.processingJobs.id })
        if (activeDecision === undefined || completedJob === undefined) {
          return yield* Effect.die("Failed to create active exclusion replay fixture")
        }
        yield* db.insert(schema.assetDecisionRematerializations).values({
          decisionId: activeDecision.id,
          sourceId,
          processingJobId: completedJob.id,
          status: "complete",
        })

        const taxAfterSupersession = yield* calculateTax()
        expect(taxAfterSupersession.taxableGains).toBe(2000)

        const [approvedAsset] = yield* db
          .insert(schema.assets)
          .values({ name: "Approved replay asset", symbol: "APR", type: "fungible" })
          .returning({ id: schema.assets.id })
        if (approvedAsset === undefined) {
          return yield* Effect.die("Failed to create approved replay asset")
        }
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingStatus: "approved",
            canonicalAssetId: approvedAsset.id,
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        yield* db
          .update(schema.assetResolutionDecisions)
          .set({ outcome: "identity", assetId: approvedAsset.id })
          .where(eq(schema.assetResolutionDecisions.id, activeDecision.id))
        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "pending" })
          .where(eq(schema.assetDecisionRematerializations.decisionId, activeDecision.id))

        const approvedReplayError = yield* calculateTax().pipe(Effect.flip)
        expect(approvedReplayError._tag).toBe("TaxCalculationPendingObservationsError")
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
  })

  it("allows an included override to clear a rejected mapping with a canonical asset", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("keeps an included chainless exclusion pending while identity is unresolved", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "excluded", canonicalAssetId: null })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("allows an included override when the provider type is unknown", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture({ providerType: null }))
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("blocks tax when later provider evidence makes an identity override type-incompatible", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture({ providerType: null }))
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ providerType: "nft", evidenceRevision: 2 })
          .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("allows a provider-asset identity override without an inclusion override", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("returns partial tax after an identity override clears mapping review but valuation is missing", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(insertIncompleteIncomeLeg())

    const tax = await Effect.runPromise(calculateTax())

    expect(tax).toMatchObject({
      calculationState: "partial",
      unpricedEventCount: 1,
      taxableGains: 2000,
    })
  })

  it("keeps a provider identity override blocked when its exponent is missing", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture({ exponent: null }))
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("keeps an approved chainless mapping blocked when its exponent is missing", async () => {
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [asset] = yield* db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.symbol, "BTC"))
          .limit(1)
        if (asset === undefined) return yield* Effect.die("Missing Bitcoin fixture")
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            naturalKey: "approved-missing-exponent",
            currencyCode: "AMX",
            exponent: null,
            providerType: "crypto",
            retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to seed approved provider asset")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          canonicalAssetId: asset.id,
          mappingStatus: "approved",
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: providerAsset.id,
          sourceId,
          hasChainlessObservation: true,
        })
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("keeps a provider identity override blocked for an unsupported asset type", async () => {
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ providerType: "unsupported" })
    )
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("keeps an active provider identity override blocked after fiat reclassification", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingKind: "fiat",
            mappingStatus: "approved",
            canonicalAssetId: null,
            canonicalFiatCurrency: "EUR",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("stops using a withdrawn provider identity override", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    const override = await Effect.runPromise(
      insertIdentityOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.principalAssetOverrides).values({
          principalId,
          kind: "identity",
          targetKind: "provider_asset",
          providerAssetRowId: fixture.providerAssetRowId,
          action: "withdraw",
          inspectedSystemRevision: "tax-calculation-identity-withdrawal-fixture",
          inspectedIdentityState: "unresolved",
          actorId: userId,
          reason: "Withdraw the reviewed identity from tax calculation",
          supersedesOverrideId: override.id,
          createdAt: new Date(override.createdAt.getTime() + 1),
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("allows a representation identity override without an inclusion override", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000042"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [contractAddress] })
    )
    await Effect.runPromise(
      insertIdentityOverride({
        blockchainId: fixture.blockchainId,
        contractAddress,
      })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("keeps a representation identity override blocked when decimals are missing", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000043"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({
        observedContracts: [contractAddress],
        observedDecimals: null,
      })
    )
    await Effect.runPromise(
      insertIdentityOverride({
        blockchainId: fixture.blockchainId,
        contractAddress,
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("counts a providerless exact observation with missing decimals", async () => {
    await Effect.runPromise(
      insertProviderlessExactObservation({
        contractAddress: "0x0000000000000000000000000000000000000044",
        observedDecimals: null,
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error).toMatchObject({
      _tag: "TaxCalculationPendingObservationsError",
      pendingObservationCount: 1,
      blockingObservations: [],
    })
  })

  it("settles a providerless exact observation with an active exclusion", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000047"
    const blockchainId = await Effect.runPromise(
      insertProviderlessExactObservation({ contractAddress, observedDecimals: 8 })
    )
    await Effect.runPromise(
      insertInclusionOverride({
        blockchainId,
        contractAddress,
        replacementState: "excluded",
      })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("keeps an included providerless exclusion pending while identity is unresolved", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000050"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [contractAddress] })
    )
    await Effect.runPromise(
      insertProviderlessExactObservation({ contractAddress, observedDecimals: 8 })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "excluded", canonicalAssetId: null })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        yield* db
          .delete(schema.providerAssetSourceUses)
          .where(eq(schema.providerAssetSourceUses.providerAssetRowId, fixture.providerAssetRowId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await Effect.runPromise(
      insertInclusionOverride({ blockchainId: fixture.blockchainId, contractAddress })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error).toMatchObject({
      _tag: "TaxCalculationPendingObservationsError",
      pendingObservationCount: 1,
    })
  })

  it("does not use another principal's exclusion for a providerless exact observation", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000048"
    const blockchainId = await Effect.runPromise(
      insertProviderlessExactObservation({ contractAddress, observedDecimals: 8 })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const otherUserId = "00000000-0000-0000-0000-000000000048"
        const otherPrincipalId = "00000000-0000-0000-0000-000000000148"
        yield* db.insert(schema.users).values({
          id: otherUserId,
          email: "other-providerless-tax@example.com",
          emailVerified: true,
        })
        yield* db.insert(schema.principals).values({
          id: otherPrincipalId,
          kind: "user",
          userId: otherUserId,
        })
        yield* db.insert(schema.principalAssetOverrides).values({
          principalId: otherPrincipalId,
          kind: "inclusion",
          targetKind: "representation",
          blockchainId,
          representationType: "token",
          contractAddress,
          action: "set",
          inspectedSystemRevision: "other-principal-providerless-fixture",
          inspectedInclusionState: "blocked",
          inspectedInclusionReason: "taxmaxi_policy",
          replacementInclusionState: "excluded",
          actorId: otherUserId,
          reason: "Exclude this observation only for the other principal",
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error).toMatchObject({
      _tag: "TaxCalculationPendingObservationsError",
      pendingObservationCount: 1,
    })
  })

  it("keeps conflicting exact retained identities in tax blockers", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000045"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [contractAddress] })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [otherAsset] = yield* db
          .insert(schema.assets)
          .values({ name: "Conflicting tax asset", symbol: "CTA", type: "fungible" })
          .returning({ id: schema.assets.id })
        const [otherProviderAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "helius",
            providerAssetId: "conflicting-tax-provider-asset",
            currencyCode: "CTA",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2025-06-02T00:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (otherAsset === undefined || otherProviderAsset === undefined) {
          return yield* Effect.die("Failed to seed conflicting tax asset")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: otherProviderAsset.id,
          mappingKind: "asset",
          mappingStatus: "approved",
          canonicalAssetId: otherAsset.id,
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: otherProviderAsset.id,
          sourceId,
          hasChainlessObservation: false,
        })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId,
            externalId: "conflicting-tax-transaction",
            timestamp: new Date("2025-06-02T10:00:00.000Z"),
            principalId,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        yield* db.insert(schema.providerTransfers).values({
          sourceId,
          transactionId: transaction.id,
          externalId: "conflicting-tax-transfer",
          providerAssetId: otherProviderAsset.id,
          timestamp: new Date("2025-06-02T10:00:00.000Z"),
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "external",
          toAccountRef: "coinbase-tax-account",
          observedBlockchainId: fixture.blockchainId,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedDecimals: 8,
          amount: "1",
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await Effect.runPromise(
      insertInclusionOverride({ blockchainId: fixture.blockchainId, contractAddress })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("keeps an included exact exclusion pending while identity is unresolved", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000049"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [contractAddress] })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "excluded", canonicalAssetId: null })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await Effect.runPromise(
      insertInclusionOverride({ blockchainId: fixture.blockchainId, contractAddress })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
  })

  it("accepts agreeing approved and rejected exact mappings without an override", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000046"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [contractAddress] })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [retainedMapping] = yield* db
          .select({ assetId: schema.providerAssetMappings.canonicalAssetId })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        if (retainedMapping?.assetId === null || retainedMapping?.assetId === undefined) {
          return yield* Effect.die("Missing retained mapping")
        }
        const [approvedProviderAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "helius",
            providerAssetId: "agreeing-approved-tax-asset",
            currencyCode: "AAT",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2025-06-03T00:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (approvedProviderAsset === undefined) {
          return yield* Effect.die("Failed to seed approved provider asset")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: approvedProviderAsset.id,
          mappingKind: "asset",
          mappingStatus: "approved",
          canonicalAssetId: retainedMapping.assetId,
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: approvedProviderAsset.id,
          sourceId,
          hasChainlessObservation: false,
        })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId,
            externalId: "agreeing-approved-tax-transaction",
            timestamp: new Date("2025-06-03T10:00:00.000Z"),
            principalId,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        yield* db.insert(schema.providerTransfers).values({
          sourceId,
          transactionId: transaction.id,
          externalId: "agreeing-approved-tax-transfer",
          providerAssetId: approvedProviderAsset.id,
          timestamp: new Date("2025-06-03T10:00:00.000Z"),
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "external",
          toAccountRef: "coinbase-tax-account",
          observedBlockchainId: fixture.blockchainId,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedDecimals: 8,
          amount: "1",
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("keeps a non-asset transaction review blocking after an asset override", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(
      insertPendingTransactionReview({ matchedLayer: "solana_transfer_evidence" })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error).toMatchObject({
      _tag: "TaxCalculationPendingRecomputationError",
      pendingOverrideReplay: false,
      pendingTransactionReview: true,
    })
  })

  it("does not re-block an override for a purely asset-mapping transaction review", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(
      insertPendingTransactionReview({ matchedLayer: "provider_asset_mapping" })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("allows a reviewed transaction whose accounting legs were derived", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    await Effect.runPromise(
      insertPendingTransactionReview({
        matchedLayer: "transfer_reconciliation",
        withAccountingLeg: true,
      })
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it.each(["pending", "failed", "credit_required"] as const)(
    "waits while an override replay is %s",
    async (replayStatus) => {
      const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
      await Effect.runPromise(
        insertInclusionOverride({
          providerAssetRowId: fixture.providerAssetRowId,
          replayStatus,
        })
      )

      const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

      expect(error).toMatchObject({
        _tag: "TaxCalculationPendingRecomputationError",
        pendingOverrideReplay: true,
        pendingTransactionReview: false,
      })
    }
  )

  it("keeps a FIFO owner pending until its transitive dependent override replay completes", async () => {
    const dependentSourceId = "00000000-0000-0000-0000-000000000299"
    const transitiveSourceId = "00000000-0000-0000-0000-000000000298"
    const independentSourceId = "00000000-0000-0000-0000-000000000297"
    const dependency = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
          .limit(1)
        if (blockchain === undefined) return yield* Effect.die("Missing base blockchain")

        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            address: "0x0000000000000000000000000000000000000299",
            type: "evm",
            name: "Dependent tax replay source",
            principalId,
          })
          .returning({ id: schema.addresses.id })
        if (address === undefined) return yield* Effect.die("Failed to create dependent address")

        yield* db.insert(schema.sources).values({
          id: dependentSourceId,
          principalId,
          name: "Dependent tax replay source",
          providerKey: "base-rpc",
          sourceableType: "onchain",
          addressId: address.id,
        })
        const [transitiveAddress] = yield* db
          .insert(schema.addresses)
          .values({
            address: "0x0000000000000000000000000000000000000298",
            type: "evm",
            name: "Transitive tax replay source",
            principalId,
          })
          .returning({ id: schema.addresses.id })
        if (transitiveAddress === undefined) {
          return yield* Effect.die("Failed to create transitive address")
        }
        yield* db.insert(schema.sources).values({
          id: transitiveSourceId,
          principalId,
          name: "Transitive tax replay source",
          providerKey: "base-rpc",
          sourceableType: "onchain",
          addressId: transitiveAddress.id,
        })
        const [independentAddress] = yield* db
          .insert(schema.addresses)
          .values({
            address: "0x0000000000000000000000000000000000000297",
            type: "evm",
            name: "Independent tax replay source",
            principalId,
          })
          .returning({ id: schema.addresses.id })
        if (independentAddress === undefined) {
          return yield* Effect.die("Failed to create independent address")
        }
        yield* db.insert(schema.sources).values({
          id: independentSourceId,
          principalId,
          name: "Independent tax replay source",
          providerKey: "base-rpc",
          sourceableType: "onchain",
          addressId: independentAddress.id,
        })
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId,
            kind: "identity",
            targetKind: "representation",
            blockchainId: blockchain.id,
            representationType: "token",
            contractAddress: btcContractAddress,
            action: "set",
            inspectedSystemRevision: "dependent-tax-replay",
            inspectedIdentityState: "resolved",
            inspectedAssetId: sql`(
              select ${schema.assets.id}
              from ${schema.assets}
              where ${schema.assets.symbol} = 'BTC'
              limit 1
            )`,
            replacementAssetId: sql`(
              select ${schema.assets.id}
              from ${schema.assets}
              where ${schema.assets.symbol} = 'BTC'
              limit 1
            )`,
            actorId: userId,
            reason: "Keep owner tax results pending until dependent replay finishes.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        const jobs = yield* db
          .insert(schema.processingJobs)
          .values([
            {
              sourceId,
              principalId,
              mode: "replay" as const,
              status: "completed" as const,
              progressDetails: { failedRecords: 0 },
            },
            {
              sourceId: dependentSourceId,
              principalId,
              mode: "replay" as const,
              status: "completed" as const,
              progressDetails: { failedRecords: 0 },
            },
            {
              sourceId: transitiveSourceId,
              principalId,
              mode: "replay" as const,
              status: "pending" as const,
            },
            {
              sourceId: independentSourceId,
              principalId,
              mode: "replay" as const,
              status: "pending" as const,
            },
          ])
          .returning({ id: schema.processingJobs.id, sourceId: schema.processingJobs.sourceId })
        if (override === undefined || jobs.length !== 4) {
          return yield* Effect.die("Failed to seed dependent replay applications")
        }
        const jobBySourceId = new Map(jobs.map((job) => [job.sourceId, job.id]))
        const ownerJobId = jobBySourceId.get(sourceId)
        const dependentJobId = jobBySourceId.get(dependentSourceId)
        const transitiveJobId = jobBySourceId.get(transitiveSourceId)
        const independentJobId = jobBySourceId.get(independentSourceId)
        if (
          ownerJobId === undefined ||
          dependentJobId === undefined ||
          transitiveJobId === undefined ||
          independentJobId === undefined
        ) {
          return yield* Effect.die("Failed to identify dependent replay jobs")
        }
        yield* db.insert(schema.principalAssetOverrideApplications).values([
          {
            overrideId: override.id,
            sourceId,
            replayJobId: ownerJobId,
            dependsOnSourceIds: [],
          },
          {
            overrideId: override.id,
            sourceId: dependentSourceId,
            replayJobId: dependentJobId,
            dependsOnSourceIds: [sourceId],
          },
          {
            overrideId: override.id,
            sourceId: transitiveSourceId,
            replayJobId: transitiveJobId,
            dependsOnSourceIds: [dependentSourceId],
          },
          {
            overrideId: override.id,
            sourceId: independentSourceId,
            replayJobId: independentJobId,
            dependsOnSourceIds: [],
          },
        ])
        return { transitiveJobId }
      })
    )

    const pending = await Effect.runPromise(calculateTax().pipe(Effect.flip))
    expect(pending).toMatchObject({
      _tag: "TaxCalculationPendingRecomputationError",
      pendingOverrideReplay: true,
    })

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 0 } })
          .where(eq(schema.processingJobs.id, dependency.transitiveJobId))
      })
    )

    const tax = await Effect.runPromise(calculateTax())
    expect(tax.taxableGains).toBe(2000)
  })

  it("serializes tax input reads with source inventory mutations", async () => {
    const lockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseLock = await Effect.runPromise(Deferred.make<void>())
    const heldInventoryLock = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sourceInventoryLockQuery([sourceId]))
            yield* Deferred.succeed(lockAcquired, undefined)
            yield* Deferred.await(releaseLock)
          })
        )
      })
    )
    await Effect.runPromise(Deferred.await(lockAcquired))

    const calculation = Effect.runPromise(calculateTax())
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory" })
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
    const [, tax] = await Promise.all([heldInventoryLock, calculation])

    expect(tax.taxableGains).toBe(2000)
    expect(tax.incomeTotal).toBe(700)
  })

  it("waits when a completed override replay contains failed records", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({
        providerAssetRowId: fixture.providerAssetRowId,
        replayFailedRecords: 1,
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingRecomputationError")
  })

  it("follows direct and transitive replay dependencies without blocking on siblings", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
    )
    const { dependentSourceId, transitiveSourceId, siblingSourceId } =
      await Effect.runPromise(insertDependentSources())
    const jobIds = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [override] = yield* db
          .select({ id: schema.principalAssetOverrides.id })
          .from(schema.principalAssetOverrides)
          .limit(1)
        if (override === undefined) return yield* Effect.die("Missing replay closure override")
        const jobs = yield* db
          .insert(schema.processingJobs)
          .values([
            {
              sourceId: dependentSourceId,
              principalId,
              mode: "replay" as const,
              status: "completed" as const,
              progressDetails: { failedRecords: 0 },
            },
            {
              sourceId: transitiveSourceId,
              principalId,
              mode: "replay" as const,
              status: "pending" as const,
            },
            {
              sourceId: siblingSourceId,
              principalId,
              mode: "replay" as const,
              status: "pending" as const,
            },
          ])
          .returning({ id: schema.processingJobs.id, sourceId: schema.processingJobs.sourceId })
        const jobIdBySource = new Map(jobs.map((job) => [job.sourceId, job.id] as const))
        yield* db.insert(schema.principalAssetOverrideApplications).values([
          {
            overrideId: override.id,
            sourceId: dependentSourceId,
            replayJobId: jobIdBySource.get(dependentSourceId),
            dependsOnSourceIds: [sourceId],
          },
          {
            overrideId: override.id,
            sourceId: transitiveSourceId,
            replayJobId: jobIdBySource.get(transitiveSourceId),
            dependsOnSourceIds: [dependentSourceId],
          },
          {
            overrideId: override.id,
            sourceId: siblingSourceId,
            replayJobId: jobIdBySource.get(siblingSourceId),
            dependsOnSourceIds: [],
          },
        ])
        return {
          dependentJobId: jobIdBySource.get(dependentSourceId),
          transitiveJobId: jobIdBySource.get(transitiveSourceId),
        }
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    await expect(Effect.runPromise(calculateTax().pipe(Effect.flip))).resolves.toMatchObject({
      _tag: "TaxCalculationPendingRecomputationError",
      pendingOverrideReplay: true,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        if (jobIds.transitiveJobId === undefined) return yield* Effect.die("Missing transitive job")
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 0 } })
          .where(eq(schema.processingJobs.id, jobIds.transitiveJobId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await expect(Effect.runPromise(calculateTax())).resolves.toMatchObject({ taxableGains: 2000 })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        if (jobIds.dependentJobId === undefined) return yield* Effect.die("Missing dependent job")
        const [retryJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: dependentSourceId,
            principalId,
            mode: "replay",
            status: "failed",
          })
          .returning({ id: schema.processingJobs.id })
        if (retryJob === undefined) return yield* Effect.die("Missing repointed retry job")
        yield* db
          .update(schema.principalAssetOverrideApplications)
          .set({ replayJobId: retryJob.id })
          .where(eq(schema.principalAssetOverrideApplications.sourceId, dependentSourceId))
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await expect(Effect.runPromise(calculateTax().pipe(Effect.flip))).resolves.toMatchObject({
      _tag: "TaxCalculationPendingRecomputationError",
      pendingOverrideReplay: true,
    })
  })

  it("keeps representation replay pending after transaction evidence is deleted", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000099"
    const blockchainId = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
          .limit(1)

        if (blockchain === undefined) {
          return yield* Effect.die("Missing durable representation blockchain fixture")
        }

        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId,
            externalId: "representation-replay-deletion",
            timestamp: new Date("2025-06-10T10:00:00.000Z"),
            principalId,
          })
          .returning({ id: schema.transactions.id })

        if (transaction === undefined) {
          return yield* Effect.die("Failed to create representation replay transaction fixture")
        }

        yield* db.insert(schema.providerTransfers).values({
          sourceId,
          transactionId: transaction.id,
          externalId: "representation-replay-deletion-transfer",
          timestamp: new Date("2025-06-10T10:00:00.000Z"),
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "external",
          toAccountRef: "coinbase-tax-account",
          observedBlockchainId: blockchain.id,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedDecimals: 8,
          amount: "100000000",
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId,
          blockchainId: blockchain.id,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })

        return blockchain.id
      }).pipe(Effect.provide(context.TestPgClientLive))
    )
    await Effect.runPromise(
      insertInclusionOverride({
        blockchainId,
        contractAddress,
        replayStatus: "pending",
      })
    )
    const evidenceAfterDeletion = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.externalId, "representation-replay-deletion"))

        const providerTransfers = yield* db
          .select({ id: schema.providerTransfers.id })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.externalId, "representation-replay-deletion-transfer"))
        const representationUses = yield* db
          .select({ id: schema.sourceRepresentationUses.id })
          .from(schema.sourceRepresentationUses)
          .where(eq(schema.sourceRepresentationUses.contractAddress, contractAddress))

        return {
          providerTransferCount: providerTransfers.length,
          representationUseCount: representationUses.length,
        }
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    expect(evidenceAfterDeletion).toEqual({
      providerTransferCount: 0,
      representationUseCount: 1,
    })

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingRecomputationError")
  })

  it("does not treat a replay started before the override as applying it", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    const overrideCreatedAt = await Effect.runPromise(
      insertInclusionOverride({
        providerAssetRowId: fixture.providerAssetRowId,
        replayStatus: "pending",
      })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "sync",
          status: "completed",
          progressDetails: { failedRecords: 0 },
          createdAt: new Date(overrideCreatedAt.getTime() - 1),
          completedAt: new Date(overrideCreatedAt.getTime() + 2),
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingRecomputationError")
  })

  it("accepts the completed sync that first records source use after the override", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    const overrideCreatedAt = await Effect.runPromise(
      insertInclusionOverride({
        providerAssetRowId: fixture.providerAssetRowId,
        replayStatus: null,
      })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const evidenceCreatedAt = new Date(overrideCreatedAt.getTime() + 1)
        yield* db
          .update(schema.providerAssetSourceUses)
          .set({ createdAt: evidenceCreatedAt })
          .where(
            and(
              eq(schema.providerAssetSourceUses.sourceId, sourceId),
              eq(schema.providerAssetSourceUses.providerAssetRowId, fixture.providerAssetRowId)
            )
          )
        const [override] = yield* db
          .select({ id: schema.principalAssetOverrides.id })
          .from(schema.principalAssetOverrides)
          .limit(1)
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId,
            principalId,
            mode: "sync",
            status: "completed",
            progressDetails: { failedRecords: 0 },
            createdAt: new Date(overrideCreatedAt.getTime() - 1),
            completedAt: new Date(overrideCreatedAt.getTime() + 2),
          })
          .returning({ id: schema.processingJobs.id })
        if (override === undefined || job === undefined) {
          return yield* Effect.die("Failed to create late override application fixture")
        }
        yield* db.insert(schema.principalAssetOverrideApplications).values({
          overrideId: override.id,
          sourceId,
          replayJobId: job.id,
          requiresReplay: false,
          createdAt: new Date(overrideCreatedAt.getTime() + 2),
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("keeps tax pending while a source job can still change its inputs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "sync",
          status: "processing",
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingRecomputationError")
  })

  it("keeps a provider observation pending until every exact representation is included", async () => {
    const firstContract = "0x0000000000000000000000000000000000000001"
    const secondContract = "0x0000000000000000000000000000000000000002"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({ observedContracts: [firstContract, secondContract] })
    )

    await Effect.runPromise(
      insertInclusionOverride({
        blockchainId: fixture.blockchainId,
        contractAddress: firstContract,
      })
    )

    const partialCoverageError = await Effect.runPromise(calculateTax().pipe(Effect.flip))
    expect(partialCoverageError._tag).toBe("TaxCalculationPendingObservationsError")

    await Effect.runPromise(
      insertInclusionOverride({
        blockchainId: fixture.blockchainId,
        contractAddress: secondContract,
      })
    )

    const tax = await Effect.runPromise(calculateTax())
    expect(tax.taxableGains).toBe(2000)
  })

  it("covers an unknown-type observation through its provider-asset identity", async () => {
    const contractAddress = "0x0000000000000000000000000000000000000003"
    const fixture = await Effect.runPromise(
      insertRejectedOverrideFixture({
        observedContracts: [contractAddress],
        observedRepresentationType: null,
      })
    )

    await Effect.runPromise(
      insertInclusionOverride({
        providerAssetRowId: fixture.providerAssetRowId,
      })
    )

    const tax = await Effect.runPromise(calculateTax())
    expect(tax.taxableGains).toBe(2000)
  })

  it("returns zero totals when the selected year has no disposals or income", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tax = yield* calculateTax({
          year: 2024,
        })

        expect(tax.year).toBe(2024)
        expect(tax.currency).toBe("EUR")
        expect(tax.taxableGains).toBe(0)
        expect(tax.taxableLosses).toBe(0)
        expect(tax.taxFreeGains).toBe(0)
        expect(tax.incomeTotal).toBe(0)
      })
    )
  })
})
