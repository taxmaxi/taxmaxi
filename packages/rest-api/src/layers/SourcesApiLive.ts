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

import { Headers, HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { SourceId } from "@my/core/source";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SourceRepository as SyncEngineSourceRepository,
  SourceSyncService,
} from "@my/sync-engine/services";
import {
  PrincipalRepository,
  SourceRepository as PersistenceSourceRepository,
  TaxCalculationService,
} from "@my/persistence/services";
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts";
import { CurrentUser, OptionalCurrentUser, type User } from "../definitions/AuthMiddleware.ts";
import {
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationResponse,
  SourceBadRequestError,
  SourceNotFoundError,
  SourceListResponse,
  SourceCreateResponse,
  SourceCreateClaimMetadata,
  SourcePaymentRequiredError,
} from "../definitions/SourcesApi.ts";
import { InternalServerError } from "../definitions/ApiErrors.ts";
import { Layer, Option } from "effect";
import { SourceCreationService } from "../services/SourceCreationService.ts";
import { SourceCreationServiceLive } from "./SourceCreationServiceLive.ts";

const toBadRequestError = (message: string) => new SourceBadRequestError({ message });
const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message });
const sourceNotFoundMessage = "No source found. Connect a source first.";

export const SourcesApiLive = HttpApiBuilder.group(TaxMaxiApi, "sources", (handlers) =>
  Effect.gen(function* () {
    const taxCalculationService = yield* TaxCalculationService;
    const sourceSyncService = yield* SourceSyncService;
    const principalRepository = yield* PrincipalRepository;
    const sourceRepository = yield* PersistenceSourceRepository;
    const syncEngineSourceRepository = yield* SyncEngineSourceRepository;
    const optionalCurrentUser = yield* OptionalCurrentUser;
    const sourceCreationService = yield* SourceCreationService;

    const resolveUserPrincipal = (currentUser: User) =>
      Effect.gen(function* () {
        const maybePrincipal = yield* principalRepository
          .findUserPrincipal(currentUser.userId)
          .pipe(Effect.mapError(() => toInternalServerError("Failed to resolve principal.")));

        if (Option.isNone(maybePrincipal)) {
          return yield* Effect.fail(toInternalServerError("Missing user principal."));
        }

        return maybePrincipal.value;
      });

    const resolveCurrentUserPrincipal = Effect.gen(function* () {
      const currentUser = yield* CurrentUser;
      return yield* resolveUserPrincipal(currentUser);
    });

    const startSync = ({
      principalId,
      sourceId,
    }: {
      readonly principalId: string;
      readonly sourceId: string;
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
                return toBadRequestError(`Unsupported provider: ${error.provider}`);
              case "SourceNotFoundError":
                return toBadRequestError(sourceNotFoundMessage);
              case "SourceSyncQueueError":
                return toInternalServerError("Failed to enqueue source sync job.");
              default:
                return toInternalServerError("Failed to start source sync.");
            }
          }),
        );

    return handlers
      .handle("listSources", () =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal;
          const sources = yield* sourceRepository.findByPrincipalId(principal.id).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                default:
                  return toInternalServerError("Failed to list sources.");
              }
            }),
          );
          return SourceListResponse.make({ sources });
        }),
      )
      .handle("createSource", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const currentUser = yield* optionalCurrentUser.resolve();
          const result = yield* sourceCreationService
            .createSource({
              currentUser,
              paymentHeader: Headers.get(request.headers, "x-payment"),
              payload,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "SourceCreationBadRequestError":
                    return toBadRequestError(error.message);
                  case "SourceCreationPaymentRequiredError":
                    return new SourcePaymentRequiredError({ message: error.message });
                  case "SourceCreationInternalError":
                    return toInternalServerError(error.message);
                }
              }),
            );

          const claim =
            result.claim === null
              ? null
              : SourceCreateClaimMetadata.make({
                  requestId: result.claim.requestId,
                  claimToken: result.claim.claimToken,
                  expiresAt: result.claim.expiresAt,
                });

          const syncJob =
            result.syncJob === null ? null : SourceSyncStartResponse.make(result.syncJob);

          return SourceCreateResponse.make({
            source: result.source,
            created: result.created,
            syncJob,
            claim,
          });
        }),
      )
      .handle("startSourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal;
          const startParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          };

          const started = yield* startSync(startParams);

          return SourceSyncStartResponse.make(started);
        }),
      )
      .handle("replaySourceSyncJob", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal;
          const replayParams = {
            principalId: principal.id,
            sourceId: path.sourceId,
          };

          const replayed = yield* sourceSyncService.replaySourceSyncJob(replayParams).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "UnsupportedProviderError":
                  return toBadRequestError(`Unsupported provider: ${error.provider}`);
                case "SourceNotFoundError":
                  return toBadRequestError(sourceNotFoundMessage);
                case "SourceSyncQueueError":
                  return toInternalServerError("Failed to enqueue source replay job.");
                default:
                  return toInternalServerError("Failed to replay source sync.");
              }
            }),
          );

          return SourceSyncStartResponse.make(replayed);
        }),
      )
      .handle("getSourceSyncJobStatus", ({ path }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal;
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
                    return new SourceNotFoundError({ message: "Sync job not found." });
                  default:
                    return toInternalServerError("Failed to load source sync job.");
                }
              }),
            );

          return SourceSyncJobResponse.make(job);
        }),
      )
      .handle("calculateTaxForSource", ({ path, payload }) =>
        Effect.gen(function* () {
          const principal = yield* resolveCurrentUserPrincipal;
          const sourceId = yield* Schema.decodeUnknown(SourceId)(path.sourceId).pipe(
            Effect.mapError(() => toBadRequestError("Invalid source identifier.")),
          );
          const maybeSource = yield* syncEngineSourceRepository
            .findOwnedSourceSyncContext({
              principalId: principal.id,
              sourceId,
            })
            .pipe(
              Effect.mapError(() =>
                toInternalServerError("Failed to load source for tax calculation."),
              ),
            );

          if (Option.isNone(maybeSource)) {
            return yield* Effect.fail(
              new SourceNotFoundError({
                message: sourceNotFoundMessage,
              }),
            );
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
                    return toBadRequestError(`Unsupported jurisdiction: ${error.jurisdiction}`);
                  case "TaxCalculationIncompleteDataError":
                    return toBadRequestError(
                      `Tax summary is not ready yet: ${error.reason}. Re-run sync and try again.`,
                    );
                  case "TaxCalculationUnsupportedCurrencyError":
                    return toBadRequestError(
                      `Tax summary currently supports ${error.expectedCurrency} only; found ${error.actualCurrency} in ${error.field}.`,
                    );
                  case "SourceNotFoundError":
                    return new SourceNotFoundError({
                      message: sourceNotFoundMessage,
                    });
                  default:
                    return toInternalServerError("Failed to compute tax summary.");
                }
              }),
            );

          return TaxCalculationResponse.make(taxes);
        }),
      );
  }),
).pipe(Layer.provide(SourceCreationServiceLive));
