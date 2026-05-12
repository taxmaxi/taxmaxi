import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
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
      return yield* Effect.dieMessage("Missing seeded coinbase CEX fixture")
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
      return yield* Effect.dieMessage("Failed to create cex account fixture")
    }

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.dieMessage("Failed to load base blockchain fixture")
    }

    const [btcAsset] = yield* db
      .insert(schema.assets)
      .values({
        blockchainId: baseBlockchain.id,
        contractAddress: btcContractAddress,
        name: "Bitcoin",
        symbol: "BTC",
        decimals: 8,
        type: "token",
      })
      .returning({ id: schema.assets.id })

    if (btcAsset === undefined) {
      return yield* Effect.dieMessage("Failed to create BTC asset fixture")
    }

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
      .from(schema.assets)
      .where(eq(schema.assets.contractAddress, btcContractAddress))
      .limit(1)

    if (asset === undefined) {
      return yield* Effect.dieMessage("Failed to load BTC asset fixture")
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

await Effect.runPromise(context.recreateTestDatabase())

describe("TaxCalculationServiceLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

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
