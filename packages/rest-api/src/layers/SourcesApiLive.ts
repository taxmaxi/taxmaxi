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

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Headers, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SourceId } from "@my/core/source"
import * as Effect from "effect/Effect"
import * as Config from "effect/Config"
import * as Schema from "effect/Schema"
import {
  SourceRepository as SyncEngineSourceRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import {
  BillingRepository,
  PrincipalClaimRepository,
  SourceRepository as PersistenceSourceRepository,
  SourceReportRepository,
  TaxCalculationService,
} from "@my/persistence/services"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { OptionalCurrentUser } from "../definitions/AuthMiddleware.ts"
import {
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationResponse,
  SourceBadRequestError,
  SourceCreditRequiredError,
  SourceNotFoundError,
  SourceListResponse,
  SourceCreateResponse,
  SourceCreateClaimMetadata,
  SourceNameResolutionError,
  SourceNameResolveResponse,
  SourcePaymentRequiredError,
  SourceAssetPnlResponse,
  SourceAssetPnlRow,
  SourceDisposalExplanationResponse,
  SourceDisposalMatchedLot,
  SourceFifoLotDisposalSummary,
  SourceFifoLotsResponse,
  SourceFifoLotRow,
  SourceOverviewResponse,
  SourceReportReviewIssue,
  SourceReportReviewSummary,
  SourceReportSyncStatus,
  SourceReportTotals,
  SourceReportAsset,
  SourceTransactionMovement,
  SourceTransactionRow,
  SourceTaxEventRow,
  SourceReportPageInfo,
  SourceTaxCalculationPendingError,
  SourceTaxEventsResponse,
  SourceTransactionsResponse,
} from "../definitions/SourcesApi.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { Layer, Option } from "effect"
import type { ReportReviewReasonCode } from "@my/core/report"
import { SourceCreationService } from "../services/SourceCreationService.ts"
import { AnonSessionService } from "../services/AnonSessionService.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"
import {
  assertHasSyncCredits,
  NoUsableCreditsError,
  SYNC_CREDIT_REQUIRED_MESSAGE,
} from "../helpers/SyncCreditAdmission.ts"
import { WalletNameResolutionService } from "../services/WalletNameResolutionService.ts"
import { SourceCreationServiceLive } from "./SourceCreationServiceLive.ts"
import { WalletNameResolutionServiceLive } from "./WalletNameResolutionServiceLive.ts"
import { ANON_SESSION_COOKIE_MAX_AGE, ANON_SESSION_COOKIE_NAME } from "./AnonApiLive.ts"

const toBadRequestError = (message: string) => new SourceBadRequestError({ message })
const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })
const toCreditRequiredError = (error: NoUsableCreditsError) =>
  new SourceCreditRequiredError({
    message: SYNC_CREDIT_REQUIRED_MESSAGE,
    reasonCode: error.reasonCode,
    availableCredits: error.availableCredits,
  })
const sourceNotFoundMessage = "No source found. Connect a source first."
const defaultReportPageLimit = 50
const cookieOptionsForEnv = (environment: string) => ({
  httpOnly: true,
  secure: environment === "production",
  sameSite: "lax" as const,
  path: "/",
})

export const SourcesApiLive = HttpApiBuilder.group(TaxMaxiApi, "sources", (handlers) =>
  Effect.gen(function* () {
    const taxCalculationService = yield* TaxCalculationService
    const sourceSyncService = yield* SourceSyncService
    const sourceRepository = yield* PersistenceSourceRepository
    const sourceReportRepository = yield* SourceReportRepository
    const syncEngineSourceRepository = yield* SyncEngineSourceRepository
    const billingRepository = yield* BillingRepository
    const principalClaimRepository = yield* PrincipalClaimRepository
    const optionalCurrentUser = yield* OptionalCurrentUser
    const sourceCreationService = yield* SourceCreationService
    const anonSessionService = yield* AnonSessionService
    const principalResolutionService = yield* PrincipalResolutionService
    const walletNameResolutionService = yield* WalletNameResolutionService
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const anonSessionCookieOptions = cookieOptionsForEnv(environment)

    const resolveOptionalAnonPayerSession = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = request.cookies[ANON_SESSION_COOKIE_NAME]
      if (token === undefined || token.trim() === "") {
        return Option.none<{
          readonly payerChainType: "evm" | "solana" | "bitcoin"
          readonly payerWalletAddress: string
        }>()
      }

      return yield* anonSessionService.verifySessionToken(token).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none()))
      )
    })

    const resolveCurrentUserPrincipal = Effect.gen(function* () {
      const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
        Effect.mapError((error) => toInternalServerError(error.message))
      )
      return principal
    })

    // Shared by start and replay: resolve the caller and refuse billable sync
    // work when a registered user has no usable credits.
    const resolvePrincipalWithSyncCredits = ({ sourceId }: { readonly sourceId: string }) =>
      Effect.gen(function* () {
        const { currentUser, principal } =
          yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError((error) => toInternalServerError(error.message))
          )

        yield* assertHasSyncCredits({
          billingRepository,
          principalClaimRepository,
          userId: currentUser.userId,
          sourceId,
        }).pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "NoUsableCreditsError":
                return toCreditRequiredError(error)
              default:
                return toInternalServerError("Failed to check sync credit balance.")
            }
          })
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

    const reportScope = ({
      principalId,
      sourceId,
    }: {
      readonly principalId: string
      readonly sourceId: string
    }) =>
      Schema.decodeUnknownEffect(SourceId)(sourceId).pipe(
        Effect.map((decodedSourceId) => ({ principalId, sourceId: decodedSourceId })),
        Effect.mapError(() => toBadRequestError("Invalid source identifier."))
      )

    const reportPageParams = ({
      cursor,
      limit,
    }: {
      readonly cursor?: string | undefined
      readonly limit?: number | undefined
    }) => ({
      cursor: cursor ?? null,
      limit: limit ?? defaultReportPageLimit,
    })

    const mapReportError =
      (message: string) => (error: { readonly _tag: string; readonly message: string }) => {
        switch (error._tag) {
          case "SourceReportSourceNotFoundError":
            return new SourceNotFoundError({ message: sourceNotFoundMessage })
          case "SourceReportInvalidCursorError":
            return toBadRequestError(error.message)
          default:
            return toInternalServerError(message)
        }
      }

    const reportAsset = (asset: {
      readonly assetId: string
      readonly symbol: string
      readonly name: string
    }) => SourceReportAsset.make(asset)

    const reportReviewSummary = (review: {
      readonly status: "ok" | "needs_review"
      readonly needsReviewCount: number
      readonly blockingIssueCount: number
      readonly issues: ReadonlyArray<{
        readonly code: ReportReviewReasonCode
        readonly count: number
        readonly blocking: boolean
        readonly summary: string
      }>
    }) =>
      SourceReportReviewSummary.make({
        ...review,
        issues: review.issues.map((issue) => SourceReportReviewIssue.make(issue)),
      })

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
          const anonPayerSession = yield* resolveOptionalAnonPayerSession
          const paymentSignatureHeader = Headers.get(request.headers, "payment-signature")
          const xPaymentHeader = Headers.get(request.headers, "x-payment")
          const paymentHeader = Option.isSome(paymentSignatureHeader)
            ? paymentSignatureHeader
            : xPaymentHeader
          const creationResult = yield* sourceCreationService
            .createSource({
              currentUser,
              anonPayerSession,
              paymentHeader,
              payload,
            })
            .pipe(Effect.result)

          if (creationResult._tag === "Failure") {
            switch (creationResult.failure._tag) {
              case "SourceCreationBadRequestError":
                return yield* toBadRequestError(creationResult.failure.message)
              case "SourceCreationNameResolutionError":
                return yield* new SourceNameResolutionError({
                  code: creationResult.failure.code,
                  name: creationResult.failure.name,
                  namespace: creationResult.failure.namespace,
                  message: creationResult.failure.message,
                })
              case "SourceCreationInternalError":
                return yield* toInternalServerError(creationResult.failure.message)
              case "SourceCreationCreditRequiredError":
                return yield* new SourceCreditRequiredError({
                  message: creationResult.failure.message,
                  reasonCode: creationResult.failure.reasonCode,
                  availableCredits: creationResult.failure.availableCredits,
                })
              case "SourceCreationPaymentRequiredError": {
                const error = new SourcePaymentRequiredError({
                  message: creationResult.failure.message,
                  paymentRequired: creationResult.failure.paymentRequired,
                })
                const headers =
                  creationResult.failure.paymentRequiredHeader === undefined
                    ? {}
                    : { "PAYMENT-REQUIRED": creationResult.failure.paymentRequiredHeader }
                return yield* HttpServerResponse.json(error, { status: 402, headers }).pipe(
                  Effect.orDie
                )
              }
            }
          }

          const result = creationResult.success

          if (result.anonPayerSession !== null) {
            const anonSessionToken = yield* anonSessionService
              .createSessionToken(result.anonPayerSession)
              .pipe(Effect.mapError(() => toInternalServerError("Failed to create anon session.")))

            yield* HttpEffect.appendPreResponseHandler((_req, response) =>
              Effect.orDie(
                HttpServerResponse.setCookie(response, ANON_SESSION_COOKIE_NAME, anonSessionToken, {
                  ...anonSessionCookieOptions,
                  maxAge: ANON_SESSION_COOKIE_MAX_AGE,
                })
              )
            )
          }

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

          const response = SourceCreateResponse.make({
            source: result.source,
            created: result.created,
            syncJob,
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
      .handle("startSourceSyncJob", ({ params: path }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipalWithSyncCredits({ sourceId: path.sourceId })

          const startParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          }

          const started = yield* startSync(startParams)

          return SourceSyncStartResponse.make(started)
        })
      )
      .handle("replaySourceSyncJob", ({ params: path }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipalWithSyncCredits({ sourceId: path.sourceId })

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
      .handle("getSourceSyncJobStatus", ({ params: path }) =>
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
      .handle("calculateTaxForSource", ({ params: path, payload }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const sourceId = yield* Schema.decodeUnknownEffect(SourceId)(path.sourceId).pipe(
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
            return yield* new SourceNotFoundError({
              message: sourceNotFoundMessage,
            })
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
                  case "TaxCalculationPendingObservationsError":
                    return new SourceTaxCalculationPendingError({
                      message: `Tax calculation for this source is pending: ${error.pendingObservationCount} provider asset observation(s) await resolution.`,
                      blockingObservations: error.blockingObservations.map((observation) => ({
                        provider: observation.provider,
                        currencyCode: observation.currencyCode,
                      })),
                    })
                  case "TaxCalculationPendingRecomputationError":
                    return new SourceTaxCalculationPendingError({
                      message: error.message,
                      blockingObservations: [],
                    })
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
      .handle("getSourceOverview", ({ params: path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const overview = yield* sourceReportRepository
            .getOverview(scope)
            .pipe(Effect.mapError(mapReportError("Failed to load source overview.")))

          return SourceOverviewResponse.make({
            source: overview.source,
            latestSync: SourceReportSyncStatus.make(overview.latestSync),
            totals: SourceReportTotals.make(overview.totals),
            review: reportReviewSummary(overview.review),
          })
        })
      )
      .handle("listSourceAssetPnl", ({ params: path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const assets = yield* sourceReportRepository
            .listAssetPnl(scope)
            .pipe(Effect.mapError(mapReportError("Failed to load source asset P&L.")))

          return SourceAssetPnlResponse.make({
            assets: assets.map((row) =>
              SourceAssetPnlRow.make({
                ...row,
                asset: reportAsset(row.asset),
                review: reportReviewSummary(row.review),
              })
            ),
          })
        })
      )
      .handle("listSourceTransactions", ({ params: path, query: urlParams }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const page = yield* sourceReportRepository
            .listTransactions({ ...scope, ...reportPageParams(urlParams) })
            .pipe(Effect.mapError(mapReportError("Failed to load source transactions.")))

          return SourceTransactionsResponse.make({
            transactions: page.items.map((row) =>
              SourceTransactionRow.make({
                ...row,
                movements: row.movements.map((movement) =>
                  SourceTransactionMovement.make({
                    ...movement,
                    asset: reportAsset(movement.asset),
                  })
                ),
              })
            ),
            page: SourceReportPageInfo.make({
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
          })
        })
      )
      .handle("listSourceTaxEvents", ({ params: path, query: urlParams }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const page = yield* sourceReportRepository
            .listTaxEvents({ ...scope, ...reportPageParams(urlParams) })
            .pipe(Effect.mapError(mapReportError("Failed to load source tax events.")))

          return SourceTaxEventsResponse.make({
            taxEvents: page.items.map((row) =>
              SourceTaxEventRow.make({
                ...row,
                asset: reportAsset(row.asset),
              })
            ),
            page: SourceReportPageInfo.make({
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
          })
        })
      )
      .handle("listSourceFifoLots", ({ params: path, query: urlParams }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const page = yield* sourceReportRepository
            .listFifoLots({ ...scope, ...reportPageParams(urlParams) })
            .pipe(Effect.mapError(mapReportError("Failed to load source FIFO lots.")))

          return SourceFifoLotsResponse.make({
            fifoLots: page.items.map((row) =>
              SourceFifoLotRow.make({
                ...row,
                asset: reportAsset(row.asset),
                disposalMatches: row.disposalMatches.map((match) =>
                  SourceFifoLotDisposalSummary.make(match)
                ),
              })
            ),
            page: SourceReportPageInfo.make({
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
          })
        })
      )
      .handle("explainSourceDisposal", ({ params: path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal
          const scope = yield* reportScope({ principalId: principal.id, sourceId: path.sourceId })
          const explanation = yield* sourceReportRepository
            .explainDisposal({ ...scope, legId: path.legId })
            .pipe(Effect.mapError(mapReportError("Failed to explain source disposal.")))

          return SourceDisposalExplanationResponse.make({
            ...explanation,
            asset: reportAsset(explanation.asset),
            matchedLots: explanation.matchedLots.map((lot) =>
              SourceDisposalMatchedLot.make({
                ...lot,
                asset: reportAsset(lot.asset),
              })
            ),
          })
        })
      )
      .handle("resolveSourceName", ({ payload }) =>
        Effect.gen(function* () {
          const resolution = yield* walletNameResolutionService.resolve(payload.name).pipe(
            Effect.mapError((error) =>
              error._tag === "WalletNameResolutionError"
                ? new SourceNameResolutionError({
                    code: error.code,
                    name: error.name,
                    namespace: error.namespace,
                    message: error.message,
                  })
                : toInternalServerError("Failed to resolve wallet name.")
            )
          )

          return SourceNameResolveResponse.make({
            name: resolution.name,
            namespace: resolution.namespace,
            resolvedAddress: resolution.resolvedAddress,
            chainType: resolution.chainType,
          })
        })
      )
  })
).pipe(Layer.provide(SourceCreationServiceLive), Layer.provide(WalletNameResolutionServiceLive))
