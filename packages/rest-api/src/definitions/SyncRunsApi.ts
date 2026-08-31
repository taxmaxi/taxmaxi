/**
 * SyncRunsApi - HTTP API group for user-wide source sync runs.
 *
 * @module SyncRunsApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class SyncRunNotFoundError extends Schema.TaggedError<SyncRunNotFoundError>()(
  "SyncRunNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class SyncCalculationRunResponse extends Schema.Class<SyncCalculationRunResponse>(
  "SyncCalculationRunResponse"
)({
  runId: Schema.String,
  status: Schema.Literals(["pending", "running", "complete", "partial", "failed"]),
  failureCode: Schema.NullOr(Schema.String),
}) {}

export class SyncRunItemResponse extends Schema.Class<SyncRunItemResponse>("SyncRunItemResponse")({
  sourceId: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  status: Schema.Literals(["queued", "running", "completed", "failed"]),
  phase: Schema.NullOr(Schema.Literals(["discovering", "classifying", "reconciling", "completed"])),
  processedRecords: Schema.NullOr(Schema.Finite),
  totalRecords: Schema.NullOr(Schema.Finite),
  progressPercent: Schema.NullOr(Schema.Finite),
  /** Raw provider records fetched and cached so far, not the count of persisted transactions. */
  fetchedRecords: Schema.NullOr(Schema.Finite),
  normalizedRecords: Schema.NullOr(Schema.Finite),
  failedRecords: Schema.NullOr(Schema.Finite),
  message: Schema.NullOr(Schema.String),
  calculationRun: Schema.NullOr(SyncCalculationRunResponse),
}) {}

export class SyncRunResponse extends Schema.Class<SyncRunResponse>("SyncRunResponse")({
  runId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "partially_failed"]),
  requestedSourceCount: Schema.Finite,
  queuedSourceCount: Schema.Finite,
  runningSourceCount: Schema.Finite,
  completedSourceCount: Schema.Finite,
  failedSourceCount: Schema.Finite,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  message: Schema.NullOr(Schema.String),
  items: Schema.Array(SyncRunItemResponse),
}) {}

const startSyncRun = HttpApiEndpoint.post("startSyncRun", "/sync-runs", {
  success: SyncRunResponse,
  error: InternalServerError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Start user-wide sync run",
    description: "Starts source sync jobs for every configured source owned by the user.",
  })
)

const getSyncRun = HttpApiEndpoint.get("getSyncRun", "/sync-runs/:runId", {
  params: Schema.Struct({
    runId: Schema.String,
  }),
  success: SyncRunResponse,
  error: [SyncRunNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get user-wide sync run",
    description: "Returns aggregate sync status and per-source item summaries.",
  })
)

/**
 * SyncRunsApi - Protected user-wide sync run endpoints.
 */
export class SyncRunsApi extends HttpApiGroup.make("syncRuns")
  .add(startSyncRun)
  .add(getSyncRun)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Sync runs",
      description: "Endpoints for user-wide source sync orchestration",
    })
  ) {}
