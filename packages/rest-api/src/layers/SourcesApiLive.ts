/**
 * SourcesApiLive - Live implementation of sources API handlers
 *
 * Implements the SourcesApi endpoints
 * by delegating sync orchestration to sync-engine and tax/source reads to persistence.
 *
 * Features:
 * - Starting a sync job for a source
 * - Getting the status of a sync job
 * - Calculating tax for a source
 *
 * @module SourceApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { parseCryptoAddress, SourceId } from "@my/core/source"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  SourceRepository as SyncEngineSourceRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import {
  PrincipalRepository,
  SourceRepository as PersistenceSourceRepository,
  TaxCalculationService,
} from "@my/persistence/services"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import {
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationResponse,
  SourceBadRequestError,
  SourceNotFoundError,
  SourceListResponse,
  SourceCreateResponse,
} from "../definitions/SourcesApi.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { Option } from "effect"

const toBadRequestError = (message: string) => new SourceBadRequestError({ message })
const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })
const sourceNotFoundMessage = "No source found. Connect a source first."

export const SourcesApiLive = HttpApiBuilder.group(TaxMaxiApi, "sources", (handlers) =>
  Effect.gen(function* () {
    const taxCalculationService = yield* TaxCalculationService
    const sourceSyncService = yield* SourceSyncService
    const principalRepository = yield* PrincipalRepository
    const sourceRepository = yield* PersistenceSourceRepository
    const syncEngineSourceRepository = yield* SyncEngineSourceRepository

    const resolvePrincipal = Effect.gen(function* () {
      const currentUser = yield* CurrentUser
      const maybePrincipal = yield* principalRepository.findUserPrincipal(currentUser.userId).pipe(
        Effect.mapError(() => toInternalServerError("Failed to resolve principal."))
      )

      if (Option.isNone(maybePrincipal)) {
        return yield* Effect.fail(toInternalServerError("Missing user principal."))
      }

      return maybePrincipal.value
    })

    return handlers
      .handle("listSources", () =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const sources = yield* sourceRepository.findByPrincipalId(principal.id).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                default:
                  return toInternalServerError("Failed to list sources.")
              }
            })
          )
          return SourceListResponse.make({ sources })
        })
      )
      .handle("createSource", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const parsedAddress = parseCryptoAddress(payload.walletAddress)
          if (parsedAddress === null) {
            return yield* Effect.fail(toBadRequestError("Invalid crypto address."))
          }

          const sourceName =
            payload.name ?? `${parsedAddress.address.slice(0, 5)}...${parsedAddress.address.slice(-5)}`
          const created = yield* sourceRepository
            .createOrReuseOnchainSource({
              principalId: principal.id,
              chainType: parsedAddress.chainType,
              walletAddress: parsedAddress.address,
              name: sourceName,
            })
            .pipe(
              Effect.mapError(() => toInternalServerError("Failed to create or reuse source."))
            )

          if (payload.sync !== true) {
            return SourceCreateResponse.make({
              source: created.source,
              created: created.created,
              syncJob: null,
            })
          }

          const syncJob = yield* sourceSyncService
            .startSourceSyncJob({
              principalId: principal.id,
              sourceId: created.source.id,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "UnsupportedProviderError":
                    return toBadRequestError(`Unsupported provider: ${error.provider}`)
                  case "SourceNotFoundError":
                    return toBadRequestError(sourceNotFoundMessage)
                  case "SourceSyncQueueError":
                    return toInternalServerError("Failed to enqueue source sync job.")
                  default:
                    return toInternalServerError("Failed to start source sync.")
                }
              })
            )

          return SourceCreateResponse.make({
            source: created.source,
            created: created.created,
            syncJob: SourceSyncStartResponse.make(syncJob),
          })
        })
      )
      .handle("startSourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const startParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          }

          const started = yield* sourceSyncService.startSourceSyncJob(startParams).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "UnsupportedProviderError":
                  return toBadRequestError(`Unsupported provider: ${error.provider}`)
                case "SourceNotFoundError":
                  return toBadRequestError(sourceNotFoundMessage)
                case "SourceSyncQueueError":
                  return toInternalServerError("Failed to enqueue source sync job.")
                default:
                  return toInternalServerError("Failed to start source sync.")
              }
            })
          )

          return SourceSyncStartResponse.make(started)
        })
      )
      .handle("replaySourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const replayParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          }

          const replayed = yield* sourceSyncService.replaySourceSyncJob(replayParams).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "UnsupportedProviderError":
                  return toBadRequestError(`Unsupported provider: ${error.provider}`)
                case "SourceNotFoundError":
                  return toBadRequestError(sourceNotFoundMessage)
                case "SourceSyncQueueError":
                  return toInternalServerError("Failed to enqueue source replay job.")
                default:
                  return toInternalServerError("Failed to replay source sync.")
              }
            })
          )

          return SourceSyncStartResponse.make(replayed)
        })
      )
      .handle("getSourceSyncJobStatus", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const job = yield* sourceSyncService
            .getSourceSyncJob({
              principalId: principal.id,
              sourceId: path.sourceId,
              jobId: path.jobId,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "SourceSyncJobNotFoundError":
                    return new SourceNotFoundError({ message: "Sync job not found." })
                  default:
                    return toInternalServerError("Failed to load source sync job.")
                }
              })
            )

          return SourceSyncJobResponse.make(job)
        })
      )
      .handle("calculateTaxForSource", ({ path, payload }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal
          const sourceId = yield* Schema.decodeUnknown(SourceId)(path.sourceId).pipe(
            Effect.mapError(() => toBadRequestError("Invalid source identifier."))
          )
          const maybeSource = yield* syncEngineSourceRepository
            .findOwnedSourceSyncContext({
              principalId: principal.id,
              sourceId,
            })
            .pipe(
              Effect.mapError(() =>
                toInternalServerError("Failed to load source for tax calculation.")
              )
            )

          if (Option.isNone(maybeSource)) {
            return yield* Effect.fail(
              new SourceNotFoundError({
                message: sourceNotFoundMessage,
              })
            )
          }

          const taxes = yield* taxCalculationService
            .calculateTax({
              sourceId,
              jurisdiction: payload.jurisdiction,
              year: payload.year,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "UnsupportedJurisdictionError":
                    return toBadRequestError(`Unsupported jurisdiction: ${error.jurisdiction}`)
                  case "TaxCalculationIncompleteDataError":
                    return toBadRequestError(
                      `Tax summary is not ready yet: ${error.reason}. Re-run sync and try again.`
                    )
                  case "TaxCalculationUnsupportedCurrencyError":
                    return toBadRequestError(
                      `Tax summary currently supports ${error.expectedCurrency} only; found ${error.actualCurrency} in ${error.field}.`
                    )
                  case "SourceNotFoundError":
                    return new SourceNotFoundError({
                      message: sourceNotFoundMessage,
                    })
                  default:
                    return toInternalServerError("Failed to compute tax summary.")
                }
              })
            )

          return TaxCalculationResponse.make(taxes)
        })
      )
  })
)
