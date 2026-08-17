/**
 * AssetsApiLive - Live implementation of asset review endpoints.
 *
 * @module AssetsApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  AssetCatalogRepository,
  type AssetCatalogAssetRecord,
  type PendingAssetCatalogRecord,
} from "@my/persistence/services"
import {
  TransferReconciliationRepository,
  type ProviderAssetReplayStatus,
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
  AssetConflictError,
  AssetNotFoundError,
  AssetRepresentationResponse,
  PendingAssetListResponse,
  PendingAssetResponse,
  ProviderAssetDecisionResponse,
  ProviderAssetReplayResponse,
  ProviderAssetResolutionProposalListResponse,
  ProviderAssetResolutionProposalResponse,
  ProviderAssetReviewDetailResponse,
  ProviderAssetReviewListResponse,
  ProviderAssetReviewRow,
  UnresolvedTransferReconciliationListResponse,
  UnresolvedTransferReconciliationRow,
} from "../definitions/AssetsApi.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  ProviderAssetReviewService,
  type ProviderAssetReviewError,
  type ProviderAssetReviewDetail,
  type ProviderAssetReviewSummary,
} from "../services/ProviderAssetReviewService.ts"

const defaultLimit = 50
const defaultAssetLimit = 50

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const AssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  assetId: Schema.String.check(Schema.isUUID()),
})

const PendingAssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const ProviderAssetReviewCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  discoveredAt: Schema.DateFromString,
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const TransferReconciliationCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  reconciliationId: Schema.String.check(Schema.isUUID()),
})

const EncodedAssetCursorPayload = Schema.fromJsonString(AssetCursorPayload)
const EncodedPendingAssetCursorPayload = Schema.fromJsonString(PendingAssetCursorPayload)
const EncodedProviderAssetReviewCursorPayload = Schema.fromJsonString(
  ProviderAssetReviewCursorPayload
)
const EncodedTransferReconciliationCursorPayload = Schema.fromJsonString(
  TransferReconciliationCursorPayload
)

const encodeCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url")

const decodeCursor = <S extends Schema.ConstraintDecoder<unknown, never>>(
  cursor: string,
  schema: S
): Effect.Effect<S["Type"], AssetBadRequestError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url").toString("utf8"),
      catch: () => new AssetBadRequestError({ message: "Invalid asset cursor." }),
    })

    return yield* Schema.decodeUnknownEffect(schema)(decoded).pipe(
      Effect.mapError(() => new AssetBadRequestError({ message: "Invalid asset cursor." }))
    )
  })

const decodeAssetCursor = (cursor: string | undefined) =>
  cursor === undefined ? Effect.succeed(null) : decodeCursor(cursor, EncodedAssetCursorPayload)

const decodeProviderAssetCursor = (cursor: string | undefined) =>
  cursor === undefined
    ? Effect.succeed(null)
    : decodeCursor(cursor, EncodedPendingAssetCursorPayload)

const decodeProviderAssetReviewCursor = (cursor: string | undefined) =>
  cursor === undefined
    ? Effect.succeed(null)
    : decodeCursor(cursor, EncodedProviderAssetReviewCursorPayload)

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

const providerAssetReviewCursorFor = (review: ProviderAssetReviewSummary): string =>
  encodeCursor({
    version: 1,
    discoveredAt: review.discoveredAt.toISOString(),
    providerAssetRowId: review.id,
  })

const transferReconciliationCursorFor = (reconciliationId: string): string =>
  encodeCursor({
    version: 1,
    reconciliationId,
  })

const toProviderAssetReviewFields = (row: ProviderAssetReviewSummary) => ({
  ...row,
  discoveredAt: row.discoveredAt.toISOString(),
})

const toProviderAssetReviewRow = (row: ProviderAssetReviewSummary) =>
  ProviderAssetReviewRow.make(toProviderAssetReviewFields(row))

const toReplayResponse = (replay: ProviderAssetReplayStatus) =>
  ProviderAssetReplayResponse.make(replay)

const toProviderAssetReviewDetail = (review: ProviderAssetReviewDetail) =>
  ProviderAssetReviewDetailResponse.make({
    ...toProviderAssetReviewFields(review),
    rawEvidence: review.rawEvidence,
    observedRepresentations: review.observedRepresentations,
    mapping:
      review.mapping === null
        ? null
        : {
            ...review.mapping,
            reviewedAt: review.mapping.reviewedAt?.toISOString() ?? null,
            updatedAt: review.mapping.updatedAt.toISOString(),
          },
    replays: review.replays.map(toReplayResponse),
  })

const mapReviewError = (error: ProviderAssetReviewError) => {
  switch (error._tag) {
    case "ProviderAssetReviewBadRequestError":
      return new AssetBadRequestError({ message: error.message })
    case "ProviderAssetReviewConflictError":
      return new AssetConflictError({
        message: error.message,
        latestDecision: error.latestDecision,
      })
    case "ProviderAssetReviewNotFoundError":
      return new AssetNotFoundError({ message: error.message })
    case "ProviderAssetReviewInternalError":
      return toInternalServerError(error.message)
  }
}

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
    const transferReconciliationRepository = yield* TransferReconciliationRepository
    const providerAssetReviewService = yield* ProviderAssetReviewService

    return handlers
      .handle("listAssets", ({ query: urlParams }) =>
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
      .handle("getAsset", ({ params: path }) =>
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
      .handle("listPendingAssets", ({ query: urlParams }) =>
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
      .handle("listProviderAssetReviews", ({ query: urlParams }) =>
        Effect.gen(function* () {
          const cursor = yield* decodeProviderAssetReviewCursor(urlParams.cursor)
          const providerAssets = yield* providerAssetReviewService
            .listReviews({
              provider: urlParams.provider ?? null,
              status: urlParams.status ?? "pending_review",
              evidenceState: urlParams.evidence ?? null,
              query: urlParams.q ?? null,
              cursor,
              limit: (urlParams.limit ?? defaultLimit) + 1,
            })
            .pipe(Effect.mapError(mapReviewError))
          const limit = urlParams.limit ?? defaultLimit
          const visibleProviderAssets = providerAssets.slice(0, limit)
          const lastProviderAsset = visibleProviderAssets.at(-1)
          const hasMore = providerAssets.length > limit

          return ProviderAssetReviewListResponse.make({
            providerAssets: visibleProviderAssets.map(toProviderAssetReviewRow),
            page: {
              nextCursor:
                hasMore && lastProviderAsset !== undefined
                  ? providerAssetReviewCursorFor(lastProviderAsset)
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("getProviderAssetReview", ({ params: path }) =>
        providerAssetReviewService
          .getReview({ providerAssetRowId: path.id })
          .pipe(Effect.map(toProviderAssetReviewDetail), Effect.mapError(mapReviewError))
      )
      .handle("searchProviderAssetResolutionProposals", ({ params: path, query }) =>
        providerAssetReviewService
          .searchProposals({
            providerAssetRowId: path.id,
            query: query.q ?? null,
          })
          .pipe(
            Effect.map((result) =>
              ProviderAssetResolutionProposalListResponse.make({
                ...result,
                proposals: result.proposals.map((proposal) =>
                  ProviderAssetResolutionProposalResponse.make(proposal)
                ),
              })
            ),
            Effect.mapError(mapReviewError)
          )
      )
      .handle("decideProviderAssetReview", ({ params: path, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* providerAssetReviewService
            .decide({
              providerAssetRowId: path.id,
              decision: payload.decision,
              reviewRevision: payload.reviewRevision,
              reviewerNotes: payload.reviewerNotes ?? null,
              reviewedBy: currentUser.userId,
            })
            .pipe(Effect.mapError(mapReviewError))
          const review = yield* providerAssetReviewService
            .getReview({ providerAssetRowId: path.id })
            .pipe(Effect.mapError(mapReviewError))

          return ProviderAssetDecisionResponse.make({
            review: toProviderAssetReviewDetail(review),
            resolutionEffect: result.resolutionEffect,
            replays: result.replays.map(toReplayResponse),
          })
        })
      )
      .handle("listUnresolvedTransferReconciliations", ({ query: urlParams }) =>
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
      .handle("getProviderAssetReplay", ({ params: path }) =>
        providerAssetReviewService
          .getReplay({
            providerAssetRowId: path.id,
            sourceId: path.sourceId,
            jobId: path.jobId,
          })
          .pipe(Effect.map(toReplayResponse), Effect.mapError(mapReviewError))
      )
      .handle("retryProviderAssetReplay", ({ params: path }) =>
        providerAssetReviewService
          .retryReplay({
            providerAssetRowId: path.id,
            sourceId: path.sourceId,
            jobId: path.jobId,
          })
          .pipe(Effect.map(toReplayResponse), Effect.mapError(mapReviewError))
      )
  })
)
