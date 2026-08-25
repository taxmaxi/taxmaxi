import { and, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import { TaxCalculationServiceLive } from "../src/layers/TaxCalculationServiceLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
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

const insertExcludedProviderAssetSourceUse = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const exclusionRecordedAt = new Date("2025-06-01T00:00:00.000Z")

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "helius-solana",
        naturalKey: "helius-excluded-asset",
        currencyCode: "SPAM",
        retrievedAt: exclusionRecordedAt,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create excluded provider asset fixture")
    }

    yield* db.insert(schema.providerAssetSourceUses).values({
      providerAssetRowId: providerAsset.id,
      sourceId,
      createdAt: exclusionRecordedAt,
      updatedAt: exclusionRecordedAt,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: null,
      mappingStatus: "excluded",
      sourceNotes: "Tax calculation exclusion replay fixture",
      createdAt: exclusionRecordedAt,
      updatedAt: exclusionRecordedAt,
    })

    return { exclusionRecordedAt, providerAssetRowId: providerAsset.id }
  }).pipe(Effect.provide(context.TestPgClientLive))

const insertRejectedOverrideFixture = ({
  observedContracts = [],
  observedRepresentationType = "token",
  providerType = "crypto",
}: {
  readonly observedContracts?: ReadonlyArray<string>
  readonly observedRepresentationType?: "token" | null
  readonly providerType?: "crypto" | null
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
        exponent: 8,
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
        observedDecimals: 8,
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
  replayFailedRecords = 0,
  replayStatus = "completed",
}: {
  readonly blockchainId?: string
  readonly contractAddress?: string
  readonly providerAssetRowId?: string
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
        replacementInclusionState: "included",
        actorId: userId,
        reason: "Include the reviewed asset in tax calculation",
      })
      .returning({
        id: schema.principalAssetOverrides.id,
        createdAt: schema.principalAssetOverrides.createdAt,
      })
    if (override === undefined) return yield* Effect.die("Failed to insert inclusion override")
    if (replayStatus !== null) {
      yield* db.insert(schema.processingJobs).values({
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
    }
    return override.createdAt
  }).pipe(Effect.provide(context.TestPgClientLive))

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
        expect(tax.taxableGains).toBe(2000)
        expect(tax.taxableLosses).toBe(0)
        expect(tax.taxFreeGains).toBe(400)
        expect(tax.incomeTotal).toBe(700)
      })
    )
  })

  it("fails with an actionable typed error when income valuation data is incomplete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertIncompleteIncomeLeg()
        const error = yield* calculateTax().pipe(Effect.flip)
        expect(error._tag).toBe("TaxCalculationIncompleteDataError")
        if (error._tag === "TaxCalculationIncompleteDataError") {
          expect(error.field).toContain("income leg")
          expect(error.reason).toBe("missing fiat currency")
        }
      })
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

  it("keeps an excluded observation pending until a post-exclusion replay succeeds", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "replay",
          status: "completed",
          createdAt: new Date("2025-05-31T00:00:00.000Z"),
          updatedAt: new Date("2025-05-31T00:01:00.000Z"),
          completedAt: new Date("2025-05-31T00:01:00.000Z"),
        })

        const { exclusionRecordedAt, providerAssetRowId } =
          yield* insertExcludedProviderAssetSourceUse()
        const [replayJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId,
            principalId,
            mode: "replay",
            status: "pending",
            createdAt: exclusionRecordedAt,
            updatedAt: exclusionRecordedAt,
          })
          .returning({ id: schema.processingJobs.id })

        if (replayJob === undefined) {
          return yield* Effect.die("Failed to create exclusion replay fixture")
        }

        const pendingReplay = yield* calculateTax().pipe(Effect.flip)
        expect(pendingReplay._tag).toBe("TaxCalculationPendingObservationsError")

        yield* db
          .update(schema.processingJobs)
          .set({
            status: "failed",
            completedAt: new Date("2025-06-01T00:02:00.000Z"),
            updatedAt: new Date("2025-06-01T00:02:00.000Z"),
          })
          .where(eq(schema.processingJobs.id, replayJob.id))

        const failedReplay = yield* calculateTax().pipe(Effect.flip)
        expect(failedReplay._tag).toBe("TaxCalculationPendingObservationsError")

        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "replay",
          status: "completed",
          createdAt: new Date("2025-06-01T00:03:00.000Z"),
          updatedAt: new Date("2025-06-01T00:04:00.000Z"),
          completedAt: new Date("2025-06-01T00:04:00.000Z"),
        })

        yield* db
          .update(schema.providerAssetSourceUses)
          .set({ updatedAt: new Date("2025-06-01T00:05:00.000Z") })
          .where(eq(schema.providerAssetSourceUses.sourceId, sourceId))

        const lateSourceUse = yield* calculateTax().pipe(Effect.flip)
        expect(lateSourceUse._tag).toBe("TaxCalculationPendingObservationsError")

        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "replay",
          status: "completed",
          createdAt: new Date("2025-06-01T00:06:00.000Z"),
          updatedAt: new Date("2025-06-01T00:07:00.000Z"),
          completedAt: new Date("2025-06-01T00:07:00.000Z"),
        })

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(2000)

        const [representation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            assetId: schema.assetRepresentations.assetId,
          })
          .from(schema.assetRepresentations)
          .limit(1)
        if (representation === undefined) {
          return yield* Effect.die("Missing asset representation fixture")
        }

        const approvalRecordedAt = new Date("2025-06-01T00:08:00.000Z")
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingStatus: "approved",
            canonicalAssetId: representation.assetId,
            assetRepresentationId: representation.id,
            updatedAt: approvalRecordedAt,
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        yield* db.insert(schema.assetResolutionDecisions).values({
          providerAssetRowId,
          evidenceRevision: 1,
          policyRevision: "test-policy",
          outcome: "attach",
          assetId: representation.assetId,
          assetRepresentationId: representation.id,
          reason: "manual_exclusion_reversal",
          actor: "test",
          createdAt: approvalRecordedAt,
        })

        const pendingReversalReplay = yield* calculateTax().pipe(Effect.flip)
        expect(pendingReversalReplay._tag).toBe("TaxCalculationPendingObservationsError")

        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "replay",
          status: "completed",
          createdAt: new Date("2025-06-01T00:09:00.000Z"),
          updatedAt: new Date("2025-06-01T00:10:00.000Z"),
          completedAt: new Date("2025-06-01T00:10:00.000Z"),
        })

        const taxAfterReversalReplay = yield* calculateTax()
        expect(taxAfterReversalReplay.taxableGains).toBe(2000)
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

  it("allows an included override when the provider type is unknown", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture({ providerType: null }))
    await Effect.runPromise(
      insertInclusionOverride({ providerAssetRowId: fixture.providerAssetRowId })
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

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
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

      expect(error._tag).toBe("TaxCalculationPendingObservationsError")
    }
  )

  it("waits when a completed override replay contains failed records", async () => {
    const fixture = await Effect.runPromise(insertRejectedOverrideFixture())
    await Effect.runPromise(
      insertInclusionOverride({
        providerAssetRowId: fixture.providerAssetRowId,
        replayFailedRecords: 1,
      })
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
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

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
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
          mode: "replay",
          status: "completed",
          progressDetails: { failedRecords: 0 },
          createdAt: new Date(overrideCreatedAt.getTime() - 1),
          completedAt: new Date(overrideCreatedAt.getTime() + 2),
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const error = await Effect.runPromise(calculateTax().pipe(Effect.flip))

    expect(error._tag).toBe("TaxCalculationPendingObservationsError")
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

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
  })

  it("does not wait for an unrelated active replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values({
          sourceId,
          principalId,
          mode: "replay",
          status: "pending",
        })
      }).pipe(Effect.provide(context.TestPgClientLive))
    )

    const tax = await Effect.runPromise(calculateTax())

    expect(tax.taxableGains).toBe(2000)
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
