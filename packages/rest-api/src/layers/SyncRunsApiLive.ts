/**
 * SyncRunsApiLive - Live implementation of user-wide sync run API handlers.
 *
 * @module SyncRunsApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import {
  CalculationRunRepository,
  type CalculationRunStatusSummary,
} from "@my/persistence/services"
import { SourceSyncRunService, type SourceSyncRunDetails } from "@my/sync-engine/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  CalculationRunStatusUnavailableError,
  CalculationRunSummaryResponse,
  SyncRunItemResponse,
  SyncRunNotFoundError,
  SyncRunResponse,
} from "../definitions/SyncRunsApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const toDateTimeUtcOrNull = (date: Date | null): DateTime.Utc | null =>
  date === null ? null : DateTime.makeUnsafe(date)

const GERMAN_TIME_ZONE = "Europe/Berlin"
const GERMAN_JURISDICTION = JurisdictionCode.make("DE")

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map(DateTime.setZoneNamedUnsafe(GERMAN_TIME_ZONE)),
  Effect.map(DateTime.toParts),
  Effect.map(({ year }) => TaxYear.make(year))
)

const toSyncRunResponse = ({
  run,
  calculationRun,
}: {
  readonly run: SourceSyncRunDetails
  readonly calculationRun: CalculationRunStatusSummary | null
}): SyncRunResponse =>
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
    calculationRun:
      calculationRun === null
        ? null
        : CalculationRunSummaryResponse.make({
            runId: calculationRun.runId,
            status: calculationRun.status,
            failureCode: calculationRun.failureCode,
          }),
    items: run.items.map((item) =>
      SyncRunItemResponse.make({
        sourceId: item.sourceId,
        jobId: item.processingJobId,
        provider: item.provider,
        status: item.status,
        phase: item.phase,
        processedRecords: item.processedRecords,
        totalRecords: item.totalRecords,
        progressPercent: item.progressPercent,
        fetchedRecords: item.fetchedRecords,
        normalizedRecords: item.normalizedRecords,
        failedRecords: item.failedRecords,
        message: item.message,
      })
    ),
  })

export const SyncRunsApiLive = HttpApiBuilder.group(TaxMaxiApi, "syncRuns", (handlers) =>
  Effect.gen(function* () {
    const calculationRunRepository = yield* CalculationRunRepository
    const sourceSyncRunService = yield* SourceSyncRunService
    const principalResolutionService = yield* PrincipalResolutionService

    const resolvePrincipal = principalResolutionService.resolveCurrentUserPrincipal.pipe(
      Effect.mapError((error) => toInternalServerError(error.message))
    )

    const loadCalculationRun = ({
      userId,
      principalId,
    }: {
      readonly userId: string
      readonly principalId: PrincipalId
    }) =>
      Effect.gen(function* () {
        const taxYear = yield* currentGermanTaxYear
        return yield* calculationRunRepository.getLatestStatus({
          principalId,
          jurisdiction: GERMAN_JURISDICTION,
          taxYear,
          reportingCurrency: EUR,
        })
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            { userId, principalId, errorTag: error._tag },
            "sync-runs-api:calculation-run-load-failed"
          )
        )
      )

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

          const calculationRun = yield* loadCalculationRun({
            userId: currentUser.userId,
            principalId: principal.id,
          }).pipe(Effect.orElseSucceed(() => null))

          return toSyncRunResponse({ run, calculationRun })
        })
      )
      .handle("getSyncRun", ({ params: path }) =>
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

          const calculationRun = yield* loadCalculationRun({
            userId: currentUser.userId,
            principalId: principal.id,
          }).pipe(
            Effect.mapError(
              () =>
                new CalculationRunStatusUnavailableError({
                  code: "calculation_run_status_unavailable",
                })
            )
          )

          return toSyncRunResponse({ run, calculationRun })
        })
      )
  })
)
