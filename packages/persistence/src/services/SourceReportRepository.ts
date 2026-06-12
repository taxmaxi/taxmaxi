/**
 * SourceReportRepository - Source-scoped report read projections.
 *
 * @module SourceReportRepository
 */

import type { ReportReviewReasonCode } from "@my/core/report"
import type { Source } from "@my/core/source"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * SourceReportSourceNotFoundError - Source is absent or not owned by the principal.
 */
export class SourceReportSourceNotFoundError extends Schema.TaggedError<SourceReportSourceNotFoundError>()(
  "SourceReportSourceNotFoundError",
  {
    sourceId: Schema.String,
  }
) {
  override get message(): string {
    return `Source not found: ${this.sourceId}`
  }
}

/**
 * SourceReportInvalidCursorError - Cursor cannot be decoded for the requested list.
 */
export class SourceReportInvalidCursorError extends Schema.TaggedError<SourceReportInvalidCursorError>()(
  "SourceReportInvalidCursorError",
  {
    cursor: Schema.String,
  }
) {
  override get message(): string {
    return "Invalid report pagination cursor."
  }
}

export type SourceReportRepositoryError =
  | SourceReportSourceNotFoundError
  | SourceReportInvalidCursorError
  | PersistenceError

export interface SourceReportScope {
  readonly principalId: string
  readonly sourceId: string
}

export interface SourceReportPageParams extends SourceReportScope {
  readonly cursor: string | null
  readonly limit: number
}

export type SourceReportTaxableTreatment =
  | "taxable"
  | "tax_free"
  | "deductible"
  | "non_taxable"
  | "unknown"
  | "mixed"

export interface SourceReportPage<T> {
  readonly items: ReadonlyArray<T>
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface SourceReportSyncStatus {
  readonly status: "pending" | "processing" | "completed" | "failed" | null
  readonly mode: "sync" | "replay" | null
  readonly queuedAt: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly lastSyncedAt: string | null
  readonly lastErrorMessage: string | null
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
}

export interface SourceReportReviewIssue {
  readonly code: ReportReviewReasonCode
  readonly count: number
  readonly blocking: boolean
  readonly summary: string
}

export interface SourceReportReviewSummary {
  readonly status: "ok" | "needs_review"
  readonly needsReviewCount: number
  readonly blockingIssueCount: number
  readonly issues: ReadonlyArray<SourceReportReviewIssue>
}

export interface SourceReportTotals {
  readonly transactionCount: number
  readonly legCount: number
  readonly assetCount: number
  readonly fifoLotCount: number
  readonly disposalCount: number
  readonly incomeCount: number
  readonly feeCount: number
  readonly realizedGainLoss: string
  readonly incomeTotal: string
  readonly currency: string | null
}

export interface SourceOverviewReport {
  readonly source: Source
  readonly latestSync: SourceReportSyncStatus
  readonly totals: SourceReportTotals
  readonly review: SourceReportReviewSummary
}

export interface SourceReportAsset {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
}

export interface SourceAssetPnlRow {
  readonly asset: SourceReportAsset
  readonly acquiredAmount: string
  readonly disposedAmount: string
  readonly openAmount: string
  readonly costBasis: string
  readonly proceeds: string
  readonly realizedGainLoss: string
  readonly currency: string | null
  readonly review: SourceReportReviewSummary
}

export interface SourceTransactionMovement {
  readonly legId: string
  readonly asset: SourceReportAsset
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly amount: string
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly provenance: "deterministic" | "rule" | "ai" | "manual"
  readonly derivationRule: string | null
}

export interface SourceTransactionRow {
  readonly transactionId: string
  readonly timestamp: string
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly providerStatus: string | null
  readonly providerDescription: string | null
  readonly movements: ReadonlyArray<SourceTransactionMovement>
}

export interface SourceTaxEventRow {
  readonly legId: string
  readonly transactionId: string | null
  readonly timestamp: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly asset: SourceReportAsset
  readonly amount: string
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly costBasis: string | null
  readonly proceeds: string | null
  readonly gainLoss: string | null
  readonly taxableTreatment: SourceReportTaxableTreatment
  readonly provenance: "deterministic" | "rule" | "ai" | "manual"
  readonly derivationRule: string | null
}

export interface SourceFifoLotDisposalSummary {
  readonly disposalLegId: string
  readonly matchedAmount: string
  readonly proceeds: string
  readonly costBasis: string
  readonly gainLoss: string
}

export interface SourceFifoLotRow {
  readonly lotId: string
  readonly asset: SourceReportAsset
  readonly acquiredAt: string
  readonly originalAmount: string
  readonly remainingAmount: string
  readonly costBasisPerToken: string
  readonly costBasisCurrency: string
  readonly sourceLegId: string
  readonly disposalMatches: ReadonlyArray<SourceFifoLotDisposalSummary>
}

export interface SourceDisposalMatchedLot {
  readonly lotId: string
  readonly asset: SourceReportAsset
  readonly acquiredAt: string
  readonly matchedAmount: string
  readonly costBasis: string
  readonly proceeds: string
  readonly gainLoss: string
  readonly taxableTreatment: SourceReportTaxableTreatment
}

export interface SourceDisposalExplanation {
  readonly disposalLegId: string
  readonly transactionId: string | null
  readonly asset: SourceReportAsset
  readonly amount: string
  readonly proceeds: string | null
  readonly costBasis: string
  readonly gainLoss: string
  readonly acquiredAt: string | null
  readonly disposedAt: string
  readonly taxableTreatment: SourceReportTaxableTreatment
  readonly provenance: "deterministic" | "rule" | "ai" | "manual"
  readonly derivationRule: string | null
  readonly matchedLots: ReadonlyArray<SourceDisposalMatchedLot>
}

/**
 * SourceReportRepositoryService - Durable report read operations for source screens.
 */
export interface SourceReportRepositoryService {
  readonly getOverview: (
    params: SourceReportScope
  ) => Effect.Effect<SourceOverviewReport, SourceReportRepositoryError>
  readonly listAssetPnl: (
    params: SourceReportScope
  ) => Effect.Effect<ReadonlyArray<SourceAssetPnlRow>, SourceReportRepositoryError>
  readonly listTransactions: (
    params: SourceReportPageParams
  ) => Effect.Effect<SourceReportPage<SourceTransactionRow>, SourceReportRepositoryError>
  readonly listTaxEvents: (
    params: SourceReportPageParams
  ) => Effect.Effect<SourceReportPage<SourceTaxEventRow>, SourceReportRepositoryError>
  readonly listFifoLots: (
    params: SourceReportPageParams
  ) => Effect.Effect<SourceReportPage<SourceFifoLotRow>, SourceReportRepositoryError>
  readonly explainDisposal: (
    params: SourceReportScope & { readonly legId: string }
  ) => Effect.Effect<SourceDisposalExplanation, SourceReportRepositoryError>
}

/**
 * SourceReportRepository - Context tag for source report read projections.
 */
export class SourceReportRepository extends Context.Tag("@my/persistence/SourceReportRepository")<
  SourceReportRepository,
  SourceReportRepositoryService
>() {}
