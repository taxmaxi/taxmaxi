/**
 * FactualLedgerRepositoryLive - Drizzle-backed factual-ledger adapter.
 *
 * @module FactualLedgerRepositoryLive
 */

import {
  AccountingEventId,
  AccountingQuantity,
  AccountingTransactionReference,
  AcquisitionEvent,
  CustodyMovementEvent,
  DispositionEvent,
  MarketQuoteFact,
  MonetaryAmount,
  ObservedConsiderationFact,
  type AcquisitionCause,
  type AccountingEvent,
  type DispositionCause,
  type ValuationFact,
} from "@my/core/accounting"
import { SourceId } from "@my/core/source"
import { fromDate } from "@my/core/shared/values/Timestamp"
import { aliasedTable, and, asc, eq, inArray, lte, or } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  FactualLedgerRepository,
  type FactualLedgerRepositoryShape,
} from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const EXCHANGE_TYPES = new Set([
  "buy_fiat",
  "sell_fiat",
  "swap_crypto_to_crypto",
  "trade_other",
  "nft_buy",
  "nft_sell",
])

const acquisitionCause = (transactionType: string | null): AcquisitionCause => {
  if (transactionType === "gift_received") return "gift"
  if (transactionType === "airdrop") return "airdrop"
  if (transactionType === "mining_reward") return "mining_reward"
  if (transactionType === "staking_reward") return "staking_reward"
  if (transactionType === "payment_received") return "payment"
  if (EXCHANGE_TYPES.has(transactionType ?? "")) return "purchase"

  if (
    transactionType === "bounty" ||
    transactionType === "cashback" ||
    transactionType === "governance_reward" ||
    transactionType === "interest_received" ||
    transactionType === "masternode_reward" ||
    transactionType === "yield_farming_reward"
  ) {
    return "reward"
  }

  return "unknown"
}

const dispositionCause = ({
  kind,
  transactionType,
}: {
  readonly kind: "disposal" | "fee"
  readonly transactionType: string | null
}): DispositionCause => {
  if (kind === "fee") return "fee"
  if (transactionType === "gift_sent" || transactionType === "donation_sent") return "gift"
  if (transactionType === "payment_sent") return "payment"
  return EXCHANGE_TYPES.has(transactionType ?? "") ? "sale" : "unknown"
}

const decodeQuantity = (value: string) =>
  Schema.decodeEffect(AccountingQuantity)(value).pipe(
    Effect.mapError(
      (cause) =>
        new PersistenceError({
          operation: "factualLedgerRepository.load.quantity",
          cause,
        })
    )
  )

const decodeDecimal = ({
  value,
  operation,
}: {
  readonly value: string
  readonly operation: string
}) =>
  Option.match(BigDecimal.fromString(value), {
    onNone: () =>
      Effect.fail(new PersistenceError({ operation, cause: `Invalid decimal: ${value}` })),
    onSome: Effect.succeed,
  })

const transactionReference = ({
  externalGroupId,
  externalId,
  transactionId,
}: {
  readonly externalGroupId: string | null
  readonly externalId: string | null
  readonly transactionId: string | null
}) => {
  const reference = [externalGroupId, externalId, transactionId].find(
    (candidate): candidate is string => candidate !== null && candidate.trim() !== ""
  )
  return reference === undefined ? undefined : AccountingTransactionReference.make(reference)
}

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timestampOrder = left.occurredAt.epochMillis - right.occurredAt.epochMillis
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10)

const compareValuationFacts = (left: ValuationFact, right: ValuationFact): number => {
  const eventOrder = left.eventId.localeCompare(right.eventId)
  if (eventOrder !== 0) return eventOrder
  if (left._tag === right._tag) return 0
  return left._tag === "observed_consideration" ? -1 : 1
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const feeTransactionTable = aliasedTable(schema.transactions, "fee_transaction")
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const providerSourceTable = aliasedTable(schema.sources, "provider_source")
  const canonicalSourceTable = aliasedTable(schema.sources, "canonical_source")
  type LoadParams = Parameters<FactualLedgerRepositoryShape["load"]>[0]

  const loadLegEvents = ({ principalId }: Pick<LoadParams, "principalId">) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transactionLegs.id,
          sourceId: schema.transactionLegs.sourceId,
          timestamp: schema.transactionLegs.timestamp,
          assetId: schema.transactionLegs.assetId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          transactionId: schema.transactions.id,
          externalId: schema.transactions.externalId,
          externalGroupId: schema.transactions.externalGroupId,
          transactionType: schema.transactions.transactionType,
          providerResourcePath: schema.transactions.providerResourcePath,
          transactionSourceRawRecordId: schema.transactions.sourceRawRecordId,
          providerFiatAmount: schema.transactions.providerFiatAmount,
          providerFiatCurrency: schema.transactions.providerFiatCurrency,
          feeTransactionId: feeTransactionTable.id,
          feeExternalId: feeTransactionTable.externalId,
          feeExternalGroupId: feeTransactionTable.externalGroupId,
        })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transactions,
          and(
            eq(schema.transactionLegs.transactionId, schema.transactions.id),
            eq(schema.transactions.principalId, principalId),
            eq(schema.transactions.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .leftJoin(
          feeTransactionTable,
          and(
            eq(schema.transactionLegs.feeForTransactionId, feeTransactionTable.id),
            eq(feeTransactionTable.principalId, principalId),
            eq(feeTransactionTable.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.legs"))

      const events: AccountingEvent[] = []
      const eventRows: Array<{
        readonly event: AccountingEvent
        readonly row: (typeof rows)[number]
      }> = []
      const eventCountByTransactionId = new Map<string, number>()

      for (const row of rows) {
        if (
          row.transactionId !== null &&
          row.kind !== "fee" &&
          row.derivationRule !== "internal_transfer_in" &&
          row.derivationRule !== "internal_transfer_out"
        ) {
          eventCountByTransactionId.set(
            row.transactionId,
            (eventCountByTransactionId.get(row.transactionId) ?? 0) + 1
          )
        }
      }

      for (const row of rows) {
        if (
          row.derivationRule === "internal_transfer_in" ||
          row.derivationRule === "internal_transfer_out"
        ) {
          continue
        }

        const quantity = yield* decodeQuantity(row.amount)
        const reference =
          row.kind === "fee" && row.feeTransactionId !== null
            ? transactionReference({
                externalGroupId: row.feeExternalGroupId,
                externalId: row.feeExternalId,
                transactionId: row.feeTransactionId,
              })
            : transactionReference(row)
        const common = {
          id: AccountingEventId.make(row.id),
          occurredAt: fromDate(row.timestamp),
          assetId: row.assetId,
          quantity,
          ...(reference === undefined ? {} : { transactionReference: reference }),
        }

        if (row.kind === "acquisition" || row.kind === "income") {
          const event = AcquisitionEvent.make({
            _tag: "acquisition",
            ...common,
            custodySourceId: SourceId.make(row.sourceId),
            cause: acquisitionCause(row.transactionType),
          })
          events.push(event)
          eventRows.push({ event, row })
          continue
        }

        const event = DispositionEvent.make({
          _tag: "disposition",
          ...common,
          custodySourceId: SourceId.make(row.sourceId),
          cause: dispositionCause({ kind: row.kind, transactionType: row.transactionType }),
        })
        events.push(event)
        eventRows.push({ event, row })
      }

      return { events, eventRows, eventCountByTransactionId }
    })

  type LoadedLegEvents = Effect.Success<ReturnType<typeof loadLegEvents>>

  const loadCustodyMovementEvents = ({ principalId }: Pick<LoadParams, "principalId">) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transferReconciliations.id,
          canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
          canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
          providerDirection: schema.providerTransfers.direction,
          providerSourceId: providerTransactionTable.sourceId,
          canonicalSourceId: canonicalTransactionTable.sourceId,
          canonicalTimestamp: canonicalTransactionTable.timestamp,
          canonicalExternalId: canonicalTransactionTable.externalId,
          canonicalExternalGroupId: canonicalTransactionTable.externalGroupId,
          assetId: schema.transfers.assetId,
          amount: schema.transfers.amount,
        })
        .from(schema.transferReconciliations)
        .innerJoin(
          schema.providerTransfers,
          eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
        )
        .innerJoin(
          providerTransactionTable,
          and(
            eq(schema.providerTransfers.transactionId, providerTransactionTable.id),
            eq(schema.providerTransfers.sourceId, providerTransactionTable.sourceId)
          )
        )
        .innerJoin(
          schema.inventoryMovements,
          and(
            eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
            eq(schema.inventoryMovements.transactionId, providerTransactionTable.id),
            eq(schema.inventoryMovements.sourceId, schema.providerTransfers.sourceId)
          )
        )
        .innerJoin(
          schema.transfers,
          eq(schema.transferReconciliations.canonicalTransferId, schema.transfers.id)
        )
        .innerJoin(
          canonicalTransactionTable,
          and(
            eq(schema.transferReconciliations.canonicalTransactionId, canonicalTransactionTable.id),
            eq(schema.transfers.sourceId, canonicalTransactionTable.sourceId)
          )
        )
        .innerJoin(
          providerSourceTable,
          and(
            eq(providerTransactionTable.sourceId, providerSourceTable.id),
            eq(providerSourceTable.principalId, principalId)
          )
        )
        .innerJoin(
          canonicalSourceTable,
          and(
            eq(canonicalTransactionTable.sourceId, canonicalSourceTable.id),
            eq(canonicalSourceTable.principalId, principalId)
          )
        )
        .where(
          and(
            eq(schema.transferReconciliations.principalId, principalId),
            eq(schema.inventoryMovements.principalId, principalId),
            eq(providerTransactionTable.principalId, principalId),
            eq(canonicalTransactionTable.principalId, principalId),
            eq(schema.transfers.principalId, principalId),
            eq(schema.inventoryMovements.purpose, "principal"),
            eq(schema.inventoryMovements.reconciliationStatus, "matched"),
            or(
              eq(schema.transferReconciliations.status, "approved"),
              and(
                eq(schema.transferReconciliations.status, "auto_applied"),
                eq(schema.transferReconciliations.deterministic, true)
              )
            )
          )
        )
        .orderBy(asc(schema.transferReconciliations.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyMovements"))

      const events: AccountingEvent[] = []
      const seenCanonicalTransferIds = new Set<string>()
      for (const row of rows) {
        if (row.canonicalTransferId === null) continue
        if (seenCanonicalTransferIds.has(row.canonicalTransferId)) {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.duplicateCustodyMovement",
            cause: `Canonical transfer has multiple active reconciliations: ${row.canonicalTransferId}`,
          })
        }
        seenCanonicalTransferIds.add(row.canonicalTransferId)

        const quantity = yield* decodeQuantity(row.amount)
        const reference = transactionReference({
          externalGroupId: row.canonicalExternalGroupId,
          externalId: row.canonicalExternalId,
          transactionId: row.canonicalTransactionId,
        })
        const fromCustodySourceId =
          row.providerDirection === "outbound" ? row.providerSourceId : row.canonicalSourceId
        const toCustodySourceId =
          row.providerDirection === "outbound" ? row.canonicalSourceId : row.providerSourceId

        events.push(
          CustodyMovementEvent.make({
            _tag: "custody_movement",
            id: AccountingEventId.make(row.id),
            occurredAt: fromDate(row.canonicalTimestamp),
            assetId: row.assetId,
            quantity,
            ...(reference === undefined ? {} : { transactionReference: reference }),
            fromCustodySourceId: SourceId.make(fromCustodySourceId),
            toCustodySourceId: SourceId.make(toCustodySourceId),
          })
        )
      }

      return events
    })

  const makeObservedValuationFacts = ({
    eventRows,
    eventCountByTransactionId,
    reportingCurrency,
  }: Pick<LoadedLegEvents, "eventRows" | "eventCountByTransactionId"> &
    Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []
      for (const { event, row } of eventRows) {
        if (
          row.kind !== "fee" &&
          row.transactionId !== null &&
          eventCountByTransactionId.get(row.transactionId) === 1 &&
          row.providerFiatAmount !== null &&
          row.providerFiatCurrency === reportingCurrency
        ) {
          const providerAmount = yield* decodeDecimal({
            value: row.providerFiatAmount,
            operation: "factualLedgerRepository.load.providerFiatAmount",
          })
          if (BigDecimal.isNegative(providerAmount)) continue

          const amount = MonetaryAmount.fromBigDecimal(providerAmount, reportingCurrency)
          const providerResourcePath = row.providerResourcePath?.trim()
          const evidenceReference =
            providerResourcePath === undefined || providerResourcePath === ""
              ? row.transactionSourceRawRecordId === null
                ? `transaction:${row.transactionId}`
                : `source_raw_record:${row.transactionSourceRawRecordId}`
              : providerResourcePath

          valuationFacts.push(
            ObservedConsiderationFact.make({
              _tag: "observed_consideration",
              eventId: event.id,
              amount,
              evidenceReference,
            })
          )
        }
      }

      return valuationFacts
    })

  const loadPriceRows = ({
    events,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
  } & Pick<LoadParams, "reportingCurrency">) => {
    const eventAssetIds = [...new Set(events.map(({ assetId }) => assetId))]
    const latestEventTimestamp = events.reduce(
      (latest, event) => Math.max(latest, event.occurredAt.epochMillis),
      Number.NEGATIVE_INFINITY
    )

    return eventAssetIds.length === 0
      ? Effect.succeed([])
      : db
          .select({
            assetId: schema.assetPrices.assetId,
            timestamp: schema.assetPrices.timestamp,
            price: schema.assetPrices.price,
            source: schema.assetPrices.source,
          })
          .from(schema.assetPrices)
          .where(
            and(
              inArray(schema.assetPrices.assetId, eventAssetIds),
              eq(schema.assetPrices.currency, reportingCurrency),
              lte(
                schema.assetPrices.timestamp,
                DateTime.toDateUtc(DateTime.makeUnsafe(latestEventTimestamp))
              )
            )
          )
          .orderBy(asc(schema.assetPrices.assetId), asc(schema.assetPrices.timestamp))
          .pipe(wrapSqlError("factualLedgerRepository.load.prices"))
  }

  type PriceRows = Effect.Success<ReturnType<typeof loadPriceRows>>

  const makeMarketValuationFacts = ({
    events,
    priceRows,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
    readonly priceRows: PriceRows
  } & Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []

      for (const event of events) {
        const quoteCandidates = priceRows.filter(
          (price) =>
            price.assetId === event.assetId &&
            price.timestamp <= event.occurredAt.toDate() &&
            utcDay(price.timestamp) === utcDay(event.occurredAt.toDate())
        )
        let quote:
          | { readonly row: PriceRows[number]; readonly value: BigDecimal.BigDecimal }
          | undefined
        for (const candidate of quoteCandidates.reverse()) {
          const value = yield* decodeDecimal({
            value: candidate.price,
            operation: "factualLedgerRepository.load.marketQuote",
          })
          if (BigDecimal.isPositive(value)) {
            quote = { row: candidate, value }
            break
          }
        }
        if (quote === undefined) continue

        valuationFacts.push(
          MarketQuoteFact.make({
            _tag: "market_quote",
            eventId: event.id,
            unitPrice: MonetaryAmount.fromBigDecimal(quote.value, reportingCurrency),
            quotedAt: fromDate(quote.row.timestamp),
            source: quote.row.source?.trim() || "asset_prices",
          })
        )
      }

      return valuationFacts
    })

  const load: FactualLedgerRepositoryShape["load"] = ({ principalId, reportingCurrency }) =>
    Effect.gen(function* () {
      const legEvents = yield* loadLegEvents({ principalId })
      const custodyMovementEvents = yield* loadCustodyMovementEvents({ principalId })
      const events = [...legEvents.events, ...custodyMovementEvents].sort(compareEvents)
      const observedValuationFacts = yield* makeObservedValuationFacts({
        eventRows: legEvents.eventRows,
        eventCountByTransactionId: legEvents.eventCountByTransactionId,
        reportingCurrency,
      })
      const priceRows = yield* loadPriceRows({ events, reportingCurrency })
      const marketValuationFacts = yield* makeMarketValuationFacts({
        events,
        priceRows,
        reportingCurrency,
      })
      const valuationFacts = [...observedValuationFacts, ...marketValuationFacts].sort(
        compareValuationFacts
      )

      return { events, valuationFacts }
    })

  return FactualLedgerRepository.of({ load })
})

/** Live factual-ledger repository layer. */
export const FactualLedgerRepositoryLive = Layer.effect(FactualLedgerRepository, make)
