/**
 * SyncRunsApiLive - Live implementation of user-wide sync run API handlers.
 *
 * @module SyncRunsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { PrincipalRepository } from "@my/persistence/services"
import { SourceSyncRunService, type SourceSyncRunDetails } from "@my/sync-engine/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import {
  SyncRunItemResponse,
  SyncRunNotFoundError,
  SyncRunResponse,
} from "../definitions/SyncRunsApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const toDateTimeUtcOrNull = (date: Date | null): DateTime.Utc | null =>
  date === null ? null : DateTime.unsafeMake(date)

const toSyncRunResponse = (run: SourceSyncRunDetails): SyncRunResponse =>
  SyncRunResponse.make({
    runId: run.id,
    status: run.status,
    requestedSourceCount: run.requestedSourceCount,
    queuedSourceCount: run.queuedSourceCount,
    runningSourceCount: run.runningSourceCount,
    completedSourceCount: run.completedSourceCount,
    failedSourceCount: run.failedSourceCount,
    startedAt: toDateTimeUtcOrNull(run.startedAt),
    completedAt: toDateTimeUtcOrNull(run.completedAt),
    message: run.message,
    items: run.items.map((item) =>
      SyncRunItemResponse.make({
        sourceId: item.sourceId,
        jobId: item.processingJobId,
        provider: item.provider,
        status: item.status,
        importedRecords: item.importedRecords,
        normalizedRecords: item.normalizedRecords,
        failedRecords: item.failedRecords,
        message: item.message,
      })
    ),
  })

export const SyncRunsApiLive = HttpApiBuilder.group(TaxMaxiApi, "syncRuns", (handlers) =>
  Effect.gen(function* () {
    const sourceSyncRunService = yield* SourceSyncRunService
    const principalRepository = yield* PrincipalRepository

    const resolvePrincipal = Effect.gen(function* () {
      const currentUser = yield* CurrentUser
      const maybePrincipal = yield* principalRepository
        .findUserPrincipal(currentUser.userId)
        .pipe(Effect.mapError(() => toInternalServerError("Failed to resolve principal.")))

      if (Option.isNone(maybePrincipal)) {
        return yield* Effect.fail(toInternalServerError("Missing user principal."))
      }

      return { currentUser, principal: maybePrincipal.value }
    })

    return handlers
      .handle("startSyncRun", () =>
        Effect.gen(function* () {
          const { currentUser, principal } = yield* resolvePrincipal
          const run = yield* sourceSyncRunService.startSyncRun({ principalId: principal.id }).pipe(
            Effect.tapError((error) =>
              Effect.logError(
                {
                  userId: currentUser.userId,
                  principalId: principal.id,
                  errorTag: error._tag,
                },
                "sync-runs-api:start-failed"
              )
            ),
            Effect.mapError((error) => {
              switch (error._tag) {
                case "SourceSyncRunNotFoundError":
                case "SyncEngineStorageError":
                  return toInternalServerError("Failed to start sync run.")
              }
            })
          )

          return toSyncRunResponse(run)
        })
      )
      .handle("getSyncRun", ({ path }) =>
        Effect.gen(function* () {
          const { currentUser, principal } = yield* resolvePrincipal
          const run = yield* sourceSyncRunService
            .getSyncRun({
              principalId: principal.id,
              runId: path.runId,
            })
            .pipe(
              Effect.tapError((error) =>
                error._tag === "SourceSyncRunNotFoundError"
                  ? Effect.void
                  : Effect.logError(
                      {
                        userId: currentUser.userId,
                        principalId: principal.id,
                        runId: path.runId,
                        errorTag: error._tag,
                      },
                      "sync-runs-api:get-failed"
                    )
              ),
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "SourceSyncRunNotFoundError":
                    return new SyncRunNotFoundError({ message: "Sync run not found." })
                  default:
                    return toInternalServerError("Failed to load sync run.")
                }
              })
            )

          return toSyncRunResponse(run)
        })
      )
  })
)
