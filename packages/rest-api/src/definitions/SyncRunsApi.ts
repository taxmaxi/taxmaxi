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

export class SyncRunItemResponse extends Schema.Class<SyncRunItemResponse>("SyncRunItemResponse")({
  sourceId: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  status: Schema.Literals(["queued", "running", "completed", "failed"]),
  phase: Schema.NullOr(Schema.Literals(["discovering", "classifying", "reconciling", "completed"])),
  processedRecords: Schema.NullOr(Schema.Number),
  totalRecords: Schema.NullOr(Schema.Number),
  progressPercent: Schema.NullOr(Schema.Number),
  /** Raw provider records fetched and cached so far, not the count of persisted transactions. */
  fetchedRecords: Schema.NullOr(Schema.Number),
  normalizedRecords: Schema.NullOr(Schema.Number),
  failedRecords: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
}) {}

export class SyncRunResponse extends Schema.Class<SyncRunResponse>("SyncRunResponse")({
  runId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "partially_failed"]),
  requestedSourceCount: Schema.Number,
  queuedSourceCount: Schema.Number,
  runningSourceCount: Schema.Number,
  completedSourceCount: Schema.Number,
  failedSourceCount: Schema.Number,
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
