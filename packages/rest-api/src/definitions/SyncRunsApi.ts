/**
 * SyncRunsApi - HTTP API group for user-wide source sync runs.
 *
 * @module SyncRunsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class SyncRunNotFoundError extends Schema.TaggedError<SyncRunNotFoundError>()(
  "SyncRunNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class SyncRunItemResponse extends Schema.Class<SyncRunItemResponse>("SyncRunItemResponse")({
  sourceId: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  status: Schema.Literal("queued", "running", "completed", "failed"),
  importedRecords: Schema.NullOr(Schema.Number),
  normalizedRecords: Schema.NullOr(Schema.Number),
  failedRecords: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
}) {}

export class SyncRunResponse extends Schema.Class<SyncRunResponse>("SyncRunResponse")({
  runId: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed", "partially_failed"),
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

const startSyncRun = HttpApiEndpoint.post("startSyncRun", "/sync-runs")
  .addSuccess(SyncRunResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Start user-wide sync run",
      description: "Starts source sync jobs for every configured source owned by the user.",
    })
  )

const getSyncRun = HttpApiEndpoint.get("getSyncRun", "/sync-runs/:runId")
  .setPath(
    Schema.Struct({
      runId: Schema.String,
    })
  )
  .addSuccess(SyncRunResponse)
  .addError(SyncRunNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
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
  .annotateContext(
    OpenApi.annotations({
      title: "Sync runs",
      description: "Endpoints for user-wide source sync orchestration",
    })
  ) {}
