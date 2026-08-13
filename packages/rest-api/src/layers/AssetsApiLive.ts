/**
 * AssetsApiLive - Live implementation of asset review endpoints.
 *
 * @module AssetsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import {
  AssetCatalogRepository,
  type AssetCatalogAssetRecord,
  type PendingAssetCatalogRecord,
} from "@my/persistence/services"
import {
  ProviderAssetRepository,
  TransferReconciliationRepository,
  type ProviderAssetReviewRecord,
  type UnresolvedTransferReconciliationRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  AssetBadRequestError,
  AssetCanonicalizationEvidenceResponse,
  AssetCanonicalizationResponse,
  AssetNotFoundError,
  AssetRepresentationResponse,
  CanonicalAssetResponse,
  PendingAssetListResponse,
  PendingAssetResponse,
  ProviderAssetReviewListResponse,
  ProviderAssetReviewRow,
  UnresolvedTransferReconciliationListResponse,
  UnresolvedTransferReconciliationRow,
} from "../definitions/AssetsApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { AssetCanonicalizationService } from "../services/AssetCanonicalizationService.ts"

const defaultLimit = 50
const defaultAssetLimit = 500

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const AssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  assetId: Schema.UUID,
})

const ProviderAssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  providerAssetRowId: Schema.UUID,
})

const TransferReconciliationCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  reconciliationId: Schema.UUID,
})

const EncodedAssetCursorPayload = Schema.parseJson(AssetCursorPayload)
const EncodedProviderAssetCursorPayload = Schema.parseJson(ProviderAssetCursorPayload)
const EncodedTransferReconciliationCursorPayload = Schema.parseJson(
  TransferReconciliationCursorPayload
)

const encodeCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url")

const decodeCursor = <A>(
  cursor: string,
  schema: Schema.Schema<A, string>
): Effect.Effect<A, AssetBadRequestError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url").toString("utf8"),
      catch: () => new AssetBadRequestError({ message: "Invalid asset cursor." }),
    })

    return yield* Schema.decodeUnknown(schema)(decoded).pipe(
      Effect.mapError(() => new AssetBadRequestError({ message: "Invalid asset cursor." }))
    )
  })

const decodeAssetCursor = (cursor: string | undefined) =>
  cursor === undefined ? Effect.succeed(null) : decodeCursor(cursor, EncodedAssetCursorPayload)

const decodeProviderAssetCursor = (cursor: string | undefined) =>
  cursor === undefined
    ? Effect.succeed(null)
    : decodeCursor(cursor, EncodedProviderAssetCursorPayload)

const decodeTransferReconciliationCursor = (cursor: string | undefined) =>
  cursor === undefined
    ? Effect.succeed(null)
    : decodeCursor(cursor, EncodedTransferReconciliationCursorPayload)

const assetCursorFor = (asset: AssetCatalogAssetRecord): string =>
  encodeCursor({
    version: 2,
    assetId: asset.id,
  })

const providerAssetCursorFor = (providerAssetRowId: string): string =>
  encodeCursor({
    version: 2,
    providerAssetRowId,
  })

const transferReconciliationCursorFor = (reconciliationId: string): string =>
  encodeCursor({
    version: 1,
    reconciliationId,
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
    assetRepresentationId: row.mapping?.assetRepresentationId ?? null,
    canonicalFiatCurrency: row.mapping?.canonicalFiatCurrency ?? null,
    mappingStatus: row.mapping?.mappingStatus ?? null,
    reviewerNotes: row.mapping?.reviewerNotes ?? null,
    sourceNotes: row.mapping?.sourceNotes ?? null,
  })

const toPendingAssetResponse = (row: PendingAssetCatalogRecord) =>
  PendingAssetResponse.make({
    id: row.id,
    provider: row.provider,
    providerAssetId: row.providerAssetId,
    symbol: row.symbol,
    name: row.name,
    providerType: row.providerType,
  })

const toUnresolvedTransferReconciliationRow = (row: UnresolvedTransferReconciliationRecord) =>
  UnresolvedTransferReconciliationRow.make({
    ...row,
    providerTimestamp: row.providerTimestamp.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })

const toAssetCatalogAssetResponse = (row: AssetCatalogAssetRecord) =>
  AssetCatalogAssetResponse.make({
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    coingeckoCoinId: row.coingeckoCoinId,
    logoUrl: row.logoUrl,
    type: row.type,
    representations: row.representations.map((representation) =>
      AssetRepresentationResponse.make(representation)
    ),
  })

export const AssetsApiLive = HttpApiBuilder.group(TaxMaxiApi, "assets", (handlers) =>
  Effect.gen(function* () {
    const assetCatalogRepository = yield* AssetCatalogRepository
    const providerAssetRepository = yield* ProviderAssetRepository
    const transferReconciliationRepository = yield* TransferReconciliationRepository
    const assetCanonicalizationService = yield* AssetCanonicalizationService

    return handlers
      .handle("listAssets", ({ urlParams }) =>
        Effect.gen(function* () {
          const limit = urlParams.limit ?? defaultAssetLimit
          const cursor = yield* decodeAssetCursor(urlParams.cursor)
          const assets = yield* assetCatalogRepository
            .listAssets({
              cursor,
              query: urlParams.q ?? null,
              limit: limit + 1,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list assets.")))
          const visibleAssets = assets.slice(0, limit)
          const lastAsset = visibleAssets.at(-1)
          const hasMore = assets.length > limit

          return AssetCatalogListResponse.make({
            assets: visibleAssets.map(toAssetCatalogAssetResponse),
            page: {
              nextCursor: hasMore && lastAsset !== undefined ? assetCursorFor(lastAsset) : null,
              hasMore,
            },
          })
        })
      )
      .handle("getAsset", ({ path }) =>
        Effect.gen(function* () {
          const maybeAsset = yield* assetCatalogRepository
            .findAssetById({ assetId: path.assetId })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to load asset.")))

          return yield* Option.match(maybeAsset, {
            onNone: () => Effect.fail(new AssetNotFoundError({ message: "Asset not found." })),
            onSome: (asset) => Effect.succeed(toAssetCatalogAssetResponse(asset)),
          })
        })
      )
      .handle("listPendingAssets", ({ urlParams }) =>
        Effect.gen(function* () {
          const limit = urlParams.limit ?? defaultLimit
          const cursor = yield* decodeProviderAssetCursor(urlParams.cursor)
          const providerAssets = yield* assetCatalogRepository
            .listPendingAssets({
              provider: urlParams.provider ?? null,
              cursor,
              query: urlParams.q ?? null,
              limit: limit + 1,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list pending assets.")))
          const visibleProviderAssets = providerAssets.slice(0, limit)
          const lastProviderAsset = visibleProviderAssets.at(-1)
          const hasMore = providerAssets.length > limit

          return PendingAssetListResponse.make({
            pendingAssets: visibleProviderAssets.map(toPendingAssetResponse),
            page: {
              nextCursor:
                hasMore && lastProviderAsset !== undefined
                  ? providerAssetCursorFor(lastProviderAsset.id)
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("listProviderAssetReviews", ({ urlParams }) =>
        Effect.gen(function* () {
          const cursor = yield* decodeProviderAssetCursor(urlParams.cursor)
          const providerAssets = yield* providerAssetRepository
            .listProviderAssetReviews({
              providerKey: urlParams.provider ?? null,
              mappingStatus: urlParams.status ?? "pending_review",
              cursor,
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
                  ? providerAssetCursorFor(lastProviderAsset.providerAsset.id)
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("listUnresolvedTransferReconciliations", ({ urlParams }) =>
        Effect.gen(function* () {
          const limit = urlParams.limit ?? defaultLimit
          const cursor = yield* decodeTransferReconciliationCursor(urlParams.cursor)
          const reconciliations = yield* transferReconciliationRepository
            .listUnresolvedTransferReconciliations({
              status: urlParams.status ?? null,
              cursorId: cursor?.reconciliationId ?? null,
              limit: limit + 1,
            })
            .pipe(
              Effect.mapError(() =>
                toInternalServerError("Failed to list unresolved transfer reconciliations.")
              )
            )
          const visibleReconciliations = reconciliations.slice(0, limit)
          const lastReconciliation = visibleReconciliations.at(-1)
          const hasMore = reconciliations.length > limit

          return UnresolvedTransferReconciliationListResponse.make({
            reconciliations: visibleReconciliations.map(toUnresolvedTransferReconciliationRow),
            page: {
              nextCursor:
                hasMore && lastReconciliation !== undefined
                  ? transferReconciliationCursorFor(lastReconciliation.id)
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("canonicalizeProviderAsset", ({ path, payload }) =>
        Effect.gen(function* () {
          const result = yield* assetCanonicalizationService
            .canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId: path.id,
              reviewerNotes: payload.reviewerNotes ?? null,
            })
            .pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "AssetCanonicalizationBadRequestError":
                    return new AssetBadRequestError({ message: error.message })
                  case "AssetCanonicalizationProviderError":
                    return toInternalServerError(error.message)
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
