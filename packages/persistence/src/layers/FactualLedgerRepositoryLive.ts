/**
 * FactualLedgerRepositoryLive - Drizzle-backed factual-ledger adapter.
 *
 * @module FactualLedgerRepositoryLive
 */

import {
  AcquisitionEvent,
  CustodyUnitId,
  CustodyMovementEvent,
  DispositionEvent,
  MarketQuoteFact,
  ObservedConsiderationFact,
  type AcquisitionCause,
  type AccountingEvent,
  type DispositionCause,
  type ValuationFact,
} from "@my/core/accounting"
import { CURRENCIES_BY_CODE, type CurrencyCode } from "@my/core/currency"
import { SourceId } from "@my/core/source"
import { aliasedTable, and, asc, eq, inArray, or, sql } from "drizzle-orm"
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
import {
  makePrincipalAssetOverrideDecisionLoader,
  type PrincipalAssetOverrideDecisions,
  resolvePrincipalAssetId,
  resolveSystemAssetId,
} from "./PrincipalAssetOverrideDecisionLoader.ts"

const EXCHANGE_TYPES = new Set([
  "buy_fiat",
  "sell_fiat",
  "swap_crypto_to_crypto",
  "trade_other",
  "nft_buy",
  "nft_sell",
])

const ProviderAssetLegMetadata = Schema.Struct({
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const providerAssetRowIdFromMetadata = (metadata: unknown): string | null =>
  Option.getOrNull(
    Option.map(Schema.decodeUnknownOption(ProviderAssetLegMetadata)(metadata), (row) =>
      String(row.providerAssetRowId)
    )
  )

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

const decodeRequired = <S extends Schema.Constraint>({
  schema,
  input,
  operation,
}: {
  readonly schema: S
  readonly input: unknown
  readonly operation: string
}) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new PersistenceError({ operation, cause }))
  )

const decodeValuationDecimal = (value: string): BigDecimal.BigDecimal | undefined =>
  Option.getOrUndefined(BigDecimal.fromString(value))

const validateReportingCurrency = (reportingCurrency: CurrencyCode) =>
  CURRENCIES_BY_CODE.has(reportingCurrency)
    ? Effect.succeed(reportingCurrency)
    : Effect.fail(
        new PersistenceError({
          operation: "factualLedgerRepository.load.reportingCurrency",
          cause: `Unsupported reporting currency: ${reportingCurrency}`,
        })
      )

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

const transactionReference = ({
  externalGroupId,
  externalId,
  transactionId,
}: {
  readonly externalGroupId: string | null
  readonly externalId: string | null
  readonly transactionId: string | null
}) => {
  for (const candidate of [externalGroupId, externalId, transactionId]) {
    const reference = trimmedNonEmpty(candidate)
    if (reference !== undefined) return reference
  }

  return undefined
}

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timestampOrder = left.occurredAt.epochMillis - right.occurredAt.epochMillis
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10)

const utcDayStart = (day: string): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`))

const compareValuationFacts = (left: ValuationFact, right: ValuationFact): number => {
  const eventOrder = left.eventId.localeCompare(right.eventId)
  if (eventOrder !== 0) return eventOrder
  if (left._tag === right._tag) return 0
  return left._tag === "observed_consideration" ? -1 : 1
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const principalAssetOverrideDecisionLoader = yield* makePrincipalAssetOverrideDecisionLoader
  const feeTransactionTable = aliasedTable(schema.transactions, "fee_transaction")
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const providerSourceTable = aliasedTable(schema.sources, "provider_source")
  const canonicalSourceTable = aliasedTable(schema.sources, "canonical_source")
  type LoadParams = Parameters<FactualLedgerRepositoryShape["load"]>[0]

  const loadLegEvents = ({
    decisions,
    principalId,
    reconciledCanonicalTransferIds,
    reconciledProviderTransactionIds,
  }: Pick<LoadParams, "principalId"> & {
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly reconciledCanonicalTransferIds: ReadonlySet<string>
    readonly reconciledProviderTransactionIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transactionLegs.id,
          sourceId: schema.transactionLegs.sourceId,
          timestamp: schema.transactionLegs.timestamp,
          assetId: schema.transactionLegs.assetId,
          assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          metadata: schema.transactionLegs.metadata,
          hasExactProviderObservation: sql<boolean>`exists (
            select 1
            from ${schema.providerTransfers} exact_transfer
            where exact_transfer.transaction_id = ${schema.transactions.id}
              and exact_transfer.observed_blockchain_id is not null
          )`,
          sourceTransferId: schema.transactionLegs.sourceTransferId,
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
      const withheldTransactionIds = new Set<string>()
      const withheldLegIds = new Set<string>()
      const effectiveAssetByTransactionSystemAsset = new Map<string, string>()
      const isReconciledEconomicLeg = (row: (typeof rows)[number]) =>
        row.kind !== "fee" &&
        ((row.sourceTransferId !== null &&
          reconciledCanonicalTransferIds.has(row.sourceTransferId)) ||
          (row.sourceTransferId === null &&
            row.transactionId !== null &&
            reconciledProviderTransactionIds.has(row.transactionId)))

      for (const row of rows) {
        const providerAssetRowId = providerAssetRowIdFromMetadata(row.metadata)
        const mayUseProviderFallback =
          row.assetRepresentationId === null && !row.hasExactProviderObservation
        const providerDecision =
          providerAssetRowId !== null
            ? decisions.providerAssetDecisionById.get(providerAssetRowId)
            : undefined
        const providerInclusion = mayUseProviderFallback
          ? providerDecision?.inclusion
          : providerDecision?.systemInclusion
        if (providerDecision?.systemInclusion === "excluded" || providerInclusion === "excluded") {
          withheldLegIds.add(row.id)
          continue
        }
        if (row.transactionId === null) {
          continue
        }
        const representationSystemAssetId = resolveSystemAssetId({
          decisions,
          assetId: row.assetId,
          assetRepresentationId: row.assetRepresentationId,
        })
        const systemAssetId = mayUseProviderFallback
          ? (providerDecision?.systemAssetId ?? representationSystemAssetId)
          : representationSystemAssetId
        const effectiveAssetId = resolvePrincipalAssetId({
          decisions,
          systemAssetId,
          assetRepresentationId: row.assetRepresentationId,
          providerAssetRowId: mayUseProviderFallback ? providerAssetRowId : null,
        })
        const identityKey = `${row.transactionId}\0${systemAssetId}`
        const earlierAssetId = effectiveAssetByTransactionSystemAsset.get(identityKey)
        if (earlierAssetId !== undefined && earlierAssetId !== effectiveAssetId) {
          withheldTransactionIds.add(row.transactionId)
        } else {
          effectiveAssetByTransactionSystemAsset.set(identityKey, effectiveAssetId)
        }
      }

      for (const row of rows) {
        if (
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId))
        ) {
          continue
        }
        if (
          row.transactionId !== null &&
          row.kind !== "fee" &&
          !isReconciledEconomicLeg(row) &&
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
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId)) ||
          isReconciledEconomicLeg(row) ||
          row.derivationRule === "internal_transfer_in" ||
          row.derivationRule === "internal_transfer_out"
        ) {
          continue
        }

        const reference =
          row.kind === "fee" && row.feeTransactionId !== null
            ? transactionReference({
                externalGroupId: row.feeExternalGroupId,
                externalId: row.feeExternalId,
                transactionId: row.feeTransactionId,
              })
            : transactionReference(row)
        const common = {
          id: row.id,
          occurredAt: { epochMillis: row.timestamp.getTime() },
          assetId: resolvePrincipalAssetId({
            decisions,
            systemAssetId: row.assetId,
            assetRepresentationId: row.assetRepresentationId,
            providerAssetRowId:
              row.assetRepresentationId === null && !row.hasExactProviderObservation
                ? providerAssetRowIdFromMetadata(row.metadata)
                : null,
          }),
          quantity: row.amount,
          ...(reference === undefined ? {} : { transactionReference: reference }),
        }

        if (row.kind === "acquisition" || row.kind === "income") {
          const event = yield* decodeRequired({
            schema: AcquisitionEvent,
            input: {
              _tag: "acquisition",
              ...common,
              custodySourceId: row.sourceId,
              cause: acquisitionCause(row.transactionType),
            },
            operation: "factualLedgerRepository.load.event",
          })
          events.push(event)
          eventRows.push({ event, row })
          continue
        }

        const event = yield* decodeRequired({
          schema: DispositionEvent,
          input: {
            _tag: "disposition",
            ...common,
            custodySourceId: row.sourceId,
            cause: dispositionCause({ kind: row.kind, transactionType: row.transactionType }),
          },
          operation: "factualLedgerRepository.load.event",
        })
        events.push(event)
        eventRows.push({ event, row })
      }

      return { events, eventRows, eventCountByTransactionId }
    })

  type LoadedLegEvents = Effect.Success<ReturnType<typeof loadLegEvents>>

  const loadCustodyMovementEvents = ({
    decisions,
    principalId,
  }: Pick<LoadParams, "principalId"> & {
    readonly decisions: PrincipalAssetOverrideDecisions
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transferReconciliations.id,
          providerTransactionId: providerTransactionTable.id,
          canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
          canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
          providerDirection: schema.providerTransfers.direction,
          providerSourceId: providerTransactionTable.sourceId,
          canonicalSourceId: canonicalTransactionTable.sourceId,
          canonicalTimestamp: canonicalTransactionTable.timestamp,
          canonicalExternalId: canonicalTransactionTable.externalId,
          canonicalExternalGroupId: canonicalTransactionTable.externalGroupId,
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          assetId: schema.transfers.assetId,
          assetRepresentationId: schema.transfers.assetRepresentationId,
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
      const reconciledCanonicalTransferIds = new Set<string>()
      const reconciledProviderTransactionIds = new Set<string>()
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
        reconciledCanonicalTransferIds.add(row.canonicalTransferId)
        reconciledProviderTransactionIds.add(row.providerTransactionId)
        const providerDecision =
          row.providerAssetRowId === null
            ? undefined
            : decisions.providerAssetDecisionById.get(row.providerAssetRowId)
        if (providerDecision?.systemInclusion === "excluded") continue

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
          yield* decodeRequired({
            schema: CustodyMovementEvent,
            input: {
              _tag: "custody_movement",
              id: row.id,
              occurredAt: { epochMillis: row.canonicalTimestamp.getTime() },
              assetId: resolvePrincipalAssetId({
                decisions,
                systemAssetId: row.assetId,
                assetRepresentationId: row.assetRepresentationId,
              }),
              quantity: row.amount,
              ...(reference === undefined ? {} : { transactionReference: reference }),
              fromCustodySourceId,
              toCustodySourceId,
            },
            operation: "factualLedgerRepository.load.event",
          })
        )
      }

      return { events, reconciledCanonicalTransferIds, reconciledProviderTransactionIds }
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
          const providerAmount = decodeValuationDecimal(row.providerFiatAmount)
          if (
            providerAmount === undefined ||
            row.providerFiatAmount.startsWith("-") ||
            BigDecimal.isNegative(providerAmount)
          ) {
            continue
          }

          const providerResourcePath = trimmedNonEmpty(row.providerResourcePath)
          const evidenceReference =
            providerResourcePath === undefined
              ? row.transactionSourceRawRecordId === null
                ? `transaction:${row.transactionId}`
                : `source_raw_record:${row.transactionSourceRawRecordId}`
              : providerResourcePath

          valuationFacts.push(
            yield* decodeRequired({
              schema: ObservedConsiderationFact,
              input: {
                _tag: "observed_consideration",
                eventId: event.id,
                amount: {
                  amount: row.providerFiatAmount,
                  currency: reportingCurrency,
                },
                evidenceReference,
              },
              operation: "factualLedgerRepository.load.observedConsideration",
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
    if (reportingCurrency !== "EUR") return Effect.succeed([])

    const eventAssetIds = [...new Set(events.map(({ assetId }) => assetId))]
    const eventDayStarts = [
      ...new Set(events.map((event) => utcDay(event.occurredAt.toDate()))),
    ].map(utcDayStart)

    return eventAssetIds.length === 0 || eventDayStarts.length === 0
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
              inArray(schema.assetPrices.timestamp, eventDayStarts)
            )
          )
          .orderBy(asc(schema.assetPrices.assetId), asc(schema.assetPrices.timestamp))
          .pipe(wrapSqlError("factualLedgerRepository.load.prices"))
  }

  type PriceRows = Effect.Success<ReturnType<typeof loadPriceRows>>

  const priceRowKey = ({ assetId, timestamp }: Pick<PriceRows[number], "assetId" | "timestamp">) =>
    `${assetId}:${utcDay(timestamp)}`

  const makePriceQuoteMap = (priceRows: PriceRows): ReadonlyMap<string, PriceRows[number]> => {
    const quotes = new Map<string, PriceRows[number]>()

    for (const row of priceRows) {
      const value = decodeValuationDecimal(row.price)
      if (
        value === undefined ||
        !BigDecimal.isPositive(value) ||
        row.source === null ||
        row.source === "" ||
        row.source !== row.source.trim()
      ) {
        continue
      }

      quotes.set(priceRowKey(row), row)
    }

    return quotes
  }

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
      const quotes = makePriceQuoteMap(priceRows)

      for (const event of events) {
        const quote = quotes.get(
          priceRowKey({ assetId: event.assetId, timestamp: event.occurredAt.toDate() })
        )
        if (quote === undefined) continue

        valuationFacts.push(
          yield* decodeRequired({
            schema: MarketQuoteFact,
            input: {
              _tag: "market_quote",
              eventId: event.id,
              unitPrice: {
                amount: quote.price,
                currency: reportingCurrency,
              },
              quotedAt: { epochMillis: quote.timestamp.getTime() },
              source: quote.source,
            },
            operation: "factualLedgerRepository.load.marketQuote",
          })
        )
      }

      return valuationFacts
    })

  const load: FactualLedgerRepositoryShape["load"] = ({ principalId, reportingCurrency }) =>
    Effect.gen(function* () {
      const supportedReportingCurrency = yield* validateReportingCurrency(reportingCurrency)
      const providerAssetMetadataRows = yield* db
        .select({ metadata: schema.transactionLegs.metadata })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .pipe(wrapSqlError("factualLedgerRepository.load.providerAssetRows"))
      const providerTransferAssetRows = yield* db
        .select({ providerAssetRowId: schema.providerTransfers.providerAssetId })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerTransferAssets"))
      const providerAssetRowIds = [
        ...providerAssetMetadataRows.flatMap(({ metadata }) => {
          const providerAssetRowId = providerAssetRowIdFromMetadata(metadata)
          return providerAssetRowId === null ? [] : [providerAssetRowId]
        }),
        ...providerTransferAssetRows.flatMap(({ providerAssetRowId }) =>
          providerAssetRowId === null ? [] : [providerAssetRowId]
        ),
      ]
      const decisions = yield* principalAssetOverrideDecisionLoader.load({
        principalId,
        providerAssetRowIds,
      })
      const membershipRows = yield* db
        .select({
          custodyUnitId: schema.custodyUnitSources.custodyUnitId,
          sourceId: schema.custodyUnitSources.sourceId,
        })
        .from(schema.custodyUnitSources)
        .where(eq(schema.custodyUnitSources.principalId, principalId))
        .orderBy(
          asc(schema.custodyUnitSources.custodyUnitId),
          asc(schema.custodyUnitSources.sourceId)
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyUnitMembership"))
      const custodyMovementEvents = yield* loadCustodyMovementEvents({ decisions, principalId })
      const legEvents = yield* loadLegEvents({
        decisions,
        principalId,
        reconciledCanonicalTransferIds: custodyMovementEvents.reconciledCanonicalTransferIds,
        reconciledProviderTransactionIds: custodyMovementEvents.reconciledProviderTransactionIds,
      })
      const events = [...legEvents.events, ...custodyMovementEvents.events].sort(compareEvents)
      const valuationEvents = events.filter((event) => event._tag !== "custody_movement")
      const observedValuationFacts = yield* makeObservedValuationFacts({
        eventRows: legEvents.eventRows,
        eventCountByTransactionId: legEvents.eventCountByTransactionId,
        reportingCurrency: supportedReportingCurrency,
      })
      const priceRows = yield* loadPriceRows({
        events: valuationEvents,
        reportingCurrency: supportedReportingCurrency,
      })
      const marketValuationFacts = yield* makeMarketValuationFacts({
        events: valuationEvents,
        priceRows,
        reportingCurrency: supportedReportingCurrency,
      })
      const valuationFacts = [...observedValuationFacts, ...marketValuationFacts].sort(
        compareValuationFacts
      )

      const custodyUnitMembership = membershipRows.map(({ custodyUnitId, sourceId }) => ({
        custodyUnitId: CustodyUnitId.make(custodyUnitId),
        sourceId: SourceId.make(sourceId),
      }))

      return {
        events,
        valuationFacts,
        custodyUnitMembership,
        principalAssetOverrideRevision: decisions.revision,
      }
    })

  return FactualLedgerRepository.of({ load })
})

/** Live factual-ledger repository layer. */
export const FactualLedgerRepositoryLive = Layer.effect(FactualLedgerRepository, make)
