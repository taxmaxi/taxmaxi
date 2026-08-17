/**
 * ProviderAssetReviewServiceLive - Provider asset review orchestration.
 *
 * @module ProviderAssetReviewServiceLive
 */

import { ProviderAssetReplayService, ProviderAssetRepository } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssetCanonicalizationService } from "../services/AssetCanonicalizationService.ts"
import { ProviderAssetCandidateService } from "../services/ProviderAssetCandidateService.ts"
import {
  ProviderAssetReviewBadRequestError,
  ProviderAssetReviewConflictError,
  ProviderAssetReviewInternalError,
  ProviderAssetReviewNotFoundError,
  ProviderAssetReviewService,
  type ProviderAssetReviewError,
  type ProviderAssetReviewServiceShape,
} from "../services/ProviderAssetReviewService.ts"

const mapCanonicalizationError = (error: {
  readonly _tag: string
  readonly message: string
}): ProviderAssetReviewError => {
  switch (error._tag) {
    case "AssetCanonicalizationBadRequestError":
      return new ProviderAssetReviewBadRequestError({ message: error.message })
    case "AssetCanonicalizationNotFoundError":
      return new ProviderAssetReviewNotFoundError({ message: error.message })
    case "AssetCanonicalizationConflictError":
      return new ProviderAssetReviewConflictError({ message: error.message })
    default:
      return new ProviderAssetReviewInternalError({ message: error.message })
  }
}

const make = Effect.gen(function* () {
  const candidates = yield* ProviderAssetCandidateService
  const canonicalization = yield* AssetCanonicalizationService
  const providerAssets = yield* ProviderAssetRepository
  const replays = yield* ProviderAssetReplayService

  const loadReview = (providerAssetRowId: string) =>
    providerAssets.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () => new ProviderAssetReviewInternalError({ message: "Failed to load provider asset." })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProviderAssetReviewNotFoundError({ message: "Provider asset not found." })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const decide: ProviderAssetReviewServiceShape["decide"] = ({
    providerAssetRowId,
    decision,
    reviewerNotes,
    reviewedBy,
  }) => {
    switch (decision._tag) {
      case "MapToExisting":
        return Effect.gen(function* () {
          const review = yield* loadReview(providerAssetRowId)
          if (review.mapping?.mappingStatus !== "pending_review") {
            return yield* new ProviderAssetReviewConflictError({
              message: "Provider asset has already been reviewed.",
            })
          }
          const result = yield* canonicalization
            .approveProviderAssetMapping({
              providerAssetRowId,
              canonicalAssetId: decision.canonicalAssetId,
              assetRepresentationId: decision.assetRepresentationId,
              reviewerNotes,
              reviewedBy,
              requirePendingReview: true,
            })
            .pipe(Effect.mapError(mapCanonicalizationError))
          return {
            providerAsset: result,
            canonicalAsset: null,
            evidence: null,
            replays: result.replays,
          }
        })
      case "CreateFromCoinGecko":
        return Effect.gen(function* () {
          const review = yield* loadReview(providerAssetRowId)
          if (review.mapping?.mappingStatus !== "pending_review") {
            return yield* new ProviderAssetReviewConflictError({
              message: "Provider asset has already been reviewed.",
            })
          }
          return yield* canonicalization
            .canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId,
              coinId: decision.coinId,
              reviewerNotes,
              reviewedBy,
              requirePendingReview: true,
            })
            .pipe(Effect.mapError(mapCanonicalizationError))
        })
      case "ApproveAsFiat":
        return Effect.gen(function* () {
          const review = yield* loadReview(providerAssetRowId)
          if (review.mapping?.mappingStatus !== "pending_review") {
            return yield* new ProviderAssetReviewConflictError({
              message: "Provider asset has already been reviewed.",
            })
          }
          if (review.providerAsset.providerType?.trim().toLowerCase() !== "fiat") {
            return yield* new ProviderAssetReviewBadRequestError({
              message: "Only fiat provider observations can be approved as fiat.",
            })
          }

          const observed = yield* providerAssets
            .listProviderAssetObservedRepresentations({ providerAssetRowId })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAssetReviewInternalError({
                    message: "Failed to validate fiat evidence.",
                  })
              )
            )
          if (observed.length > 0) {
            return yield* new ProviderAssetReviewBadRequestError({
              message: "On-chain observations cannot be approved as fiat.",
            })
          }

          const approval = yield* providerAssets
            .approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId,
                mappingKind: "fiat",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: review.providerAsset.currencyCode.toUpperCase(),
                mappingStatus: "approved",
                reviewerNotes,
                sourceNotes: review.mapping.sourceNotes,
              },
              reviewedBy,
              reviewedAt: new Date(),
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: review.providerAsset.retrievedAt,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAssetReviewConflictError({
                    message: "Provider asset changed before approval.",
                  })
              )
            )
          const providerAsset = yield* loadReview(providerAssetRowId)

          return { providerAsset, canonicalAsset: null, evidence: null, replays: approval.replays }
        })
      case "Reject":
        return Effect.gen(function* () {
          const reason = decision.reason.trim()
          if (reason === "") {
            return yield* new ProviderAssetReviewBadRequestError({
              message: "A rejection reason is required.",
            })
          }
          const review = yield* loadReview(providerAssetRowId)
          if (review.mapping?.mappingStatus !== "pending_review") {
            return yield* new ProviderAssetReviewConflictError({
              message: "Provider asset has already been reviewed.",
            })
          }
          const updated = yield* providerAssets
            .rejectProviderAssetMapping({
              providerAssetRowId,
              reviewerNotes: reason,
              reviewedBy,
              reviewedAt: new Date(),
              expectedProviderAssetRetrievedAt: review.providerAsset.retrievedAt,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAssetReviewConflictError({
                    message: "Provider asset changed before rejection.",
                  })
              )
            )
          if (!updated) {
            return yield* new ProviderAssetReviewConflictError({
              message: "Provider asset has already been reviewed.",
            })
          }
          const providerAsset = yield* loadReview(providerAssetRowId)

          return { providerAsset, canonicalAsset: null, evidence: null, replays: [] }
        })
    }
  }

  const mapReplayError = (error: { readonly kind: "conflict" | "internal" | "not_found" }) => {
    switch (error.kind) {
      case "conflict":
        return new ProviderAssetReviewConflictError({
          message: "Replay was retried by another request.",
        })
      case "not_found":
        return new ProviderAssetReviewNotFoundError({ message: "Replay not found." })
      case "internal":
        return new ProviderAssetReviewInternalError({ message: "Replay operation failed." })
    }
  }

  return ProviderAssetReviewService.of({
    listCandidates: ({ providerAssetRowId }) =>
      Effect.gen(function* () {
        yield* loadReview(providerAssetRowId)
        return yield* candidates
          .listCandidates({ providerAssetRowId })
          .pipe(
            Effect.mapError(
              (error) => new ProviderAssetReviewInternalError({ message: error.message })
            )
          )
      }),
    decide,
    getReplay: (params) => replays.getReplay(params).pipe(Effect.mapError(mapReplayError)),
    retryReplay: (params) => replays.retryReplay(params).pipe(Effect.mapError(mapReplayError)),
  })
})

/** Live provider asset review orchestration. */
export const ProviderAssetReviewServiceLive = Layer.effect(ProviderAssetReviewService, make)
