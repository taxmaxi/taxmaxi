import { matchFifoLots, type FifoMatchResult } from "@my/accounting"
import {
  AccountingQuantity,
  format as formatAccountingQuantity,
  MonetaryAmount,
} from "@my/core/accounting"
import {
  type PersistNormalizedSourceArtifactsWithLegsParams,
  type ResolvedProviderTransactionTypeMapping,
  SourceNormalizationRepository,
  type SourceTransactionDraft,
  type SourceTransactionLegDraft,
  type SourceVenueContextDraft,
} from "@my/sync-engine/services"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { asc, eq, inArray } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  type SyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_fifo_matcher_differential",
})

await Effect.runPromise(context.recreateTestDatabase())

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const quantity = Schema.decodeUnknownSync(AccountingQuantity)

const formatMonetaryAtAccountingScale = (value: string): string => {
  const scaled = BigDecimal.scale(BigDecimal.fromStringUnsafe(value), 8)
  const negative = scaled.value < 0n
  const digits = (negative ? -scaled.value : scaled.value).toString().padStart(9, "0")

  return `${negative ? "-" : ""}${digits.slice(0, -8)}.${digits.slice(-8)}`
}

const formatExactQuantity = (value: string): string =>
  BigDecimal.format(BigDecimal.fromStringUnsafe(value))

interface FifoFact {
  readonly externalId: string
  readonly rawRecordId: string
  readonly timestamp: Date
  readonly quantity: string
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
}

interface AcquisitionFact extends FifoFact {
  readonly costBasisPerUnit: string
}

interface DisposalFact extends FifoFact {}

type PersistedFifoFact = FifoFact & { readonly kind: "acquisition" | "disposal" }

interface FifoFactMapping {
  readonly providerTransactionType: "buy" | "sell"
  readonly side: "buy" | "sell"
  readonly taxTreatment: "non_taxable_by_default" | "taxable_by_default"
  readonly transactionType: "buy_fiat" | "sell_fiat"
}

interface DifferentialFixture {
  readonly acquisitions: ReadonlyArray<AcquisitionFact>
  readonly disposal: DisposalFact
}

interface ComparableFifoResult {
  readonly lots: ReadonlyArray<{
    readonly lotId: string
    readonly remainingQuantity: string
  }>
  readonly allocations: ReadonlyArray<{
    readonly lotId: string
    readonly matchedQuantity: string
    readonly costBasis: string
    readonly proceeds: string
    readonly gainLoss: string
  }>
}

interface PersistedFifoRows {
  readonly lots: ReadonlyArray<{
    readonly lotId: string | null
    readonly remainingQuantity: string
  }>
  readonly allocations: ReadonlyArray<{
    readonly lotId: string | null
    readonly matchedQuantity: string
    readonly costBasis: string
    readonly proceeds: string
    readonly gainLoss: string
  }>
}

const seedRawRecord = ({
  externalId,
  rawRecordId,
  timestamp,
}: {
  readonly externalId: string
  readonly rawRecordId: string
  readonly timestamp: Date
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: rawRecordId,
      sourceId: TEST_SOURCE_ID,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId: "fifo-differential-account",
      externalRecordId: externalId,
      externalParentId: null,
      occurredAt: timestamp,
      payload: { id: externalId },
      importedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  })

const mapFactKind = (kind: PersistedFifoFact["kind"]): FifoFactMapping =>
  kind === "acquisition"
    ? {
        providerTransactionType: "buy",
        side: "buy",
        taxTreatment: "non_taxable_by_default",
        transactionType: "buy_fiat",
      }
    : {
        providerTransactionType: "sell",
        side: "sell",
        taxTreatment: "taxable_by_default",
        transactionType: "sell_fiat",
      }

const makeTransaction = ({
  fact,
  mapping,
}: {
  readonly fact: PersistedFifoFact
  readonly mapping: FifoFactMapping
}): SourceTransactionDraft => ({
  sourceId: TEST_SOURCE_ID,
  sourceRawRecordId: fact.rawRecordId,
  externalId: `transaction-${fact.externalId}`,
  externalGroupId: null,
  timestamp: fact.timestamp,
  transactionType: mapping.transactionType,
  providerTransactionType: mapping.providerTransactionType,
  providerStatus: "completed",
  providerResourcePath: null,
  providerDescription: null,
  providerCreatedAt: fact.timestamp,
  providerUpdatedAt: fact.timestamp,
  metadata: { fixture: "fifo-differential" },
  providerFiatAmount: fact.fiatAmount,
  providerFiatCurrency: fact.fiatCurrency,
  principalId: TEST_PRINCIPAL_ID,
})

const makeVenueContext = ({
  cexAccountId,
  mapping,
}: {
  readonly cexAccountId: string
  readonly mapping: FifoFactMapping
}): SourceVenueContextDraft => ({
  venueType: "cex",
  cexAccountId,
  externalAccountId: "fifo-differential-account",
  externalOrderId: null,
  externalFillId: null,
  side: mapping.side,
  instrument: "BTC-EUR",
  fillPrice: null,
  commissionAmount: null,
  commissionCurrency: null,
  metadata: { fixture: "fifo-differential" },
})

const makeLeg = (fact: PersistedFifoFact): SourceTransactionLegDraft => ({
  sourceId: TEST_SOURCE_ID,
  sourceRawRecordId: fact.rawRecordId,
  externalId: fact.externalId,
  txHash: null,
  timestamp: fact.timestamp,
  principalId: TEST_PRINCIPAL_ID,
  addressId: null,
  assetId: TEST_BTC_ASSET_ID,
  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
  amount: fact.quantity,
  kind: fact.kind,
  provenance: "deterministic",
  derivationRule: "fifo_differential_fixture",
  metadata: { fixture: "fifo-differential" },
  transactionId: null,
  sourceTransferId: null,
  fiatAmount: fact.fiatAmount,
  fiatCurrency: fact.fiatCurrency,
  feeForTransactionId: null,
})

const makeResolvedTransactionType = ({
  fact,
  mapping,
}: {
  readonly fact: PersistedFifoFact
  readonly mapping: FifoFactMapping
}): ResolvedProviderTransactionTypeMapping => ({
  providerTransactionType: mapping.providerTransactionType,
  transactionType: mapping.transactionType,
  inventoryEffect: fact.kind,
  taxTreatment: mapping.taxTreatment,
  resolutionStrategy: "static",
  pairedRecordRequired: false,
  mappingStatus: "approved",
})

const makePersistenceInput = ({
  cexAccountId,
  fact,
}: {
  readonly cexAccountId: string
  readonly fact: PersistedFifoFact
}): PersistNormalizedSourceArtifactsWithLegsParams => {
  const mapping = mapFactKind(fact.kind)

  return {
    transaction: makeTransaction({ fact, mapping }),
    venueContext: makeVenueContext({ cexAccountId, mapping }),
    providerTransfers: [],
    canonicalTransfers: [],
    providerAssetRowIds: [],
    legs: [makeLeg(fact)],
    transactionReview: null,
    resolvedTransactionType: makeResolvedTransactionType({ fact, mapping }),
  }
}

const renderPureResult = ({
  fixture,
  result,
}: {
  readonly fixture: DifferentialFixture
  readonly result: FifoMatchResult
}): ComparableFifoResult => ({
  lots: fixture.acquisitions.map((acquisition) => {
    const allocation = result.allocations.find(({ lotId }) => lotId === acquisition.externalId)

    return {
      lotId: acquisition.externalId,
      remainingQuantity:
        allocation === undefined
          ? formatExactQuantity(acquisition.quantity)
          : formatExactQuantity(formatAccountingQuantity(allocation.remainingQuantity)),
    }
  }),
  allocations: result.allocations.map((allocation) => ({
    lotId: allocation.lotId,
    matchedQuantity: formatExactQuantity(formatAccountingQuantity(allocation.matchedQuantity)),
    costBasis: formatMonetaryAtAccountingScale(allocation.costBasis.format()),
    proceeds: formatMonetaryAtAccountingScale(allocation.proceeds.format()),
    gainLoss: formatMonetaryAtAccountingScale(allocation.gainLoss.format()),
  })),
})

const loadPersistedRows = (fixtureLotIds: ReadonlyArray<string>) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const lots = yield* db
          .select({
            lotId: schema.transactionLegs.externalId,
            remainingQuantity: schema.fifoLots.remainingAmount,
          })
          .from(schema.fifoLots)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
          )
          .where(inArray(schema.transactionLegs.externalId, fixtureLotIds))
          .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
        const allocations = yield* db
          .select({
            lotId: schema.transactionLegs.externalId,
            matchedQuantity: schema.disposalMatches.matchedAmount,
            costBasis: schema.disposalMatches.costBasis,
            proceeds: schema.disposalMatches.proceeds,
            gainLoss: schema.disposalMatches.gainLoss,
          })
          .from(schema.disposalMatches)
          .innerJoin(schema.fifoLots, eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId))
          .innerJoin(
            schema.transactionLegs,
            eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
          )
          .where(inArray(schema.transactionLegs.externalId, fixtureLotIds))
          .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))

        return { lots, allocations } satisfies PersistedFifoRows
      })
    )
  )

const renderPersistedResult = ({ rows }: { readonly rows: PersistedFifoRows }) =>
  Effect.gen(function* () {
    const lots = yield* Effect.forEach(rows.lots, (lot) =>
      lot.lotId === null
        ? Effect.die("Differential fixture lot is missing an external ID")
        : Effect.succeed({
            lotId: lot.lotId,
            remainingQuantity: formatExactQuantity(lot.remainingQuantity),
          })
    )
    const allocations = yield* Effect.forEach(rows.allocations, (allocation) =>
      allocation.lotId === null
        ? Effect.die("Differential fixture allocation is missing a lot external ID")
        : Effect.succeed({
            lotId: allocation.lotId,
            matchedQuantity: formatExactQuantity(allocation.matchedQuantity),
            costBasis: formatMonetaryAtAccountingScale(allocation.costBasis),
            proceeds: formatMonetaryAtAccountingScale(allocation.proceeds),
            gainLoss: formatMonetaryAtAccountingScale(allocation.gainLoss),
          })
    )

    return { lots, allocations } satisfies ComparableFifoResult
  })

const loadShortageReview = (disposalExternalId: string) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [review] = yield* db
          .select({
            reviewStatus: schema.transactionReviews.reviewStatus,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
            categorizationReason: schema.transactionReviews.categorizationReason,
          })
          .from(schema.transactionReviews)
          .innerJoin(
            schema.transactions,
            eq(schema.transactions.id, schema.transactionReviews.transactionId)
          )
          .where(eq(schema.transactions.externalId, `transaction-${disposalExternalId}`))
          .limit(1)

        return review
      })
    )
  )

const loadPersistedFiatCurrencies = (externalIds: ReadonlyArray<string>) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        return yield* db
          .select({
            externalId: schema.transactionLegs.externalId,
            fiatCurrency: schema.transactionLegs.fiatCurrency,
          })
          .from(schema.transactionLegs)
          .where(inArray(schema.transactionLegs.externalId, externalIds))
          .orderBy(asc(schema.transactionLegs.timestamp))
      })
    )
  )

const loadPersistedLotAccounting = (externalId: string) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db
          .select({
            costBasisPerToken: schema.fifoLots.costBasisPerToken,
            costBasisCurrency: schema.fifoLots.costBasisCurrency,
          })
          .from(schema.fifoLots)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
          )
          .where(eq(schema.transactionLegs.externalId, externalId))
          .limit(1)

        return lot
      })
    )
  )

const matchPureFixture = (fixture: DifferentialFixture) =>
  matchFifoLots({
    lots: fixture.acquisitions.map((acquisition) => ({
      id: acquisition.externalId,
      remainingQuantity: quantity(acquisition.quantity),
      costBasisPerUnit: MonetaryAmount.unsafeFromString(
        acquisition.costBasisPerUnit,
        (acquisition.fiatAmount === null
          ? (fixture.disposal.fiatCurrency ?? acquisition.fiatCurrency ?? "EUR")
          : (acquisition.fiatCurrency ?? "EUR")
        ).toUpperCase()
      ),
    })),
    disposal: {
      quantity: quantity(fixture.disposal.quantity),
      proceeds:
        fixture.disposal.fiatAmount === null
          ? null
          : MonetaryAmount.unsafeFromString(
              fixture.disposal.fiatAmount,
              (fixture.disposal.fiatCurrency ?? "EUR").toUpperCase()
            ).abs(),
    },
  })

describe("source FIFO and pure matcher differential", () => {
  let repositoryFixture: SyncEngineRepositoryFixture

  const resetFixture = () =>
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      repositoryFixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineAssets({
            baseBlockchainId: repositoryFixture.baseBlockchainId,
            bitcoinBlockchainId: repositoryFixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.assets)
              .values({
                id: TEST_BTC_ASSET_ID,
                name: "Bitcoin",
                symbol: "BTC",
                type: "fungible",
              })
              .onConflictDoNothing({ target: schema.assets.id })
          })
        )
      )
    })

  beforeEach(() => Effect.runPromise(resetFixture()))

  const persistFact = (fact: PersistedFifoFact) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: fact.externalId,
            rawRecordId: fact.rawRecordId,
            timestamp: fact.timestamp,
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(
              makePersistenceInput({ cexAccountId: repositoryFixture.cexAccountId, fact })
            )
          )
        )
      )
    })

  const persistRepositoryFixture = (fixture: DifferentialFixture) =>
    Effect.gen(function* () {
      yield* resetFixture()
      yield* Effect.forEach(fixture.acquisitions, (acquisition) =>
        persistFact({ ...acquisition, kind: "acquisition" })
      )
      yield* persistFact({ ...fixture.disposal, kind: "disposal" })

      const fixtureLotIds = fixture.acquisitions.map(({ externalId }) => externalId)
      const persistedRows = yield* loadPersistedRows(fixtureLotIds)

      return yield* renderPersistedResult({ rows: persistedRows })
    })

  const assertParity = (fixture: DifferentialFixture) =>
    Effect.gen(function* () {
      const persistedResult = yield* persistRepositoryFixture(fixture)

      const pureResult = yield* matchPureFixture(fixture)

      expect(pureResult._tag).toBe("FullyMatched")
      if (pureResult._tag !== "FullyMatched") {
        return yield* Effect.die("Expected fully covered FIFO fixture to be fully matched")
      }

      const renderedPureResult = renderPureResult({ fixture, result: pureResult })

      expect(renderedPureResult).toEqual(persistedResult)

      return persistedResult
    })

  it.effect("matches exact quantities and eight-decimal monetary allocations", () =>
    Effect.gen(function* () {
      const multiLotResult = yield* assertParity({
        acquisitions: [
          {
            externalId: "differential-lot-oldest",
            rawRecordId: "00000000-0000-0000-0000-000000000801",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "2.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "2",
          },
          {
            externalId: "differential-lot-newer",
            rawRecordId: "00000000-0000-0000-0000-000000000802",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
            quantity: "2.00000000",
            fiatAmount: "6.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "3",
          },
        ],
        disposal: {
          externalId: "differential-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000803",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "2.25000000",
          fiatAmount: "9.00000000",
          fiatCurrency: "EUR",
        },
      })

      expect(multiLotResult.lots).toEqual([
        { lotId: "differential-lot-oldest", remainingQuantity: "0" },
        { lotId: "differential-lot-newer", remainingQuantity: "0.75" },
      ])

      yield* assertParity({
        acquisitions: [
          {
            externalId: "missing-price-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000811",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "4.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "4",
          },
        ],
        disposal: {
          externalId: "missing-price-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000812",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: null,
          fiatCurrency: null,
        },
      })

      const missingAcquisitionPriceResult = yield* assertParity({
        acquisitions: [
          {
            externalId: "missing-acquisition-price-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000821",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: null,
            fiatCurrency: null,
            costBasisPerUnit: "0",
          },
        ],
        disposal: {
          externalId: "missing-acquisition-price-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000822",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: "1.00000000",
          fiatCurrency: "USD",
        },
      })

      expect(missingAcquisitionPriceResult).toEqual({
        lots: [
          {
            lotId: "missing-acquisition-price-lot",
            remainingQuantity: "0.5",
          },
        ],
        allocations: [
          {
            lotId: "missing-acquisition-price-lot",
            matchedQuantity: "0.5",
            costBasis: "0.00000000",
            proceeds: "1.00000000",
            gainLoss: "1.00000000",
          },
        ],
      })

      const atomicQuantityResult = yield* assertParity({
        acquisitions: [
          {
            externalId: "atomic-quantity-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000823",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.000000001",
            fiatAmount: "1.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "0.999999999000000001",
          },
        ],
        disposal: {
          externalId: "atomic-quantity-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000824",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "1.000000000",
          fiatAmount: "1.00000000",
          fiatCurrency: "EUR",
        },
      })

      expect(atomicQuantityResult.lots).toEqual([
        { lotId: "atomic-quantity-lot", remainingQuantity: "0.000000001" },
      ])
      expect(atomicQuantityResult.allocations[0]?.matchedQuantity).toBe("1")
    })
  )

  it.effect("compares pure shortages with the legacy review and restored FIFO state", () =>
    Effect.gen(function* () {
      const fixture: DifferentialFixture = {
        acquisitions: [
          {
            externalId: "shortage-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000831",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.000000001",
            fiatAmount: "2.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "1.999999998",
          },
        ],
        disposal: {
          externalId: "shortage-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000832",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "1.500000003",
          fiatAmount: "3.00000000",
          fiatCurrency: "EUR",
        },
      }

      yield* Effect.forEach(fixture.acquisitions, (acquisition) =>
        persistFact({ ...acquisition, kind: "acquisition" })
      )
      yield* persistFact({ ...fixture.disposal, kind: "disposal" })

      const pureResult = yield* matchPureFixture(fixture)
      const persistedRows = yield* loadPersistedRows(
        fixture.acquisitions.map(({ externalId }) => externalId)
      )
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })
      const review = yield* loadShortageReview(fixture.disposal.externalId)

      expect(pureResult._tag).toBe("InventoryShortage")
      if (pureResult._tag !== "InventoryShortage") {
        return yield* Effect.die("Expected pure FIFO fixture to report an inventory shortage")
      }

      const pureShortage = formatExactQuantity(formatAccountingQuantity(pureResult.shortage))

      expect(pureShortage).toBe("0.500000002")
      expect(renderPureResult({ fixture, result: pureResult })).toEqual({
        lots: [{ lotId: "shortage-lot", remainingQuantity: "0" }],
        allocations: [
          {
            lotId: "shortage-lot",
            matchedQuantity: "1.000000001",
            costBasis: "2.00000000",
            proceeds: "2.00000000",
            gainLoss: "0.00000000",
          },
        ],
      })
      expect(persistedResult).toEqual({
        lots: [{ lotId: "shortage-lot", remainingQuantity: "1.000000001" }],
        allocations: [],
      })
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining(
          `Insufficient FIFO inventory for outbound amount ${pureShortage}`
        ),
      })
    })
  )

  it.effect("routes mixed fiat currencies to FIFO review without consuming inventory", () =>
    Effect.gen(function* () {
      const fixture: DifferentialFixture = {
        acquisitions: [
          {
            externalId: "mixed-currency-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000841",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "2.00000000",
            fiatCurrency: "USD",
            costBasisPerUnit: "2",
          },
        ],
        disposal: {
          externalId: "mixed-currency-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000842",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: "3.00000000",
          fiatCurrency: "EUR",
        },
      }

      const persistedResult = yield* persistRepositoryFixture(fixture)
      const persistedCurrencies = yield* loadPersistedFiatCurrencies([
        "mixed-currency-lot",
        "mixed-currency-disposal",
      ])
      const pureError = yield* Effect.flip(matchPureFixture(fixture))
      const review = yield* loadShortageReview(fixture.disposal.externalId)

      expect(persistedCurrencies).toEqual([
        { externalId: "mixed-currency-lot", fiatCurrency: "USD" },
        { externalId: "mixed-currency-disposal", fiatCurrency: "EUR" },
      ])
      expect(persistedResult).toEqual({
        lots: [{ lotId: "mixed-currency-lot", remainingQuantity: "1" }],
        allocations: [],
      })
      expect(pureError).toMatchObject({
        _tag: "CurrencyMismatchError",
        expected: "EUR",
        actual: "USD",
      })
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Currency mismatch: expected EUR, got USD"),
      })
    })
  )

  it.effect("normalizes FIFO currency casing and preserves legacy negative cost basis", () =>
    Effect.gen(function* () {
      const fixture: DifferentialFixture = {
        acquisitions: [
          {
            externalId: "legacy-tolerant-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000843",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "-2.00000000",
            fiatCurrency: "eur",
            costBasisPerUnit: "2",
          },
        ],
        disposal: {
          externalId: "legacy-tolerant-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000844",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: "3.00000000",
          fiatCurrency: "EUR",
        },
      }

      const persistedResult = yield* assertParity(fixture)
      const persistedLot = yield* loadPersistedLotAccounting("legacy-tolerant-lot")

      expect(persistedLot).toEqual({
        costBasisPerToken: "2.000000000000000000",
        costBasisCurrency: "EUR",
      })
      expect(persistedResult.allocations).toEqual([
        {
          lotId: "legacy-tolerant-lot",
          matchedQuantity: "0.5",
          costBasis: "1.00000000",
          proceeds: "3.00000000",
          gainLoss: "2.00000000",
        },
      ])
    })
  )

  it.effect("routes invalid fiat currency input to FIFO review without failing persistence", () =>
    Effect.gen(function* () {
      const acquisition: AcquisitionFact = {
        externalId: "invalid-currency-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000845",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: "2.00000000",
        fiatCurrency: "USDC",
        costBasisPerUnit: "2",
      }

      yield* persistFact({ ...acquisition, kind: "acquisition" })

      const persistedRows = yield* loadPersistedRows([acquisition.externalId])
      const persistedCurrencies = yield* loadPersistedFiatCurrencies([acquisition.externalId])
      const review = yield* loadShortageReview(acquisition.externalId)

      expect(persistedRows).toEqual({ lots: [], allocations: [] })
      expect(persistedCurrencies).toEqual([
        { externalId: acquisition.externalId, fiatCurrency: "USDC" },
      ])
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining(
          "Review required because a FIFO value could not be processed safely"
        ),
      })
    })
  )

  it.effect("ignores an invalid FIFO lot after the disposal is fully covered", () =>
    Effect.gen(function* () {
      const validAcquisition: AcquisitionFact = {
        externalId: "covered-prefix-valid-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000854",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: "2.00000000",
        fiatCurrency: "EUR",
        costBasisPerUnit: "2",
      }
      const unusedInvalidAcquisition: AcquisitionFact = {
        externalId: "covered-prefix-invalid-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000855",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: null,
        fiatCurrency: "USDC",
        costBasisPerUnit: "0",
      }
      const disposal: DisposalFact = {
        externalId: "covered-prefix-disposal",
        rawRecordId: "00000000-0000-0000-0000-000000000856",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
        quantity: "0.50000000",
        fiatAmount: "3.00000000",
        fiatCurrency: "EUR",
      }

      yield* persistFact({ ...validAcquisition, kind: "acquisition" })
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: unusedInvalidAcquisition.externalId,
            rawRecordId: unusedInvalidAcquisition.rawRecordId,
            timestamp: unusedInvalidAcquisition.timestamp,
          })
        )
      )
      const unusedInvalidInput = makePersistenceInput({
        cexAccountId: repositoryFixture.cexAccountId,
        fact: { ...unusedInvalidAcquisition, kind: "acquisition" },
      })
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...unusedInvalidInput,
              transaction: {
                ...unusedInvalidInput.transaction,
                providerFiatAmount: null,
                providerFiatCurrency: null,
              },
            })
          )
        )
      )
      yield* persistFact({ ...disposal, kind: "disposal" })

      const persistedRows = yield* loadPersistedRows([
        validAcquisition.externalId,
        unusedInvalidAcquisition.externalId,
      ])
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })
      const review = yield* loadShortageReview(disposal.externalId)

      expect(persistedResult).toEqual({
        lots: [
          { lotId: validAcquisition.externalId, remainingQuantity: "0.5" },
          { lotId: unusedInvalidAcquisition.externalId, remainingQuantity: "1" },
        ],
        allocations: [
          {
            lotId: validAcquisition.externalId,
            matchedQuantity: "0.5",
            costBasis: "1.00000000",
            proceeds: "3.00000000",
            gainLoss: "2.00000000",
          },
        ],
      })
      expect(review).toBeUndefined()
    })
  )

  it.effect("reviews a nonzero pending basis instead of assigning the disposal currency", () =>
    Effect.gen(function* () {
      const acquisition: AcquisitionFact = {
        externalId: "missing-basis-currency-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000846",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: "2.00000000",
        fiatCurrency: null,
        costBasisPerUnit: "2",
      }
      const disposal: DisposalFact = {
        externalId: "missing-basis-currency-disposal",
        rawRecordId: "00000000-0000-0000-0000-000000000847",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
        quantity: "0.50000000",
        fiatAmount: "3.00000000",
        fiatCurrency: "USD",
      }

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: acquisition.externalId,
            rawRecordId: acquisition.rawRecordId,
            timestamp: acquisition.timestamp,
          })
        )
      )
      const acquisitionInput = makePersistenceInput({
        cexAccountId: repositoryFixture.cexAccountId,
        fact: { ...acquisition, kind: "acquisition" },
      })
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...acquisitionInput,
              transaction: {
                ...acquisitionInput.transaction,
                providerFiatAmount: null,
                providerFiatCurrency: null,
              },
            })
          )
        )
      )
      yield* persistFact({ ...disposal, kind: "disposal" })

      const persistedRows = yield* loadPersistedRows([acquisition.externalId])
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })
      const review = yield* loadShortageReview(disposal.externalId)

      expect(persistedResult).toEqual({
        lots: [{ lotId: acquisition.externalId, remainingQuantity: "1" }],
        allocations: [],
      })
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Currency mismatch"),
      })
    })
  )

  it.effect("preserves legacy absolute-value handling for negative disposal proceeds", () =>
    Effect.gen(function* () {
      const persistedResult = yield* assertParity({
        acquisitions: [
          {
            externalId: "negative-proceeds-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000848",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "2.00000000",
            fiatCurrency: "EUR",
            costBasisPerUnit: "2",
          },
        ],
        disposal: {
          externalId: "negative-proceeds-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000849",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: "-3.00000000",
          fiatCurrency: "EUR",
        },
      })

      expect(persistedResult.allocations).toEqual([
        {
          lotId: "negative-proceeds-lot",
          matchedQuantity: "0.5",
          costBasis: "1.00000000",
          proceeds: "3.00000000",
          gainLoss: "2.00000000",
        },
      ])
    })
  )

  it.effect("rolls back earlier FIFO matches when a later leg needs currency review", () =>
    Effect.gen(function* () {
      const acquisition: AcquisitionFact = {
        externalId: "atomic-review-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000851",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: "2.00000000",
        fiatCurrency: "EUR",
        costBasisPerUnit: "2",
      }
      const firstDisposal: DisposalFact = {
        externalId: "atomic-review-first-disposal",
        rawRecordId: "00000000-0000-0000-0000-000000000852",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
        quantity: "0.25000000",
        fiatAmount: "1.00000000",
        fiatCurrency: "EUR",
      }
      const secondDisposal: DisposalFact = {
        externalId: "atomic-review-second-disposal",
        rawRecordId: "00000000-0000-0000-0000-000000000853",
        timestamp: firstDisposal.timestamp,
        quantity: "0.25000000",
        fiatAmount: "1.00000000",
        fiatCurrency: "USD",
      }

      yield* persistFact({ ...acquisition, kind: "acquisition" })
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: secondDisposal.externalId,
            rawRecordId: secondDisposal.rawRecordId,
            timestamp: secondDisposal.timestamp,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: firstDisposal.externalId,
            rawRecordId: firstDisposal.rawRecordId,
            timestamp: firstDisposal.timestamp,
          })
        )
      )

      const persistenceInput = makePersistenceInput({
        cexAccountId: repositoryFixture.cexAccountId,
        fact: { ...firstDisposal, kind: "disposal" },
      })
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...persistenceInput,
              legs: [
                makeLeg({ ...firstDisposal, kind: "disposal" }),
                makeLeg({ ...secondDisposal, kind: "disposal" }),
              ],
            })
          )
        )
      )

      const persistedRows = yield* loadPersistedRows([acquisition.externalId])
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })
      const review = yield* loadShortageReview(firstDisposal.externalId)

      expect(persistedResult).toEqual({
        lots: [{ lotId: acquisition.externalId, remainingQuantity: "1" }],
        allocations: [],
      })
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Currency mismatch"),
      })
    })
  )

  it.effect("rolls back FIFO legs and fee allocations in one savepoint", () =>
    Effect.gen(function* () {
      const acquisition: AcquisitionFact = {
        externalId: "derived-savepoint-lot",
        rawRecordId: "00000000-0000-0000-0000-000000000857",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        quantity: "1.00000000",
        fiatAmount: "2.00000000",
        fiatCurrency: "EUR",
        costBasisPerUnit: "2",
      }
      const disposal: DisposalFact = {
        externalId: "derived-savepoint-disposal",
        rawRecordId: "00000000-0000-0000-0000-000000000858",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
        quantity: "0.25000000",
        fiatAmount: "1.00000000",
        fiatCurrency: "EUR",
      }

      yield* persistFact({ ...acquisition, kind: "acquisition" })
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            externalId: disposal.externalId,
            rawRecordId: disposal.rawRecordId,
            timestamp: disposal.timestamp,
          })
        )
      )

      const persistenceInput = makePersistenceInput({
        cexAccountId: repositoryFixture.cexAccountId,
        fact: { ...disposal, kind: "disposal" },
      })
      const initialResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({ ...persistenceInput, legs: [] })
          )
        )
      )
      const feeLeg = {
        ...makeLeg({ ...disposal, kind: "disposal" }),
        externalId: "derived-savepoint-fee",
        amount: "0.90000000",
        kind: "fee" as const,
        fiatAmount: null,
        fiatCurrency: null,
        transactionId: initialResult.transaction.id,
      }

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...persistenceInput,
              legs: [makeLeg({ ...disposal, kind: "disposal" }), feeLeg],
            })
          )
        )
      )

      const persistedRows = yield* loadPersistedRows([acquisition.externalId])
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })
      const review = yield* loadShortageReview(disposal.externalId)
      const inventoryMovements = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, initialResult.transaction.id))
          })
        )
      )

      expect(persistedResult).toEqual({
        lots: [{ lotId: acquisition.externalId, remainingQuantity: "1" }],
        allocations: [],
      })
      expect(inventoryMovements).toEqual([])
      expect(review).toMatchObject({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Insufficient FIFO inventory"),
      })
    })
  )
})
