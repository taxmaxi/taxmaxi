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

const formatAtAccountingScale = (value: string): string => {
  const scaled = BigDecimal.scale(BigDecimal.fromStringUnsafe(value), 8)
  const negative = scaled.value < 0n
  const digits = (negative ? -scaled.value : scaled.value).toString().padStart(9, "0")

  return `${negative ? "-" : ""}${digits.slice(0, -8)}.${digits.slice(-8)}`
}

interface FifoFact {
  readonly externalId: string
  readonly rawRecordId: string
  readonly timestamp: Date
  readonly quantity: string
  readonly fiatAmount: string | null
}

interface AcquisitionFact extends FifoFact {
  readonly fiatAmount: string
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
  providerFiatCurrency: fact.fiatAmount === null ? null : "EUR",
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
  fiatCurrency: fact.fiatAmount === null ? null : "EUR",
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
          ? formatAtAccountingScale(acquisition.quantity)
          : formatAtAccountingScale(formatAccountingQuantity(allocation.remainingQuantity)),
    }
  }),
  allocations: result.allocations.map((allocation) => ({
    lotId: allocation.lotId,
    matchedQuantity: formatAtAccountingScale(formatAccountingQuantity(allocation.matchedQuantity)),
    costBasis: formatAtAccountingScale(allocation.costBasis.format()),
    proceeds: formatAtAccountingScale(allocation.proceeds.format()),
    gainLoss: formatAtAccountingScale(allocation.gainLoss.format()),
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
            remainingQuantity: formatAtAccountingScale(lot.remainingQuantity),
          })
    )
    const allocations = yield* Effect.forEach(rows.allocations, (allocation) =>
      allocation.lotId === null
        ? Effect.die("Differential fixture allocation is missing a lot external ID")
        : Effect.succeed({
            lotId: allocation.lotId,
            matchedQuantity: formatAtAccountingScale(allocation.matchedQuantity),
            costBasis: formatAtAccountingScale(allocation.costBasis),
            proceeds: formatAtAccountingScale(allocation.proceeds),
            gainLoss: formatAtAccountingScale(allocation.gainLoss),
          })
    )

    return { lots, allocations } satisfies ComparableFifoResult
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

  const assertParity = (fixture: DifferentialFixture) =>
    Effect.gen(function* () {
      yield* Effect.forEach(fixture.acquisitions, (acquisition) =>
        persistFact({ ...acquisition, kind: "acquisition" })
      )
      yield* persistFact({ ...fixture.disposal, kind: "disposal" })

      const fixtureLotIds = fixture.acquisitions.map(({ externalId }) => externalId)
      const persistedRows = yield* loadPersistedRows(fixtureLotIds)
      const persistedResult = yield* renderPersistedResult({ rows: persistedRows })

      const pureResult = yield* matchFifoLots({
        lots: fixture.acquisitions.map((acquisition) => ({
          id: acquisition.externalId,
          remainingQuantity: quantity(acquisition.quantity),
          costBasisPerUnit: MonetaryAmount.unsafeFromString(acquisition.costBasisPerUnit, "EUR"),
        })),
        disposal: {
          quantity: quantity(fixture.disposal.quantity),
          proceeds:
            fixture.disposal.fiatAmount === null
              ? null
              : MonetaryAmount.unsafeFromString(fixture.disposal.fiatAmount, "EUR"),
        },
      })

      expect(renderPureResult({ fixture, result: pureResult })).toEqual(persistedResult)
    })

  it.effect("matches disposal allocations and remaining lots at the eight-decimal scale", () =>
    Effect.gen(function* () {
      yield* assertParity({
        acquisitions: [
          {
            externalId: "differential-lot-oldest",
            rawRecordId: "00000000-0000-0000-0000-000000000801",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "2.00000000",
            costBasisPerUnit: "2",
          },
          {
            externalId: "differential-lot-newer",
            rawRecordId: "00000000-0000-0000-0000-000000000802",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
            quantity: "2.00000000",
            fiatAmount: "6.00000000",
            costBasisPerUnit: "3",
          },
        ],
        disposal: {
          externalId: "differential-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000803",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "3.00000000",
          fiatAmount: "10.00000000",
        },
      })

      yield* assertParity({
        acquisitions: [
          {
            externalId: "missing-price-lot",
            rawRecordId: "00000000-0000-0000-0000-000000000811",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            quantity: "1.00000000",
            fiatAmount: "4.00000000",
            costBasisPerUnit: "4",
          },
        ],
        disposal: {
          externalId: "missing-price-disposal",
          rawRecordId: "00000000-0000-0000-0000-000000000812",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
          quantity: "0.50000000",
          fiatAmount: null,
        },
      })
    })
  )
})
