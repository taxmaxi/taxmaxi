/**
 * AssetsApiLive - Live implementation of asset review endpoints.
 *
 * @module AssetsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { ProviderAssetRepository, type ProviderAssetReviewRecord } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ForbiddenError, InternalServerError } from "../definitions/ApiErrors.ts"
import {
  AssetBadRequestError,
  AssetCanonicalizationEvidenceResponse,
  AssetCanonicalizationResponse,
  AssetNotFoundError,
  CanonicalAssetResponse,
  ProviderAssetReviewListResponse,
  ProviderAssetReviewRow,
} from "../definitions/AssetsApi.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { AssetCanonicalizationService } from "../services/AssetCanonicalizationService.ts"

const defaultLimit = 50

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const requireAdmin = Effect.gen(function* () {
  const currentUser = yield* CurrentUser
  if (currentUser.role !== "admin") {
    return yield* Effect.fail(
      new ForbiddenError({
        message: "Admin role required.",
        resource: Option.some("assets"),
        action: Option.some("review"),
      })
    )
  }
  return currentUser
})

const toProviderAssetReviewRow = (row: ProviderAssetReviewRecord) =>
  ProviderAssetReviewRow.make({
    id: row.providerAsset.id,
    provider: row.providerAsset.provider,
    providerAssetId: row.providerAsset.providerAssetId,
    naturalKey: row.providerAsset.naturalKey,
    currencyCode: row.providerAsset.currencyCode,
    name: row.providerAsset.name,
    exponent: row.providerAsset.exponent,
    providerType: row.providerAsset.providerType,
    mappingKind: row.mapping?.mappingKind ?? null,
    canonicalAssetId: row.mapping?.canonicalAssetId ?? null,
    canonicalAssetSymbol: row.mapping?.canonicalAssetSymbol ?? null,
    canonicalFiatCurrency: row.mapping?.canonicalFiatCurrency ?? null,
    mappingStatus: row.mapping?.mappingStatus ?? null,
    reviewerNotes: row.mapping?.reviewerNotes ?? null,
    sourceNotes: row.mapping?.sourceNotes ?? null,
  })

export const AssetsApiLive = HttpApiBuilder.group(TaxMaxiApi, "assets", (handlers) =>
  Effect.gen(function* () {
    const providerAssetRepository = yield* ProviderAssetRepository
    const assetCanonicalizationService = yield* AssetCanonicalizationService

    return handlers
      .handle("listProviderAssetReviews", ({ urlParams }) =>
        Effect.gen(function* () {
          yield* requireAdmin
          const providerAssets = yield* providerAssetRepository
            .listProviderAssetReviews({
              providerKey: urlParams.provider ?? null,
              mappingStatus: urlParams.status ?? "pending_review",
              cursorProviderAssetRowId: urlParams.cursor ?? null,
              limit: (urlParams.limit ?? defaultLimit) + 1,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list provider assets.")))
          const limit = urlParams.limit ?? defaultLimit
          const visibleProviderAssets = providerAssets.slice(0, limit)
          const lastProviderAsset = visibleProviderAssets.at(-1)
          const hasMore = providerAssets.length > limit

          return ProviderAssetReviewListResponse.make({
            providerAssets: visibleProviderAssets.map(toProviderAssetReviewRow),
            page: {
              nextCursor:
                hasMore && lastProviderAsset !== undefined
                  ? lastProviderAsset.providerAsset.id
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("canonicalizeProviderAsset", ({ path, payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin
          const result = yield* assetCanonicalizationService
            .canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId: path.id,
              reviewerNotes: payload.reviewerNotes ?? null,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "AssetCanonicalizationBadRequestError":
                  case "AssetCanonicalizationProviderError":
                    return new AssetBadRequestError({ message: error.message })
                  case "AssetCanonicalizationNotFoundError":
                    return new AssetNotFoundError({ message: error.message })
                  case "AssetCanonicalizationInternalError":
                    return toInternalServerError(error.message)
                }
              })
            )

          return AssetCanonicalizationResponse.make({
            providerAsset: toProviderAssetReviewRow(result.providerAsset),
            canonicalAsset: CanonicalAssetResponse.make(result.canonicalAsset),
            evidence: AssetCanonicalizationEvidenceResponse.make(result.evidence),
          })
        })
      )
  })
)
