/**
 * SourceReportRepositoryLive - Drizzle-backed source report read projections.
 *
 * @module SourceReportRepositoryLive
 */

import { and, asc, count, desc, eq, gt, inArray, lt, or } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import {
  CexSourceRef,
  DexSourceRef,
  OnchainSourceRef,
  Source,
  SourceId,
  type SourceRef,
} from "@my/core/source"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema, type SourceRow } from "../schema/index.ts"
import { decodeSourceSyncJobProgressSnapshot } from "./SyncEngineRepositorySupport.ts"
import {
  SourceReportInvalidCursorError,
  SourceReportRepository,
  SourceReportSourceNotFoundError,
  type SourceAssetPnlRow,
  type SourceDisposalExplanation,
  type SourceDisposalMatchedLot,
  type SourceFifoLotDisposalSummary,
  type SourceFifoLotRow,
  type SourceReportAsset,
  type SourceReportPage,
  type SourceReportRepositoryService,
  type SourceReportScope,
  type SourceReportSyncStatus,
  type SourceReportTaxableTreatment,
  type SourceReportTotals,
  type SourceTaxEventRow,
  type SourceTransactionMovement,
  type SourceTransactionRow,
} from "../services/SourceReportRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedSourceRow = Pick<
  SourceRow,
  | "id"
  | "principalId"
  | "name"
  | "providerKey"
  | "sourceableType"
  | "addressId"
  | "cexAccountId"
  | "createdAt"
>

interface CursorParts {
  readonly timestamp: Date
  readonly id: string
}

interface AssetAccumulator {
  readonly asset: SourceReportAsset
  acquiredAmount: BigDecimal.BigDecimal
  disposedAmount: BigDecimal.BigDecimal
  openAmount: BigDecimal.BigDecimal
  openCostBasis: BigDecimal.BigDecimal
  proceeds: BigDecimal.BigDecimal
  realizedGainLoss: BigDecimal.BigDecimal
  currency: string | null
}

const zeroDecimal = (): BigDecimal.BigDecimal => BigDecimal.fromBigInt(0n)
const formatDecimal = (value: BigDecimal.BigDecimal): string => BigDecimal.format(value)
const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString()
const emptyCurrency = (current: string | null, next: string | null): string | null => {
  if (next === null) {
    return current
  }
  if (current === null) {
    return next
  }
  return current === next ? current : "mixed"
}

const holdingPeriodEnd = (acquiredAt: Date): Date => {
  const end = new Date(acquiredAt.getTime())
  end.setUTCFullYear(end.getUTCFullYear() + 1)
  return end
}

const taxableTreatmentForDates = ({
  acquiredAt,
  disposedAt,
}: {
  readonly acquiredAt: Date | null
  readonly disposedAt: Date
}): SourceReportTaxableTreatment => {
  if (acquiredAt === null) {
    return "unknown"
  }
  return disposedAt.getTime() >= holdingPeriodEnd(acquiredAt).getTime() ? "tax_free" : "taxable"
}

const combineTaxableTreatments = (
  treatments: ReadonlyArray<SourceReportTaxableTreatment>
): SourceReportTaxableTreatment => {
  const unique = new Set(treatments)
  if (unique.size === 0) {
    return "unknown"
  }
  if (unique.size === 1) {
    return treatments[0] ?? "unknown"
  }
  return "mixed"
}

const disposalTaxableTreatment = ({
  derivationRule,
  treatments,
}: {
  readonly derivationRule: string | null
  readonly treatments: ReadonlyArray<SourceReportTaxableTreatment>
}): SourceReportTaxableTreatment =>
  derivationRule === "internal_transfer_out" ? "non_taxable" : combineTaxableTreatments(treatments)

const acquisitionTaxableTreatment = ({
  derivationRule,
}: {
  readonly derivationRule: string | null
}): SourceReportTaxableTreatment =>
  derivationRule === "internal_transfer_in" ? "non_taxable" : "unknown"

const makeCursor = ({ timestamp, id }: CursorParts): string => `${timestamp.toISOString()}|${id}`
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (value: string): boolean => uuidPattern.test(value)

const parseCursor = (cursor: string | null) =>
  Effect.gen(function* () {
    if (cursor === null) {
      return Option.none<CursorParts>()
    }

    const parts = cursor.split("|")
    const timestampPart = parts[0]
    const idPart = parts[1]
    if (parts.length !== 2 || timestampPart === undefined || idPart === undefined) {
      return yield* Effect.fail(new SourceReportInvalidCursorError({ cursor }))
    }

    const timestamp = new Date(timestampPart)
    if (Number.isNaN(timestamp.getTime()) || !isUuid(idPart)) {
      return yield* Effect.fail(new SourceReportInvalidCursorError({ cursor }))
    }

    return Option.some({ timestamp, id: idPart })
  })

const decodeDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  Schema.decodeUnknown(Schema.BigDecimal)(value).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation,
          cause: `Invalid decimal value: ${String(value)}`,
        })
    )
  )

const optionalDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  value === null
    ? Effect.succeed<Option.Option<BigDecimal.BigDecimal>>(Option.none())
    : decodeDecimal({ operation, value }).pipe(Effect.map(Option.some))

const makePage = <T>({
  cursorFor,
  limit,
  rows,
}: {
  readonly rows: ReadonlyArray<T>
  readonly limit: number
  readonly cursorFor: (row: T) => string
}): SourceReportPage<T> => {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last !== undefined ? cursorFor(last) : null,
    hasMore,
  }
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSourceFields = {
    id: schema.sources.id,
    principalId: schema.sources.principalId,
    name: schema.sources.name,
    providerKey: schema.sources.providerKey,
    sourceableType: schema.sources.sourceableType,
    addressId: schema.sources.addressId,
    cexAccountId: schema.sources.cexAccountId,
    createdAt: schema.sources.createdAt,
  } as const

  const rowToSourceRef = (row: SelectedSourceRow): Effect.Effect<SourceRef> => {
    switch (row.sourceableType) {
      case "onchain":
        if (row.addressId === null) {
          return Effect.dieMessage(`Source ${row.id} is onchain but has no addressId`)
        }
        return Effect.succeed(OnchainSourceRef.make({ addressId: row.addressId }))
      case "cex":
        if (row.cexAccountId === null) {
          return Effect.dieMessage(`Source ${row.id} is cex but has no cexAccountId`)
        }
        return Effect.succeed(CexSourceRef.make({ cexAccountId: row.cexAccountId }))
      case "dex":
        if (row.addressId === null) {
          return Effect.dieMessage(`Source ${row.id} is dex but has no addressId`)
        }
        return Effect.succeed(DexSourceRef.make({ addressId: row.addressId }))
    }
  }

  const rowToSource = (row: SelectedSourceRow): Effect.Effect<Source> =>
    Effect.gen(function* () {
      const sourceRef = yield* rowToSourceRef(row)
      return Source.make({
        id: SourceId.make(row.id),
        principalId: PrincipalId.make(row.principalId),
        name: row.name,
        providerKey: row.providerKey,
        sourceRef,
        createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
      })
    })

  const loadOwnedSource = ({ principalId, sourceId }: SourceReportScope) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectSourceFields)
        .from(schema.sources)
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.principalId, principalId)))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadOwnedSource"))

      if (row === undefined) {
        return yield* Effect.fail(new SourceReportSourceNotFoundError({ sourceId }))
      }

      return yield* rowToSource(row)
    })

  const assetFromRow = (row: {
    readonly assetId: string
    readonly symbol: string
    readonly name: string
  }): SourceReportAsset => ({
    assetId: row.assetId,
    symbol: row.symbol,
    name: row.name,
  })

  const loadLatestSync = ({ sourceId }: { readonly sourceId: string }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select({
          status: schema.processingJobs.status,
          mode: schema.processingJobs.mode,
          queuedAt: schema.processingJobs.queuedAt,
          startedAt: schema.processingJobs.startedAt,
          completedAt: schema.processingJobs.completedAt,
          progressDetails: schema.processingJobs.progressDetails,
        })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, sourceId))
        .orderBy(desc(schema.processingJobs.createdAt), desc(schema.processingJobs.id))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadLatestSync.job"))

      const [state] = yield* db
        .select({
          lastSyncedAt: schema.sourceSyncState.lastSyncedAt,
          lastErrorMessage: schema.sourceSyncState.lastErrorMessage,
        })
        .from(schema.sourceSyncState)
        .where(eq(schema.sourceSyncState.sourceId, sourceId))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadLatestSync.state"))

      const progress = yield* decodeSourceSyncJobProgressSnapshot(job?.progressDetails ?? null)

      return {
        status: job?.status ?? null,
        mode: job?.mode ?? null,
        queuedAt: isoOrNull(job?.queuedAt ?? null),
        startedAt: isoOrNull(job?.startedAt ?? null),
        completedAt: isoOrNull(job?.completedAt ?? null),
        lastSyncedAt: isoOrNull(state?.lastSyncedAt ?? null),
        lastErrorMessage: state?.lastErrorMessage ?? null,
        importedRecords: progress?.importedRecords ?? null,
        normalizedRecords: progress?.normalizedRecords ?? null,
        failedRecords: progress?.failedRecords ?? null,
      } satisfies SourceReportSyncStatus
    })

  const getOverview: SourceReportRepositoryService["getOverview"] = (params) =>
    Effect.gen(function* () {
      const source = yield* loadOwnedSource(params)
      const latestSync = yield* loadLatestSync({ sourceId: params.sourceId })
      const [transactionCount] = yield* db
        .select({ count: count(schema.transactions.id) })
        .from(schema.transactions)
        .where(eq(schema.transactions.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.transactionCount"))
      const legRows = yield* db
        .select({
          assetId: schema.transactionLegs.assetId,
          kind: schema.transactionLegs.kind,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
        })
        .from(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.legs"))
      const [fifoLotCount] = yield* db
        .select({ count: count(schema.fifoLots.id) })
        .from(schema.fifoLots)
        .where(eq(schema.fifoLots.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.fifoLotCount"))
      const matchRows = yield* db
        .select({
          gainLoss: schema.disposalMatches.gainLoss,
          proceeds: schema.disposalMatches.proceeds,
          proceedsCurrency: schema.transactionLegs.fiatCurrency,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
        )
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.matches"))

      let realizedGainLoss = zeroDecimal()
      let currency: string | null = null
      for (const row of matchRows) {
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.getOverview.gainLoss",
          value: row.gainLoss,
        })
        realizedGainLoss = BigDecimal.sum(realizedGainLoss, amount)
        currency = emptyCurrency(currency, row.proceedsCurrency)
      }

      let incomeTotal = zeroDecimal()
      const assetIds = new Set<string>()
      let disposalCount = 0
      let incomeCount = 0
      let feeCount = 0
      for (const row of legRows) {
        assetIds.add(row.assetId)
        if (row.kind === "disposal") {
          disposalCount += 1
        }
        if (row.kind === "fee") {
          feeCount += 1
        }
        if (row.kind === "income") {
          incomeCount += 1
          currency = emptyCurrency(currency, row.fiatCurrency)
          const maybeAmount = yield* optionalDecimal({
            operation: "sourceReportRepository.getOverview.incomeFiatAmount",
            value: row.fiatAmount,
          })
          if (Option.isSome(maybeAmount)) {
            incomeTotal = BigDecimal.sum(incomeTotal, maybeAmount.value)
          }
        }
      }

      const totals = {
        transactionCount: transactionCount?.count ?? 0,
        legCount: legRows.length,
        assetCount: assetIds.size,
        fifoLotCount: fifoLotCount?.count ?? 0,
        disposalCount,
        incomeCount,
        feeCount,
        realizedGainLoss: formatDecimal(realizedGainLoss),
        incomeTotal: formatDecimal(incomeTotal),
        currency,
      } satisfies SourceReportTotals

      return { source, latestSync, totals }
    })

  const listAssetPnl: SourceReportRepositoryService["listAssetPnl"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const legRows = yield* db
        .select({
          assetId: schema.transactionLegs.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          kind: schema.transactionLegs.kind,
          amount: schema.transactionLegs.amount,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.id))
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.legs"))
      const lotRows = yield* db
        .select({
          assetId: schema.fifoLots.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
          costBasisCurrency: schema.fifoLots.costBasisCurrency,
        })
        .from(schema.fifoLots)
        .innerJoin(schema.assets, eq(schema.fifoLots.assetId, schema.assets.id))
        .where(eq(schema.fifoLots.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.lots"))
      const matchRows = yield* db
        .select({
          assetId: schema.transactionLegs.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          proceeds: schema.disposalMatches.proceeds,
          gainLoss: schema.disposalMatches.gainLoss,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
        )
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.matches"))

      const accumulators = new Map<string, AssetAccumulator>()
      const getAccumulator = (asset: SourceReportAsset): AssetAccumulator => {
        const existing = accumulators.get(asset.assetId)
        if (existing !== undefined) {
          return existing
        }
        const created: AssetAccumulator = {
          asset,
          acquiredAmount: zeroDecimal(),
          disposedAmount: zeroDecimal(),
          openAmount: zeroDecimal(),
          openCostBasis: zeroDecimal(),
          proceeds: zeroDecimal(),
          realizedGainLoss: zeroDecimal(),
          currency: null,
        }
        accumulators.set(asset.assetId, created)
        return created
      }

      for (const row of legRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.legAmount",
          value: row.amount,
        })
        if (
          (row.kind === "acquisition" || row.kind === "income") &&
          row.derivationRule !== "internal_transfer_in"
        ) {
          accumulator.acquiredAmount = BigDecimal.sum(accumulator.acquiredAmount, amount)
        }
        if (row.kind === "disposal" && row.derivationRule !== "internal_transfer_out") {
          accumulator.disposedAmount = BigDecimal.sum(
            accumulator.disposedAmount,
            BigDecimal.abs(amount)
          )
        }
      }

      for (const row of lotRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        const remainingAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.remainingAmount",
          value: row.remainingAmount,
        })
        const costBasisPerToken = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.costBasisPerToken",
          value: row.costBasisPerToken,
        })
        accumulator.openAmount = BigDecimal.sum(accumulator.openAmount, remainingAmount)
        accumulator.openCostBasis = BigDecimal.sum(
          accumulator.openCostBasis,
          BigDecimal.round(BigDecimal.multiply(remainingAmount, costBasisPerToken), { scale: 8 })
        )
        accumulator.currency = emptyCurrency(accumulator.currency, row.costBasisCurrency)
      }

      for (const row of matchRows) {
        if (row.derivationRule === "internal_transfer_out") {
          continue
        }
        const accumulator = getAccumulator(assetFromRow(row))
        const proceeds = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.proceeds",
          value: row.proceeds,
        })
        const gainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.gainLoss",
          value: row.gainLoss,
        })
        accumulator.proceeds = BigDecimal.sum(accumulator.proceeds, proceeds)
        accumulator.realizedGainLoss = BigDecimal.sum(accumulator.realizedGainLoss, gainLoss)
        accumulator.currency = emptyCurrency(accumulator.currency, row.fiatCurrency)
      }

      return Array.from(accumulators.values())
        .sort((left, right) => left.asset.symbol.localeCompare(right.asset.symbol))
        .map(
          (row): SourceAssetPnlRow => ({
            asset: row.asset,
            acquiredAmount: formatDecimal(row.acquiredAmount),
            disposedAmount: formatDecimal(row.disposedAmount),
            openAmount: formatDecimal(row.openAmount),
            costBasis: formatDecimal(row.openCostBasis),
            proceeds: formatDecimal(row.proceeds),
            realizedGainLoss: formatDecimal(row.realizedGainLoss),
            currency: row.currency,
          })
        )
    })

  const listTransactions: SourceReportRepositoryService["listTransactions"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            lt(schema.transactions.timestamp, value.timestamp),
            and(
              eq(schema.transactions.timestamp, value.timestamp),
              lt(schema.transactions.id, value.id)
            )
          ),
      })
      const rows = yield* db
        .select({
          transactionId: schema.transactions.id,
          timestamp: schema.transactions.timestamp,
          externalId: schema.transactions.externalId,
          externalGroupId: schema.transactions.externalGroupId,
          transactionType: schema.transactions.transactionType,
          providerTransactionType: schema.transactions.providerTransactionType,
          providerStatus: schema.transactions.providerStatus,
          providerDescription: schema.transactions.providerDescription,
        })
        .from(schema.transactions)
        .where(
          cursorPredicate === undefined
            ? eq(schema.transactions.sourceId, params.sourceId)
            : and(eq(schema.transactions.sourceId, params.sourceId), cursorPredicate)
        )
        .orderBy(desc(schema.transactions.timestamp), desc(schema.transactions.id))
        .limit(params.limit + 1)
        .pipe(wrapSqlError("sourceReportRepository.listTransactions.transactions"))
      const transactionIds = rows.map((row) => row.transactionId)
      const movementRows =
        transactionIds.length === 0
          ? []
          : yield* db
              .select({
                transactionId: schema.transactionLegs.transactionId,
                legId: schema.transactionLegs.id,
                assetId: schema.assets.id,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                kind: schema.transactionLegs.kind,
                amount: schema.transactionLegs.amount,
                fiatAmount: schema.transactionLegs.fiatAmount,
                fiatCurrency: schema.transactionLegs.fiatCurrency,
                provenance: schema.transactionLegs.provenance,
                derivationRule: schema.transactionLegs.derivationRule,
              })
              .from(schema.transactionLegs)
              .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
              .where(inArray(schema.transactionLegs.transactionId, transactionIds))
              .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
              .pipe(wrapSqlError("sourceReportRepository.listTransactions.movements"))
      const movementsByTransaction = new Map<string, ReadonlyArray<SourceTransactionMovement>>()
      for (const transactionId of transactionIds) {
        const movements = movementRows
          .filter((row) => row.transactionId === transactionId)
          .map(
            (row): SourceTransactionMovement => ({
              legId: row.legId,
              asset: assetFromRow(row),
              kind: row.kind,
              amount: String(row.amount),
              fiatAmount: row.fiatAmount === null ? null : String(row.fiatAmount),
              fiatCurrency: row.fiatCurrency,
              provenance: row.provenance,
              derivationRule: row.derivationRule,
            })
          )
        movementsByTransaction.set(transactionId, movements)
      }
      const items = rows.map(
        (row): SourceTransactionRow => ({
          transactionId: row.transactionId,
          timestamp: row.timestamp.toISOString(),
          externalId: row.externalId,
          externalGroupId: row.externalGroupId,
          transactionType: row.transactionType,
          providerTransactionType: row.providerTransactionType,
          providerStatus: row.providerStatus,
          providerDescription: row.providerDescription,
          movements: movementsByTransaction.get(row.transactionId) ?? [],
        })
      )
      return makePage({
        rows: items,
        limit: params.limit,
        cursorFor: (row) =>
          makeCursor({ timestamp: new Date(row.timestamp), id: row.transactionId }),
      })
    })

  const listTaxEvents: SourceReportRepositoryService["listTaxEvents"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            lt(schema.transactionLegs.timestamp, value.timestamp),
            and(
              eq(schema.transactionLegs.timestamp, value.timestamp),
              lt(schema.transactionLegs.id, value.id)
            )
          ),
      })
      const rows = yield* db
        .select({
          legId: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
          timestamp: schema.transactionLegs.timestamp,
          kind: schema.transactionLegs.kind,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          amount: schema.transactionLegs.amount,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
          provenance: schema.transactionLegs.provenance,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(
          cursorPredicate === undefined
            ? eq(schema.transactionLegs.sourceId, params.sourceId)
            : and(eq(schema.transactionLegs.sourceId, params.sourceId), cursorPredicate)
        )
        .orderBy(desc(schema.transactionLegs.timestamp), desc(schema.transactionLegs.id))
        .limit(params.limit + 1)
        .pipe(wrapSqlError("sourceReportRepository.listTaxEvents"))
      const legIds = rows.map((row) => row.legId)
      const matchRows =
        legIds.length === 0
          ? []
          : yield* db
              .select({
                disposalLegId: schema.disposalMatches.disposalLegId,
                costBasis: schema.disposalMatches.costBasis,
                proceeds: schema.disposalMatches.proceeds,
                gainLoss: schema.disposalMatches.gainLoss,
                acquiredAt: schema.fifoLots.acquiredAt,
              })
              .from(schema.disposalMatches)
              .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
              .where(inArray(schema.disposalMatches.disposalLegId, legIds))
              .pipe(wrapSqlError("sourceReportRepository.listTaxEvents.matches"))
      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          let costBasis = zeroDecimal()
          let proceeds = zeroDecimal()
          let gainLoss = zeroDecimal()
          const treatments: Array<SourceReportTaxableTreatment> = []
          const matches = matchRows.filter((match) => match.disposalLegId === row.legId)
          for (const match of matches) {
            const matchCostBasis = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.costBasis",
              value: match.costBasis,
            })
            const matchProceeds = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.proceeds",
              value: match.proceeds,
            })
            const matchGainLoss = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.gainLoss",
              value: match.gainLoss,
            })
            costBasis = BigDecimal.sum(costBasis, matchCostBasis)
            proceeds = BigDecimal.sum(proceeds, matchProceeds)
            gainLoss = BigDecimal.sum(gainLoss, matchGainLoss)
            treatments.push(
              taxableTreatmentForDates({ acquiredAt: match.acquiredAt, disposedAt: row.timestamp })
            )
          }

          return {
            legId: row.legId,
            transactionId: row.transactionId,
            timestamp: row.timestamp.toISOString(),
            kind: row.kind,
            asset: assetFromRow(row),
            amount: String(row.amount),
            fiatAmount: row.fiatAmount === null ? null : String(row.fiatAmount),
            fiatCurrency: row.fiatCurrency,
            costBasis: matches.length === 0 ? null : formatDecimal(costBasis),
            proceeds: matches.length === 0 ? null : formatDecimal(proceeds),
            gainLoss: matches.length === 0 ? null : formatDecimal(gainLoss),
            taxableTreatment:
              row.kind === "disposal"
                ? disposalTaxableTreatment({
                    derivationRule: row.derivationRule,
                    treatments,
                  })
                : row.kind === "income"
                  ? "taxable"
                  : row.kind === "fee"
                    ? "deductible"
                    : acquisitionTaxableTreatment({ derivationRule: row.derivationRule }),
            provenance: row.provenance,
            derivationRule: row.derivationRule,
          } satisfies SourceTaxEventRow
        })
      )
      return makePage({
        rows: items,
        limit: params.limit,
        cursorFor: (row) => makeCursor({ timestamp: new Date(row.timestamp), id: row.legId }),
      })
    })

  const listFifoLots: SourceReportRepositoryService["listFifoLots"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            gt(schema.fifoLots.acquiredAt, value.timestamp),
            and(eq(schema.fifoLots.acquiredAt, value.timestamp), gt(schema.fifoLots.id, value.id))
          ),
      })
      const rows = yield* db
        .select({
          lotId: schema.fifoLots.id,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          acquiredAt: schema.fifoLots.acquiredAt,
          originalAmount: schema.fifoLots.originalAmount,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
          costBasisCurrency: schema.fifoLots.costBasisCurrency,
          sourceLegId: schema.fifoLots.sourceLegId,
        })
        .from(schema.fifoLots)
        .innerJoin(schema.assets, eq(schema.fifoLots.assetId, schema.assets.id))
        .where(
          cursorPredicate === undefined
            ? eq(schema.fifoLots.sourceId, params.sourceId)
            : and(eq(schema.fifoLots.sourceId, params.sourceId), cursorPredicate)
        )
        .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.id))
        .limit(params.limit + 1)
        .pipe(wrapSqlError("sourceReportRepository.listFifoLots.lots"))
      const lotIds = rows.map((row) => row.lotId)
      const matchRows =
        lotIds.length === 0
          ? []
          : yield* db
              .select({
                lotId: schema.disposalMatches.fifoLotId,
                disposalLegId: schema.disposalMatches.disposalLegId,
                matchedAmount: schema.disposalMatches.matchedAmount,
                proceeds: schema.disposalMatches.proceeds,
                costBasis: schema.disposalMatches.costBasis,
                gainLoss: schema.disposalMatches.gainLoss,
              })
              .from(schema.disposalMatches)
              .where(inArray(schema.disposalMatches.fifoLotId, lotIds))
              .orderBy(asc(schema.disposalMatches.createdAt), asc(schema.disposalMatches.id))
              .pipe(wrapSqlError("sourceReportRepository.listFifoLots.matches"))
      const matchesByLot = new Map<string, ReadonlyArray<SourceFifoLotDisposalSummary>>()
      for (const lotId of lotIds) {
        const disposalMatches = yield* Effect.forEach(
          matchRows.filter((row) => row.lotId === lotId),
          (row) =>
            Effect.gen(function* () {
              const matchedAmount = yield* decodeDecimal({
                operation: "sourceReportRepository.listFifoLots.matchedAmount",
                value: row.matchedAmount,
              })
              const proceeds = yield* decodeDecimal({
                operation: "sourceReportRepository.listFifoLots.proceeds",
                value: row.proceeds,
              })
              const costBasis = yield* decodeDecimal({
                operation: "sourceReportRepository.listFifoLots.costBasis",
                value: row.costBasis,
              })
              const gainLoss = yield* decodeDecimal({
                operation: "sourceReportRepository.listFifoLots.gainLoss",
                value: row.gainLoss,
              })

              return {
                disposalLegId: row.disposalLegId,
                matchedAmount: formatDecimal(matchedAmount),
                proceeds: formatDecimal(proceeds),
                costBasis: formatDecimal(costBasis),
                gainLoss: formatDecimal(gainLoss),
              } satisfies SourceFifoLotDisposalSummary
            })
        )

        matchesByLot.set(lotId, disposalMatches)
      }

      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const originalAmount = yield* decodeDecimal({
            operation: "sourceReportRepository.listFifoLots.originalAmount",
            value: row.originalAmount,
          })
          const remainingAmount = yield* decodeDecimal({
            operation: "sourceReportRepository.listFifoLots.remainingAmount",
            value: row.remainingAmount,
          })
          const costBasisPerToken = yield* decodeDecimal({
            operation: "sourceReportRepository.listFifoLots.costBasisPerToken",
            value: row.costBasisPerToken,
          })

          return {
            lotId: row.lotId,
            asset: assetFromRow(row),
            acquiredAt: row.acquiredAt.toISOString(),
            originalAmount: formatDecimal(originalAmount),
            remainingAmount: formatDecimal(remainingAmount),
            costBasisPerToken: formatDecimal(costBasisPerToken),
            costBasisCurrency: row.costBasisCurrency,
            sourceLegId: row.sourceLegId,
            disposalMatches: matchesByLot.get(row.lotId) ?? [],
          } satisfies SourceFifoLotRow
        })
      )
      return makePage({
        rows: items,
        limit: params.limit,
        cursorFor: (row) => makeCursor({ timestamp: new Date(row.acquiredAt), id: row.lotId }),
      })
    })

  const explainDisposal: SourceReportRepositoryService["explainDisposal"] = (params) =>
    Effect.gen(function* () {
      if (!isUuid(params.legId)) {
        return yield* Effect.fail(new SourceReportInvalidCursorError({ cursor: params.legId }))
      }

      yield* loadOwnedSource(params)
      const [leg] = yield* db
        .select({
          legId: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          amount: schema.transactionLegs.amount,
          fiatAmount: schema.transactionLegs.fiatAmount,
          timestamp: schema.transactionLegs.timestamp,
          provenance: schema.transactionLegs.provenance,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(
          and(
            eq(schema.transactionLegs.id, params.legId),
            eq(schema.transactionLegs.sourceId, params.sourceId),
            eq(schema.transactionLegs.kind, "disposal")
          )
        )
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.explainDisposal.leg"))
      if (leg === undefined) {
        return yield* Effect.fail(
          new SourceReportSourceNotFoundError({ sourceId: params.sourceId })
        )
      }

      const matches = yield* db
        .select({
          lotId: schema.fifoLots.id,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          acquiredAt: schema.fifoLots.acquiredAt,
          matchedAmount: schema.disposalMatches.matchedAmount,
          proceeds: schema.disposalMatches.proceeds,
          costBasis: schema.disposalMatches.costBasis,
          gainLoss: schema.disposalMatches.gainLoss,
        })
        .from(schema.disposalMatches)
        .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
        .innerJoin(schema.assets, eq(schema.fifoLots.assetId, schema.assets.id))
        .where(eq(schema.disposalMatches.disposalLegId, params.legId))
        .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.id))
        .pipe(wrapSqlError("sourceReportRepository.explainDisposal.matches"))

      let costBasis = zeroDecimal()
      let proceeds = zeroDecimal()
      let gainLoss = zeroDecimal()
      let firstAcquiredAt: Date | null = null
      const matchedLots: Array<SourceDisposalMatchedLot> = []
      for (const row of matches) {
        const rowCostBasis = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.costBasis",
          value: row.costBasis,
        })
        const rowProceeds = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.proceeds",
          value: row.proceeds,
        })
        const rowGainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.gainLoss",
          value: row.gainLoss,
        })
        const matchedAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.matchedAmount",
          value: row.matchedAmount,
        })
        costBasis = BigDecimal.sum(costBasis, rowCostBasis)
        proceeds = BigDecimal.sum(proceeds, rowProceeds)
        gainLoss = BigDecimal.sum(gainLoss, rowGainLoss)
        firstAcquiredAt =
          firstAcquiredAt === null || row.acquiredAt.getTime() < firstAcquiredAt.getTime()
            ? row.acquiredAt
            : firstAcquiredAt
        matchedLots.push({
          lotId: row.lotId,
          asset: assetFromRow(row),
          acquiredAt: row.acquiredAt.toISOString(),
          matchedAmount: formatDecimal(matchedAmount),
          costBasis: formatDecimal(rowCostBasis),
          proceeds: formatDecimal(rowProceeds),
          gainLoss: formatDecimal(rowGainLoss),
          taxableTreatment:
            leg.derivationRule === "internal_transfer_out"
              ? "non_taxable"
              : taxableTreatmentForDates({
                  acquiredAt: row.acquiredAt,
                  disposedAt: leg.timestamp,
                }),
        })
      }
      const amount = yield* decodeDecimal({
        operation: "sourceReportRepository.explainDisposal.amount",
        value: leg.amount,
      })
      const fiatAmount = yield* optionalDecimal({
        operation: "sourceReportRepository.explainDisposal.fiatAmount",
        value: leg.fiatAmount,
      })

      return {
        disposalLegId: leg.legId,
        transactionId: leg.transactionId,
        asset: assetFromRow(leg),
        amount: formatDecimal(amount),
        proceeds: Option.match(fiatAmount, {
          onNone: () => (matches.length === 0 ? null : formatDecimal(proceeds)),
          onSome: formatDecimal,
        }),
        costBasis: formatDecimal(costBasis),
        gainLoss: formatDecimal(gainLoss),
        acquiredAt: isoOrNull(firstAcquiredAt),
        disposedAt: leg.timestamp.toISOString(),
        taxableTreatment: disposalTaxableTreatment({
          derivationRule: leg.derivationRule,
          treatments: matchedLots.map((lot) => lot.taxableTreatment),
        }),
        provenance: leg.provenance,
        derivationRule: leg.derivationRule,
        matchedLots,
      } satisfies SourceDisposalExplanation
    })

  return {
    getOverview,
    listAssetPnl,
    listTransactions,
    listTaxEvents,
    listFifoLots,
    explainDisposal,
  } satisfies SourceReportRepositoryService
})

/**
 * SourceReportRepositoryLive - Live layer for source report read projections.
 */
export const SourceReportRepositoryLive = Layer.effect(SourceReportRepository, make)
