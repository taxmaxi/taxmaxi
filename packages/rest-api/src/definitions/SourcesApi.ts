/**
 * SourcesApi - HTTP API group for sources
 *
 * Provides endpoints for:
 * - Syncing transactions for a source
 * - Checking sync job status for a source
 * - Calculating tax of a synced source
 *
 * @module SourcesApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { Source } from "@my/core/source"
import { InternalServerError, UnauthorizedError } from "./ApiErrors.ts"

// =============================================================================
// Source-Specific Error Schemas (with HTTP status codes)
// =============================================================================

export class SourceBadRequestError extends Schema.TaggedError<SourceBadRequestError>()(
  "SourceBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 })
) {}

export class SourceNotFoundError extends Schema.TaggedError<SourceNotFoundError>()(
  "SourceNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class SourcePaymentRequiredError extends Schema.TaggedError<SourcePaymentRequiredError>()(
  "SourcePaymentRequiredError",
  {
    message: Schema.String,
    paymentRequired: Schema.optional(Schema.Unknown),
  },
  HttpApiSchema.annotations({ status: 402 })
) {}

// =============================================================================
// Request/Response Schemas
// =============================================================================

/**
 * SourceListResponse - Started source sync job info
 */
export class SourceListResponse extends Schema.Class<SourceListResponse>("SourceListResponse")({
  sources: Schema.Array(Source),
}) {}

/**
 * SourceCreateRequest - Request body for creating or reusing an onchain source.
 */
export class SourceCreateRequest extends Schema.Class<SourceCreateRequest>("SourceCreateRequest")({
  type: Schema.Literal("onchain"),
  walletAddress: Schema.NonEmptyTrimmedString,
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  sync: Schema.optional(Schema.Boolean),
  year: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(2020))),
  jurisdiction: Schema.optional(Schema.NonEmptyTrimmedString),
}) {}

/**
 * SourceSyncStartResponse - Started source sync job info
 */
export class SourceSyncStartResponse extends Schema.Class<SourceSyncStartResponse>(
  "SourceSyncStartResponse"
)({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed"),
  message: Schema.NullOr(Schema.String),
}) {}

/**
 * SourceCreateClaimMetadata - Anonymous source claim handle.
 */
export class SourceCreateClaimMetadata extends Schema.Class<SourceCreateClaimMetadata>(
  "SourceCreateClaimMetadata"
)({
  requestId: Schema.String,
  claimToken: Schema.String,
  expiresAt: Schema.String,
}) {}

/**
 * SourceCreateResponse - Created or reused source and optional initial sync job.
 */
export class SourceCreateResponse extends Schema.Class<SourceCreateResponse>(
  "SourceCreateResponse"
)({
  source: Source,
  created: Schema.Boolean,
  syncJob: Schema.NullOr(SourceSyncStartResponse),
  claim: Schema.NullOr(SourceCreateClaimMetadata),
}) {}

/**
 * SourceSyncJobResponse - Result of a source sync job
 */
export class SourceSyncJobResponse extends Schema.Class<SourceSyncJobResponse>(
  "SourceSyncJobResponse"
)({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed"),
  importedRecords: Schema.NullOr(Schema.Number),
  normalizedRecords: Schema.NullOr(Schema.Number),
  failedRecords: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
}) {}

const currentTaxYear = new Date().getUTCFullYear()

/**
 * TaxCalculationRequest - Request body for calculating tax of a source
 */
export class TaxCalculationRequest extends Schema.Class<TaxCalculationRequest>(
  "TaxCalculationRequest"
)({
  year: Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(1970),
    Schema.lessThanOrEqualTo(currentTaxYear)
  ),
  jurisdiction: Schema.String,
}) {}

/**
 * TaxCalculationResponse - Tax calculation result of a source
 */
export class TaxCalculationResponse extends Schema.Class<TaxCalculationResponse>(
  "TaxCalculationResponse"
)({
  year: Schema.Number,
  currency: Schema.String,
  taxableGains: Schema.Number,
  taxableLosses: Schema.Number,
  taxFreeGains: Schema.Number,
  incomeTotal: Schema.Number,
}) {}

const SourceReportCursor = Schema.NullOr(Schema.String)
const SourceReportAmount = Schema.String
const SourceReportTaxableTreatment = Schema.Literal("taxable", "tax_free", "unknown")

/**
 * SourceReportPageParams - Stable cursor pagination parameters for report lists.
 */
export const SourceReportPageParams = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(100)
    )
  ),
})

/**
 * SourceReportAsset - Asset descriptor used by source report rows.
 */
export class SourceReportAsset extends Schema.Class<SourceReportAsset>("SourceReportAsset")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
}) {}

/**
 * SourceReportPageInfo - Cursor pagination metadata.
 */
export class SourceReportPageInfo extends Schema.Class<SourceReportPageInfo>(
  "SourceReportPageInfo"
)({
  nextCursor: SourceReportCursor,
  hasMore: Schema.Boolean,
}) {}

/**
 * SourceReportSyncStatus - Latest source sync metadata.
 */
export class SourceReportSyncStatus extends Schema.Class<SourceReportSyncStatus>(
  "SourceReportSyncStatus"
)({
  status: Schema.NullOr(Schema.Literal("pending", "processing", "completed", "failed")),
  mode: Schema.NullOr(Schema.Literal("sync", "replay")),
  queuedAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastErrorMessage: Schema.NullOr(Schema.String),
  importedRecords: Schema.NullOr(Schema.Number),
  normalizedRecords: Schema.NullOr(Schema.Number),
  failedRecords: Schema.NullOr(Schema.Number),
}) {}

/**
 * SourceReportTotals - High-level source report counters and totals.
 */
export class SourceReportTotals extends Schema.Class<SourceReportTotals>("SourceReportTotals")({
  transactionCount: Schema.Number,
  legCount: Schema.Number,
  assetCount: Schema.Number,
  fifoLotCount: Schema.Number,
  disposalCount: Schema.Number,
  incomeCount: Schema.Number,
  feeCount: Schema.Number,
  realizedGainLoss: SourceReportAmount,
  incomeTotal: SourceReportAmount,
  currency: Schema.NullOr(Schema.String),
}) {}

/**
 * SourceOverviewResponse - Source metadata plus report counters.
 */
export class SourceOverviewResponse extends Schema.Class<SourceOverviewResponse>(
  "SourceOverviewResponse"
)({
  source: Source,
  latestSync: SourceReportSyncStatus,
  totals: SourceReportTotals,
}) {}

/**
 * SourceAssetPnlRow - Per-asset P&L report row.
 */
export class SourceAssetPnlRow extends Schema.Class<SourceAssetPnlRow>("SourceAssetPnlRow")({
  asset: SourceReportAsset,
  acquiredAmount: SourceReportAmount,
  disposedAmount: SourceReportAmount,
  openAmount: SourceReportAmount,
  costBasis: SourceReportAmount,
  proceeds: SourceReportAmount,
  realizedGainLoss: SourceReportAmount,
  currency: Schema.NullOr(Schema.String),
}) {}

export class SourceAssetPnlResponse extends Schema.Class<SourceAssetPnlResponse>(
  "SourceAssetPnlResponse"
)({
  assets: Schema.Array(SourceAssetPnlRow),
}) {}

/**
 * SourceTransactionMovement - Asset movement nested under a transaction row.
 */
export class SourceTransactionMovement extends Schema.Class<SourceTransactionMovement>(
  "SourceTransactionMovement"
)({
  legId: Schema.String,
  asset: SourceReportAsset,
  kind: Schema.Literal("acquisition", "disposal", "income", "fee"),
  amount: SourceReportAmount,
  fiatAmount: Schema.NullOr(SourceReportAmount),
  fiatCurrency: Schema.NullOr(Schema.String),
  provenance: Schema.Literal("deterministic", "rule", "ai", "manual"),
  derivationRule: Schema.NullOr(Schema.String),
}) {}

export class SourceTransactionRow extends Schema.Class<SourceTransactionRow>(
  "SourceTransactionRow"
)({
  transactionId: Schema.String,
  timestamp: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  externalGroupId: Schema.NullOr(Schema.String),
  transactionType: Schema.NullOr(Schema.String),
  providerTransactionType: Schema.NullOr(Schema.String),
  providerStatus: Schema.NullOr(Schema.String),
  providerDescription: Schema.NullOr(Schema.String),
  movements: Schema.Array(SourceTransactionMovement),
}) {}

export class SourceTransactionsResponse extends Schema.Class<SourceTransactionsResponse>(
  "SourceTransactionsResponse"
)({
  transactions: Schema.Array(SourceTransactionRow),
  page: SourceReportPageInfo,
}) {}

export class SourceTaxEventRow extends Schema.Class<SourceTaxEventRow>("SourceTaxEventRow")({
  legId: Schema.String,
  transactionId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  kind: Schema.Literal("acquisition", "disposal", "income", "fee"),
  asset: SourceReportAsset,
  amount: SourceReportAmount,
  fiatAmount: Schema.NullOr(SourceReportAmount),
  fiatCurrency: Schema.NullOr(Schema.String),
  costBasis: Schema.NullOr(SourceReportAmount),
  proceeds: Schema.NullOr(SourceReportAmount),
  gainLoss: Schema.NullOr(SourceReportAmount),
  taxableTreatment: SourceReportTaxableTreatment,
  provenance: Schema.Literal("deterministic", "rule", "ai", "manual"),
  derivationRule: Schema.NullOr(Schema.String),
}) {}

export class SourceTaxEventsResponse extends Schema.Class<SourceTaxEventsResponse>(
  "SourceTaxEventsResponse"
)({
  taxEvents: Schema.Array(SourceTaxEventRow),
  page: SourceReportPageInfo,
}) {}

export class SourceFifoLotDisposalSummary extends Schema.Class<SourceFifoLotDisposalSummary>(
  "SourceFifoLotDisposalSummary"
)({
  disposalLegId: Schema.String,
  matchedAmount: SourceReportAmount,
  proceeds: SourceReportAmount,
  costBasis: SourceReportAmount,
  gainLoss: SourceReportAmount,
}) {}

export class SourceFifoLotRow extends Schema.Class<SourceFifoLotRow>("SourceFifoLotRow")({
  lotId: Schema.String,
  asset: SourceReportAsset,
  acquiredAt: Schema.String,
  originalAmount: SourceReportAmount,
  remainingAmount: SourceReportAmount,
  costBasisPerToken: SourceReportAmount,
  costBasisCurrency: Schema.String,
  sourceLegId: Schema.String,
  disposalMatches: Schema.Array(SourceFifoLotDisposalSummary),
}) {}

export class SourceFifoLotsResponse extends Schema.Class<SourceFifoLotsResponse>(
  "SourceFifoLotsResponse"
)({
  fifoLots: Schema.Array(SourceFifoLotRow),
  page: SourceReportPageInfo,
}) {}

export class SourceDisposalMatchedLot extends Schema.Class<SourceDisposalMatchedLot>(
  "SourceDisposalMatchedLot"
)({
  lotId: Schema.String,
  asset: SourceReportAsset,
  acquiredAt: Schema.String,
  matchedAmount: SourceReportAmount,
  costBasis: SourceReportAmount,
  proceeds: SourceReportAmount,
  gainLoss: SourceReportAmount,
}) {}

export class SourceDisposalExplanationResponse extends Schema.Class<SourceDisposalExplanationResponse>(
  "SourceDisposalExplanationResponse"
)({
  disposalLegId: Schema.String,
  transactionId: Schema.NullOr(Schema.String),
  asset: SourceReportAsset,
  amount: SourceReportAmount,
  proceeds: Schema.NullOr(SourceReportAmount),
  costBasis: SourceReportAmount,
  gainLoss: SourceReportAmount,
  acquiredAt: Schema.NullOr(Schema.String),
  disposedAt: Schema.String,
  taxableTreatment: SourceReportTaxableTreatment,
  provenance: Schema.Literal("deterministic", "rule", "ai", "manual"),
  derivationRule: Schema.NullOr(Schema.String),
  matchedLots: Schema.Array(SourceDisposalMatchedLot),
}) {}

// =============================================================================
// Protected API Endpoints
// =============================================================================

/**
 * GET /sources - List all sources for the authenticated user
 */
const listSources = HttpApiEndpoint.get("listSources", "/sources")
  .addSuccess(SourceListResponse)
  .addError(SourceBadRequestError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List sources",
      description: "Lists all sources for the authenticated user.",
    })
  )

/**
 * POST /sources - Create or reuse a source for the authenticated user.
 */
const createSource = HttpApiEndpoint.post("createSource", "/sources")
  .setPayload(SourceCreateRequest)
  .addSuccess(SourceCreateResponse)
  .addError(SourceBadRequestError)
  .addError(UnauthorizedError)
  .addError(SourcePaymentRequiredError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Create source",
      description:
        "Creates or reuses an onchain source for an authenticated user, or creates an anonymous wallet source when no credentials are present.",
    })
  )

/**
 * POST /sources/:provider/sync - Start a source sync job
 */
const startSourceSyncJob = HttpApiEndpoint.post("startSourceSyncJob", "/sources/:sourceId/sync")
  .setPath(
    Schema.Struct({
      sourceId: Schema.String,
    })
  )
  .addSuccess(SourceSyncStartResponse)
  .addError(SourceBadRequestError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Start source sync",
      description: "Starts sync for the specified source or returns active/completed job",
    })
  )

/**
 * POST /sources/:sourceId/replay - Reset derived source data and replay cached raw rows
 */
const replaySourceSyncJob = HttpApiEndpoint.post("replaySourceSyncJob", "/sources/:sourceId/replay")
  .setPath(
    Schema.Struct({
      sourceId: Schema.String,
    })
  )
  .addSuccess(SourceSyncStartResponse)
  .addError(SourceBadRequestError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Replay source normalization",
      description:
        "Resets canonical data for the specified source and rebuilds it from cached raw provider records.",
    })
  )

/**
 * GET /sources/:sourceId/jobs/:jobId - Get status of a source sync job
 */
const getSourceSyncJobStatus = HttpApiEndpoint.get(
  "getSourceSyncJobStatus",
  "/sources/:sourceId/jobs/:jobId"
)
  .setPath(
    Schema.Struct({
      sourceId: Schema.String,
      jobId: Schema.String,
    })
  )
  .addSuccess(SourceSyncJobResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Get source sync job status",
      description: "Returns sync job status and counters for the authenticated user.",
    })
  )

/**
 * POST /sources/:sourceId/tax - Calculate tax of a source in a given jurisdiction
 */
const calculateTaxForSource = HttpApiEndpoint.post(
  "calculateTaxForSource",
  "/sources/:sourceId/tax"
)
  .setPath(
    Schema.Struct({
      sourceId: Schema.String,
    })
  )
  .setPayload(TaxCalculationRequest)
  .addSuccess(TaxCalculationResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Calculate tax for source",
      description: "Calculates jurisdiction-oriented tax from normalized FIFO and income data.",
    })
  )

const getSourceOverview = HttpApiEndpoint.get("getSourceOverview", "/sources/:sourceId/overview")
  .setPath(Schema.Struct({ sourceId: Schema.String }))
  .addSuccess(SourceOverviewResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Get source overview",
      description: "Returns source metadata, latest sync status, and report counters.",
    })
  )

const listSourceAssetPnl = HttpApiEndpoint.get(
  "listSourceAssetPnl",
  "/sources/:sourceId/assets/pnl"
)
  .setPath(Schema.Struct({ sourceId: Schema.String }))
  .addSuccess(SourceAssetPnlResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List source asset P&L",
      description: "Returns source-scoped per-asset inventory and realized P&L rows.",
    })
  )

const listSourceTransactions = HttpApiEndpoint.get(
  "listSourceTransactions",
  "/sources/:sourceId/transactions"
)
  .setPath(Schema.Struct({ sourceId: Schema.String }))
  .setUrlParams(SourceReportPageParams)
  .addSuccess(SourceTransactionsResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List source transactions",
      description: "Returns paginated source-scoped normalized transaction rows.",
    })
  )

const listSourceTaxEvents = HttpApiEndpoint.get(
  "listSourceTaxEvents",
  "/sources/:sourceId/tax-events"
)
  .setPath(Schema.Struct({ sourceId: Schema.String }))
  .setUrlParams(SourceReportPageParams)
  .addSuccess(SourceTaxEventsResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List source tax events",
      description: "Returns paginated tax-visible read projections from canonical rows.",
    })
  )

const listSourceFifoLots = HttpApiEndpoint.get("listSourceFifoLots", "/sources/:sourceId/fifo-lots")
  .setPath(Schema.Struct({ sourceId: Schema.String }))
  .setUrlParams(SourceReportPageParams)
  .addSuccess(SourceFifoLotsResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List source FIFO lots",
      description: "Returns paginated source-scoped FIFO lots and disposal match summaries.",
    })
  )

const explainSourceDisposal = HttpApiEndpoint.get(
  "explainSourceDisposal",
  "/sources/:sourceId/disposals/:legId/explanation"
)
  .setPath(Schema.Struct({ sourceId: Schema.String, legId: Schema.String }))
  .addSuccess(SourceDisposalExplanationResponse)
  .addError(SourceBadRequestError)
  .addError(SourceNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Explain source disposal",
      description: "Returns deterministic FIFO derivation details for a disposal leg.",
    })
  )

// =============================================================================
// API Groups
// =============================================================================

/**
 * SourcesApi - Protected sources endpoints
 */
export class SourcesApi extends HttpApiGroup.make("sources")
  .add(listSources)
  .add(startSourceSyncJob)
  .add(replaySourceSyncJob)
  .add(getSourceSyncJobStatus)
  .add(calculateTaxForSource)
  .add(getSourceOverview)
  .add(listSourceAssetPnl)
  .add(listSourceTransactions)
  .add(listSourceTaxEvents)
  .add(listSourceFifoLots)
  .add(explainSourceDisposal)
  .middlewareEndpoints(AuthMiddleware)
  .add(createSource)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Sources",
      description: "Endpoints for syncing sources and calculating their tax",
    })
  ) {}
