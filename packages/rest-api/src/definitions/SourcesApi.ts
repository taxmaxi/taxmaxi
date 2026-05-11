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
import { InternalServerError } from "./ApiErrors.ts"

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
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Sources",
      description: "Endpoints for syncing sources and calculating their tax",
    })
  ) {}
