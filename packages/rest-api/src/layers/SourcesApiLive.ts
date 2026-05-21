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

import { Headers, HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SourceId } from "@my/core/source"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  SourceRepository as SyncEngineSourceRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import {
  SourceRepository as PersistenceSourceRepository,
  TaxCalculationService,
} from "@my/persistence/services"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { OptionalCurrentUser } from "../definitions/AuthMiddleware.ts"
import {
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationResponse,
  SourceBadRequestError,
  SourceNotFoundError,
  SourceListResponse,
  SourceCreateResponse,
  SourceCreateClaimMetadata,
  SourceSyncUnavailableResponse,
  SourcePaymentRequiredError,
} from "../definitions/SourcesApi.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { Layer, Option } from "effect"
import { SourceCreationService } from "../services/SourceCreationService.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"
import { SourceCreationServiceLive } from "./SourceCreationServiceLive.ts"

const toBadRequestError = (message: string, code?: string | undefined) =>
  new SourceBadRequestError({ code, message })
const toInternalServerError = (message: string, code?: string | undefined) =>
  new InternalServerError({ code, requestId: Option.none(), message })
const sourceNotFoundMessage = "No source found. Connect a source first."

export const SourcesApiLive = HttpApiBuilder.group(TaxMaxiApi, "sources", (handlers) =>
  Effect.gen(function* () {
    const taxCalculationService = yield* TaxCalculationService
    const sourceSyncService = yield* SourceSyncService
    const sourceRepository = yield* PersistenceSourceRepository
    const syncEngineSourceRepository = yield* SyncEngineSourceRepository
    const optionalCurrentUser = yield* OptionalCurrentUser
    const sourceCreationService = yield* SourceCreationService
    const principalResolutionService = yield* PrincipalResolutionService

    const resolveCurrentUserPrincipal = Effect.gen(function* () {
      const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
        Effect.mapError((error) => toInternalServerError(error.message))
      )
      return principal
    })

    const startSync = ({
      principalId,
      sourceId,
    }: {
      readonly principalId: string
      readonly sourceId: string
    }) =>
      sourceSyncService
        .startSourceSyncJob({
          principalId,
          sourceId,
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

    return handlers
      .handle("listSources", () =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
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
          const request = yield* HttpServerRequest.HttpServerRequest
          const currentUser = yield* optionalCurrentUser.resolve()
          const paymentSignatureHeader = Headers.get(request.headers, "payment-signature")
          const xPaymentHeader = Headers.get(request.headers, "x-payment")
          const paymentHeader = Option.isSome(paymentSignatureHeader)
            ? paymentSignatureHeader
            : xPaymentHeader
          const creationResult = yield* sourceCreationService
            .createSource({
              currentUser,
              paymentHeader,
              payload,
            })
            .pipe(Effect.either)

          if (creationResult._tag === "Left") {
            switch (creationResult.left._tag) {
              case "SourceCreationBadRequestError":
                return yield* Effect.fail(
                  toBadRequestError(creationResult.left.message, creationResult.left.code)
                )
              case "SourceCreationInternalError":
                return yield* Effect.fail(
                  toInternalServerError(creationResult.left.message, creationResult.left.code)
                )
              case "SourceCreationPaymentRequiredError": {
                const error = new SourcePaymentRequiredError({
                  code: creationResult.left.code,
                  message: creationResult.left.message,
                  paymentRequired: creationResult.left.paymentRequired,
                })
                const headers =
                  creationResult.left.paymentRequiredHeader === undefined
                    ? {}
                    : { "PAYMENT-REQUIRED": creationResult.left.paymentRequiredHeader }
                return yield* HttpServerResponse.json(error, { status: 402, headers }).pipe(
                  Effect.orDie
                )
              }
            }
          }

          const result = creationResult.right

          const claim =
            result.claim === null
              ? null
              : SourceCreateClaimMetadata.make({
                  requestId: result.claim.requestId,
                  claimToken: result.claim.claimToken,
                  expiresAt: result.claim.expiresAt,
                })

          const syncJob =
            result.syncJob === null ? null : SourceSyncStartResponse.make(result.syncJob)
          const syncUnavailable =
            result.syncUnavailable === null
              ? null
              : SourceSyncUnavailableResponse.make(result.syncUnavailable)

          const response = SourceCreateResponse.make({
            source: result.source,
            created: result.created,
            syncJob,
            syncUnavailable,
            claim,
          })

          if (result.paymentResponseHeader !== null) {
            return yield* HttpServerResponse.json(response, {
              status: 200,
              headers: { "PAYMENT-RESPONSE": result.paymentResponseHeader },
            }).pipe(Effect.orDie)
          }

          return response
        })
      )
      .handle("startSourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const startParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          }

          const started = yield* startSync(startParams)

          return SourceSyncStartResponse.make(started)
        })
      )
      .handle("replaySourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
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
          const principal = yield* resolveCurrentUserPrincipal
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
          const principal = yield* resolveCurrentUserPrincipal
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
).pipe(Layer.provide(SourceCreationServiceLive))
