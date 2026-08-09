/**
 * SourceReportRepositoryLive - Drizzle-backed source report read projections.
 *
 * @module SourceReportRepositoryLive
 */

import { and, asc, count, desc, eq, gt, inArray, lt, or } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { REPORT_REVIEW_REASON_CODES, type ReportReviewReasonCode } from "@my/core/report"
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
  type SourceReportReviewIssue,
  type SourceReportReviewSummary,
  type SourceReportScope,
  type SourceReportSyncStatus,
  type SourceReportTaxableTreatment,
  type SourceReportTotals,
  type SourceTaxEventRow,
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
  hasPendingCostBasis: boolean
  hasPendingProceeds: boolean
  hasPendingRealizedGainLoss: boolean
}

interface ReviewProjectionRow {
  readonly reviewId: string
  readonly matchedLayer: string | null
  readonly assetId: string | null
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

const pluralize = (count: number, singular: string, plural: string): string =>
  count === 1 ? singular : plural

type SourceReportReviewIssueDefinition = {
  readonly matchedLayer: string
  readonly blocking: boolean
  readonly summary: (count: number) => string
}

const sourceReportReviewIssueDefinitions: Record<
  ReportReviewReasonCode,
  SourceReportReviewIssueDefinition
> = {
  fifo_inventory_shortfall: {
    matchedLayer: "fifo_inventory",
    blocking: true,
    summary: (count: number) =>
      `${count} ${pluralize(
        count,
        "disposal",
        "disposals"
      )} cannot be matched to available FIFO inventory.`,
  },
} as const

const summarizeReviewRows = (
  rows: ReadonlyArray<ReviewProjectionRow>
): SourceReportReviewSummary => {
  const reviewIds = new Set(rows.map((row) => row.reviewId))
  const issues = REPORT_REVIEW_REASON_CODES.flatMap(
    (code): ReadonlyArray<SourceReportReviewIssue> => {
      const definition = sourceReportReviewIssueDefinitions[code]
      const issueReviewIds = new Set(
        rows
          .filter((row) =>
            (row.matchedLayer ?? "")
              .split(",")
              .some((layer) => layer.trim() === definition.matchedLayer)
          )
          .map((row) => row.reviewId)
      )
      const count = issueReviewIds.size
      if (count === 0) {
        return []
      }
      return [
        {
          code,
          count,
          blocking: definition.blocking,
          summary: definition.summary(count),
        },
      ]
    }
  )
  const needsReviewCount = reviewIds.size
  const blockingIssueCount = issues
    .filter((issue) => issue.blocking)
    .reduce((count, issue) => count + issue.count, 0)

  if (needsReviewCount === 0) {
    return {
      status: "ok",
      needsReviewCount: 0,
      blockingIssueCount: 0,
      issues: [],
    }
  }

  return {
    status: "needs_review",
    needsReviewCount,
    blockingIssueCount,
    issues,
  }
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

  const loadReportReviewRows = ({ sourceId }: { readonly sourceId: string }) =>
    db
      .select({
        reviewId: schema.transactionReviews.id,
        matchedLayer: schema.transactionReviews.matchedLayer,
        assetId: schema.transactionLegs.assetId,
      })
      .from(schema.transactionReviews)
      .innerJoin(
        schema.transactions,
        eq(schema.transactionReviews.transactionId, schema.transactions.id)
      )
      .leftJoin(
        schema.transactionLegs,
        and(
          eq(schema.transactionLegs.transactionId, schema.transactions.id),
          eq(schema.transactionLegs.kind, "disposal")
        )
      )
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactionReviews.needsReview, true)
        )
      )
      .pipe(wrapSqlError("sourceReportRepository.loadReportReviewRows"))

  const getOverview: SourceReportRepositoryService["getOverview"] = (params) =>
    Effect.gen(function* () {
      const source = yield* loadOwnedSource(params)
      const latestSync = yield* loadLatestSync({ sourceId: params.sourceId })
      const reviewRows = yield* loadReportReviewRows({ sourceId: params.sourceId })
      const [transactionCount] = yield* db
        .select({ count: count(schema.transactions.id) })
        .from(schema.transactions)
        .where(eq(schema.transactions.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.transactionCount"))
      const legRows = yield* db
        .select({
          legId: schema.transactionLegs.id,
          assetId: schema.transactionLegs.assetId,
          kind: schema.transactionLegs.kind,
          amount: schema.transactionLegs.amount,
          derivationRule: schema.transactionLegs.derivationRule,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
        })
        .from(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.legs"))
      const fifoLotRows = yield* db
        .select({ assetId: schema.fifoLots.assetId })
        .from(schema.fifoLots)
        .where(eq(schema.fifoLots.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.fifoLots"))
      const matchRows = yield* db
        .select({
          disposalLegId: schema.disposalMatches.disposalLegId,
          matchedAmount: schema.disposalMatches.matchedAmount,
          gainLoss: schema.disposalMatches.gainLoss,
          proceedsCurrency: schema.transactionLegs.fiatCurrency,
          costBasisStatus: schema.fifoLots.costBasisStatus,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
        )
        .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.matches"))

      let realizedGainLoss = zeroDecimal()
      let hasPendingRealizedGainLoss = false
      let currency: string | null = null
      for (const row of matchRows) {
        if (row.derivationRule === "internal_transfer_out") {
          continue
        }
        if (row.costBasisStatus === "pending_review") {
          hasPendingRealizedGainLoss = true
          currency = emptyCurrency(currency, row.proceedsCurrency)
          continue
        }
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.getOverview.gainLoss",
          value: row.gainLoss,
        })
        realizedGainLoss = BigDecimal.sum(realizedGainLoss, amount)
        currency = emptyCurrency(currency, row.proceedsCurrency)
      }

      for (const leg of legRows) {
        if (leg.kind !== "disposal" || leg.derivationRule === "internal_transfer_out") {
          continue
        }
        if (leg.fiatAmount === null || leg.fiatCurrency === null) {
          hasPendingRealizedGainLoss = true
        }
        const disposalAmount = BigDecimal.abs(
          yield* decodeDecimal({
            operation: "sourceReportRepository.getOverview.disposalAmount",
            value: leg.amount,
          })
        )
        let matchedAmount = zeroDecimal()
        for (const match of matchRows) {
          if (match.disposalLegId !== leg.legId) {
            continue
          }
          matchedAmount = BigDecimal.sum(
            matchedAmount,
            yield* decodeDecimal({
              operation: "sourceReportRepository.getOverview.matchedAmount",
              value: match.matchedAmount,
            })
          )
        }
        if (!BigDecimal.equals(disposalAmount, matchedAmount)) {
          hasPendingRealizedGainLoss = true
        }
      }

      let incomeTotal = zeroDecimal()
      const assetIds = new Set<string>()
      let disposalCount = 0
      let incomeCount = 0
      let feeCount = 0
      for (const row of legRows) {
        assetIds.add(row.assetId)
        if (row.kind === "disposal" && row.derivationRule !== "internal_transfer_out") {
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
      for (const row of fifoLotRows) {
        assetIds.add(row.assetId)
      }

      const totals = {
        transactionCount: transactionCount?.count ?? 0,
        legCount: legRows.length,
        assetCount: assetIds.size,
        fifoLotCount: fifoLotRows.length,
        disposalCount,
        incomeCount,
        feeCount,
        realizedGainLoss: hasPendingRealizedGainLoss ? null : formatDecimal(realizedGainLoss),
        incomeTotal: formatDecimal(incomeTotal),
        currency,
      } satisfies SourceReportTotals

      return { source, latestSync, totals, review: summarizeReviewRows(reviewRows) }
    })

  const listAssetPnl: SourceReportRepositoryService["listAssetPnl"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const reviewRows = yield* loadReportReviewRows({ sourceId: params.sourceId })
      const legRows = yield* db
        .select({
          legId: schema.transactionLegs.id,
          assetId: schema.transactionLegs.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          kind: schema.transactionLegs.kind,
          amount: schema.transactionLegs.amount,
          derivationRule: schema.transactionLegs.derivationRule,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
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
          originalAmount: schema.fifoLots.originalAmount,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
          costBasisCurrency: schema.fifoLots.costBasisCurrency,
          costBasisStatus: schema.fifoLots.costBasisStatus,
          sourceLegId: schema.fifoLots.sourceLegId,
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
          gainLoss: schema.disposalMatches.gainLoss,
          derivationRule: schema.transactionLegs.derivationRule,
          costBasisStatus: schema.fifoLots.costBasisStatus,
          disposalLegId: schema.disposalMatches.disposalLegId,
          disposalAmount: schema.transactionLegs.amount,
          matchedAmount: schema.disposalMatches.matchedAmount,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
        )
        .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.matches"))

      const custodyAllocationRows = yield* db
        .select({
          assetId: schema.inventoryMovements.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
        })
        .from(schema.inventoryMovementAllocations)
        .innerJoin(
          schema.inventoryMovements,
          eq(schema.inventoryMovementAllocations.inventoryMovementId, schema.inventoryMovements.id)
        )
        .innerJoin(schema.assets, eq(schema.inventoryMovements.assetId, schema.assets.id))
        .where(
          and(
            eq(schema.inventoryMovements.sourceId, params.sourceId),
            eq(schema.inventoryMovements.direction, "outbound")
          )
        )
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.custodyAllocations"))

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
          hasPendingCostBasis: false,
          hasPendingProceeds: false,
          hasPendingRealizedGainLoss: false,
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
          const fiatAmount = yield* optionalDecimal({
            operation: "sourceReportRepository.listAssetPnl.fiatAmount",
            value: row.fiatAmount,
          })
          if (Option.isNone(fiatAmount) || row.fiatCurrency === null) {
            accumulator.hasPendingProceeds = true
            accumulator.hasPendingRealizedGainLoss = true
          } else {
            accumulator.proceeds = BigDecimal.sum(
              accumulator.proceeds,
              BigDecimal.abs(fiatAmount.value)
            )
            accumulator.currency = emptyCurrency(accumulator.currency, row.fiatCurrency)
          }
        }
      }

      for (const row of lotRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        if (row.sourceLegId === null) {
          const originalAmount = yield* decodeDecimal({
            operation: "sourceReportRepository.listAssetPnl.originalAmount",
            value: row.originalAmount,
          })
          accumulator.acquiredAmount = BigDecimal.sum(accumulator.acquiredAmount, originalAmount)
        }
        const remainingAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.remainingAmount",
          value: row.remainingAmount,
        })
        if (
          row.costBasisStatus === "pending_review" &&
          BigDecimal.greaterThan(remainingAmount, zeroDecimal())
        ) {
          accumulator.hasPendingCostBasis = true
        }
        const costBasisPerToken = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.costBasisPerToken",
          value: row.costBasisPerToken,
        })
        accumulator.openAmount = BigDecimal.sum(accumulator.openAmount, remainingAmount)
        accumulator.openCostBasis = BigDecimal.sum(
          accumulator.openCostBasis,
          BigDecimal.round(BigDecimal.multiply(remainingAmount, costBasisPerToken), { scale: 8 })
        )
        if (row.costBasisStatus === "known") {
          accumulator.currency = emptyCurrency(accumulator.currency, row.costBasisCurrency)
        }
      }

      for (const row of custodyAllocationRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        const matchedAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.custodyAllocationAmount",
          value: row.matchedAmount,
        })
        accumulator.disposedAmount = BigDecimal.sum(accumulator.disposedAmount, matchedAmount)
      }

      for (const row of matchRows) {
        if (row.derivationRule === "internal_transfer_out") {
          continue
        }
        const accumulator = getAccumulator(assetFromRow(row))
        const gainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.gainLoss",
          value: row.gainLoss,
        })
        if (row.costBasisStatus === "pending_review") {
          accumulator.hasPendingRealizedGainLoss = true
        } else {
          accumulator.realizedGainLoss = BigDecimal.sum(accumulator.realizedGainLoss, gainLoss)
        }
      }

      const disposalCoverage = new Map<
        string,
        {
          readonly accumulator: AssetAccumulator
          matched: BigDecimal.BigDecimal
          required: BigDecimal.BigDecimal
        }
      >()
      for (const row of matchRows) {
        if (row.derivationRule === "internal_transfer_out") {
          continue
        }
        const existing = disposalCoverage.get(row.disposalLegId)
        const matchedAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.matchedAmount",
          value: row.matchedAmount,
        })
        if (existing === undefined) {
          disposalCoverage.set(row.disposalLegId, {
            accumulator: getAccumulator(assetFromRow(row)),
            matched: matchedAmount,
            required: BigDecimal.abs(
              yield* decodeDecimal({
                operation: "sourceReportRepository.listAssetPnl.disposalAmount",
                value: row.disposalAmount,
              })
            ),
          })
        } else {
          existing.matched = BigDecimal.sum(existing.matched, matchedAmount)
        }
      }
      for (const row of legRows) {
        if (row.kind !== "disposal" || row.derivationRule === "internal_transfer_out") {
          continue
        }
        const coverage = disposalCoverage.get(row.legId)
        if (coverage === undefined || !BigDecimal.equals(coverage.matched, coverage.required)) {
          getAccumulator(assetFromRow(row)).hasPendingRealizedGainLoss = true
        }
      }

      const reviewRowsByAssetId = new Map<string, ReadonlyArray<ReviewProjectionRow>>()
      for (const row of reviewRows) {
        if (row.assetId === null) {
          continue
        }
        const existing = reviewRowsByAssetId.get(row.assetId) ?? []
        reviewRowsByAssetId.set(row.assetId, [...existing, row])
      }

      return Array.from(accumulators.values())
        .sort((left, right) => left.asset.symbol.localeCompare(right.asset.symbol))
        .map(
          (row): SourceAssetPnlRow => ({
            asset: row.asset,
            acquiredAmount: formatDecimal(row.acquiredAmount),
            disposedAmount: formatDecimal(row.disposedAmount),
            openAmount: formatDecimal(row.openAmount),
            costBasis: row.hasPendingCostBasis ? null : formatDecimal(row.openCostBasis),
            costBasisStatus: row.hasPendingCostBasis ? "pending_review" : "known",
            proceeds: row.hasPendingProceeds ? null : formatDecimal(row.proceeds),
            realizedGainLoss: row.hasPendingRealizedGainLoss
              ? null
              : formatDecimal(row.realizedGainLoss),
            currency: row.currency,
            review: summarizeReviewRows(reviewRowsByAssetId.get(row.asset.assetId) ?? []),
          })
        )
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
                gainLoss: schema.disposalMatches.gainLoss,
                acquiredAt: schema.fifoLots.acquiredAt,
                costBasisStatus: schema.fifoLots.costBasisStatus,
                matchedAmount: schema.disposalMatches.matchedAmount,
              })
              .from(schema.disposalMatches)
              .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
              .where(inArray(schema.disposalMatches.disposalLegId, legIds))
              .pipe(wrapSqlError("sourceReportRepository.listTaxEvents.matches"))

      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          let costBasis = zeroDecimal()
          let gainLoss = zeroDecimal()
          let matchedAmount = zeroDecimal()

          const treatments: Array<SourceReportTaxableTreatment> = []
          const matches = matchRows.filter((match) => match.disposalLegId === row.legId)
          const hasPendingCostBasis = matches.some(
            (match) => match.costBasisStatus === "pending_review"
          )

          for (const match of matches) {
            const matchCostBasis = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.costBasis",
              value: match.costBasis,
            })
            const matchGainLoss = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.gainLoss",
              value: match.gainLoss,
            })
            costBasis = BigDecimal.sum(costBasis, matchCostBasis)
            gainLoss = BigDecimal.sum(gainLoss, matchGainLoss)
            matchedAmount = BigDecimal.sum(
              matchedAmount,
              yield* decodeDecimal({
                operation: "sourceReportRepository.listTaxEvents.matchedAmount",
                value: match.matchedAmount,
              })
            )
            treatments.push(
              taxableTreatmentForDates({ acquiredAt: match.acquiredAt, disposedAt: row.timestamp })
            )
          }

          const amount = yield* decodeDecimal({
            operation: "sourceReportRepository.listTaxEvents.amount",
            value: row.amount,
          })
          const fiatAmount = yield* optionalDecimal({
            operation: "sourceReportRepository.listTaxEvents.fiatAmount",
            value: row.fiatAmount,
          })
          const hasIncompleteCoverage =
            row.kind === "disposal" && !BigDecimal.equals(BigDecimal.abs(amount), matchedAmount)
          const hasIncompleteGainLoss =
            hasPendingCostBasis ||
            hasIncompleteCoverage ||
            Option.isNone(fiatAmount) ||
            row.fiatCurrency === null

          return {
            legId: row.legId,
            transactionId: row.transactionId,
            timestamp: row.timestamp.toISOString(),
            kind: row.kind,
            asset: assetFromRow(row),
            amount: formatDecimal(amount),
            fiatAmount: Option.match(fiatAmount, {
              onNone: () => null,
              onSome: formatDecimal,
            }),
            fiatCurrency: row.fiatCurrency,
            costBasis:
              matches.length === 0 || hasPendingCostBasis || hasIncompleteCoverage
                ? null
                : formatDecimal(costBasis),
            proceeds:
              row.kind !== "disposal"
                ? null
                : Option.match(fiatAmount, {
                    onNone: () => null,
                    onSome: (value) => (row.fiatCurrency === null ? null : formatDecimal(value)),
                  }),
            gainLoss:
              matches.length === 0 || hasIncompleteGainLoss ? null : formatDecimal(gainLoss),
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
          costBasisStatus: schema.fifoLots.costBasisStatus,
          sourceLegId: schema.fifoLots.sourceLegId,
          sourceProviderTransferId: schema.fifoLots.sourceProviderTransferId,
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
                costBasisStatus: schema.fifoLots.costBasisStatus,
                disposalFiatAmount: schema.transactionLegs.fiatAmount,
                disposalFiatCurrency: schema.transactionLegs.fiatCurrency,
              })
              .from(schema.disposalMatches)
              .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
              .innerJoin(
                schema.transactionLegs,
                eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
              )
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
                proceeds:
                  row.disposalFiatAmount === null || row.disposalFiatCurrency === null
                    ? null
                    : formatDecimal(proceeds),
                costBasis: row.costBasisStatus === "known" ? formatDecimal(costBasis) : null,
                gainLoss:
                  row.costBasisStatus === "known" &&
                  row.disposalFiatAmount !== null &&
                  row.disposalFiatCurrency !== null
                    ? formatDecimal(gainLoss)
                    : null,
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
          const costBasisPerToken =
            row.costBasisStatus === "known"
              ? yield* decodeDecimal({
                  operation: "sourceReportRepository.listFifoLots.costBasisPerToken",
                  value: row.costBasisPerToken,
                })
              : null

          return {
            lotId: row.lotId,
            asset: assetFromRow(row),
            acquiredAt: row.acquiredAt.toISOString(),
            originalAmount: formatDecimal(originalAmount),
            remainingAmount: formatDecimal(remainingAmount),
            costBasisPerToken: costBasisPerToken === null ? null : formatDecimal(costBasisPerToken),
            costBasisCurrency: row.costBasisStatus === "known" ? row.costBasisCurrency : null,
            costBasisStatus: row.costBasisStatus,
            sourceLegId: row.sourceLegId,
            sourceProviderTransferId: row.sourceProviderTransferId,
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
          fiatCurrency: schema.transactionLegs.fiatCurrency,
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
          costBasisStatus: schema.fifoLots.costBasisStatus,
        })
        .from(schema.disposalMatches)
        .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
        .innerJoin(schema.assets, eq(schema.fifoLots.assetId, schema.assets.id))
        .where(eq(schema.disposalMatches.disposalLegId, params.legId))
        .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.id))
        .pipe(wrapSqlError("sourceReportRepository.explainDisposal.matches"))

      let costBasis = zeroDecimal()
      let gainLoss = zeroDecimal()
      let firstAcquiredAt: Date | null = null
      let hasPendingCostBasis = false
      let matchedAmountTotal = zeroDecimal()

      const matchedLots: Array<SourceDisposalMatchedLot> = []

      for (const row of matches) {
        if (row.costBasisStatus === "pending_review") {
          hasPendingCostBasis = true
        }
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
        matchedAmountTotal = BigDecimal.sum(matchedAmountTotal, matchedAmount)

        costBasis = BigDecimal.sum(costBasis, rowCostBasis)
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
          costBasis: row.costBasisStatus === "known" ? formatDecimal(rowCostBasis) : null,
          proceeds:
            leg.fiatAmount === null || leg.fiatCurrency === null
              ? null
              : formatDecimal(rowProceeds),
          gainLoss:
            row.costBasisStatus === "known" && leg.fiatAmount !== null && leg.fiatCurrency !== null
              ? formatDecimal(rowGainLoss)
              : null,
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
      const hasIncompleteCoverage = !BigDecimal.equals(BigDecimal.abs(amount), matchedAmountTotal)
      const hasIncompleteGainLoss =
        hasPendingCostBasis ||
        hasIncompleteCoverage ||
        Option.isNone(fiatAmount) ||
        leg.fiatCurrency === null

      return {
        disposalLegId: leg.legId,
        transactionId: leg.transactionId,
        asset: assetFromRow(leg),
        amount: formatDecimal(amount),
        proceeds: Option.match(fiatAmount, {
          onNone: () => null,
          onSome: (value) => (leg.fiatCurrency === null ? null : formatDecimal(value)),
        }),
        costBasis: hasPendingCostBasis || hasIncompleteCoverage ? null : formatDecimal(costBasis),
        gainLoss: hasIncompleteGainLoss ? null : formatDecimal(gainLoss),
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
    listTaxEvents,
    listFifoLots,
    explainDisposal,
  } satisfies SourceReportRepositoryService
})

/**
 * SourceReportRepositoryLive - Live layer for source report read projections.
 */
export const SourceReportRepositoryLive = Layer.effect(SourceReportRepository, make)
