/**
 * AssetsApiLive - Live implementation of asset review endpoints.
 *
 * @module AssetsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { AssetCatalogRepository, type AssetCatalogAssetRecord } from "@my/persistence/services"
import {
  ProviderAssetReviewRepository,
  type ProviderAssetReviewRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  AssetBadRequestError,
  AssetConflictError,
  AssetCanonicalizationEvidenceResponse,
  AssetCanonicalizationResponse,
  AssetNotFoundError,
  CanonicalAssetResponse,
  ProviderAssetReviewListResponse,
  ProviderAssetReviewRow,
  CoinGeckoAssetCandidateListResponse,
  CoinGeckoAssetCandidateResponse,
  ProviderAssetDecisionResponse,
} from "../definitions/AssetsApi.ts"
import { SourceSyncJobResponse, SourceSyncStartResponse } from "../definitions/SourcesApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { ProviderAssetReviewService } from "../services/ProviderAssetReviewService.ts"

const defaultLimit = 50
const defaultAssetLimit = 500

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const ProviderPayloadSource = Schema.Struct({ source: Schema.String })
const isProviderPayloadSource = Schema.is(ProviderPayloadSource)

const providerAssetEvidenceSource = (row: ProviderAssetReviewRecord) => {
  const provider = row.providerAsset.provider.trim().toLowerCase()
  const payloadSource = isProviderPayloadSource(row.providerAsset.rawProviderPayload)
    ? row.providerAsset.rawProviderPayload.source
    : null

  if (provider === "coinbase") {
    const directResponse =
      row.providerAsset.name !== null || row.providerAsset.providerType !== null
    const providerSuppliedType =
      directResponse &&
      row.providerAsset.providerType !== null &&
      row.providerAsset.providerType !== "fiat"
    return {
      providerName: "Coinbase",
      apiName: "Coinbase App API",
      endpoint:
        row.providerAsset.providerType === "fiat"
          ? "GET /v2/currencies"
          : directResponse
            ? "GET /v2/currencies/crypto"
            : "Observed in a Coinbase transaction",
      documentationUrl: "https://docs.cdp.coinbase.com/coinbase-app/track-apis/currencies",
      payloadKind: directResponse ? ("direct_response" as const) : ("derived_observation" as const),
      typeSource: providerSuppliedType ? ("provider" as const) : ("taxmaxi_inferred" as const),
      typeExplanation: providerSuppliedType
        ? "Coinbase reports this classification in its currency response."
        : row.providerAsset.providerType === "fiat"
          ? "TaxMaxi classifies entries from Coinbase's fiat currency endpoint as fiat."
          : "Coinbase did not report a currency classification for this observation.",
    }
  }

  if (provider === "helius-solana") {
    const fallback = payloadSource === "helius_das_get_asset_batch_missing"
    const builtIn = payloadSource === "taxmaxi_builtin_solana_asset_mapping"
    return {
      providerName: "Helius",
      apiName: "Helius Digital Asset Standard API",
      endpoint: builtIn ? null : "DAS getAssetBatch",
      documentationUrl: "https://www.helius.dev/docs/api-reference/das/getassetbatch",
      payloadKind: fallback
        ? ("fallback" as const)
        : builtIn
          ? ("fallback" as const)
          : ("direct_response" as const),
      typeSource: "taxmaxi_inferred" as const,
      typeExplanation:
        "TaxMaxi infers native coin, fungible token, Token-2022 token, or NFT from Helius DAS metadata and the Solana token program.",
    }
  }

  return {
    providerName: row.providerAsset.provider,
    apiName: row.providerAsset.provider,
    endpoint: null,
    documentationUrl: null,
    payloadKind: "derived_observation" as const,
    typeSource: "taxmaxi_inferred" as const,
    typeExplanation: "TaxMaxi could not determine how this provider classification was produced.",
  }
}

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
    evidenceSource: providerAssetEvidenceSource(row),
    rawProviderPayload: row.providerAsset.rawProviderPayload,
    discoveredAt: DateTime.unsafeMake(row.providerAsset.discoveredAt),
    retrievedAt: DateTime.unsafeMake(row.providerAsset.retrievedAt),
    mappingKind: row.mapping?.mappingKind ?? null,
    canonicalAssetId: row.mapping?.canonicalAssetId ?? null,
    canonicalAssetSymbol: row.mapping?.canonicalAssetSymbol ?? null,
    canonicalFiatCurrency: row.mapping?.canonicalFiatCurrency ?? null,
    mappingStatus: row.mapping?.mappingStatus ?? null,
    reviewerNotes: row.mapping?.reviewerNotes ?? null,
    sourceNotes: row.mapping?.sourceNotes ?? null,
    reviewedBy: row.mapping?.reviewedBy ?? null,
    reviewedAt:
      row.mapping?.reviewedAt === null || row.mapping?.reviewedAt === undefined
        ? null
        : DateTime.unsafeMake(row.mapping.reviewedAt),
  })

const toAssetCatalogAssetResponse = (row: AssetCatalogAssetRecord) =>
  AssetCatalogAssetResponse.make({
    id: row.id,
    blockchainId: row.blockchainId,
    blockchainName: row.blockchainName,
    blockchainChainType: row.blockchainChainType,
    blockchainChainId: row.blockchainChainId,
    blockchainExplorerUrl: row.blockchainExplorerUrl,
    blockchainLogoUrl: row.blockchainLogoUrl,
    contractAddress: row.contractAddress,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    logoUrl: row.logoUrl,
    type: row.type,
    isSpam: row.isSpam,
  })

export const AssetsApiLive = HttpApiBuilder.group(TaxMaxiApi, "assets", (handlers) =>
  Effect.gen(function* () {
    const assetCatalogRepository = yield* AssetCatalogRepository
    const providerAssetReviewRepository = yield* ProviderAssetReviewRepository
    const providerAssetReviewService = yield* ProviderAssetReviewService

    return handlers
      .handle("listAssets", ({ urlParams }) =>
        Effect.gen(function* () {
          const assets = yield* assetCatalogRepository
            .listAssets({
              query: urlParams.q ?? null,
              limit: urlParams.limit ?? defaultAssetLimit,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list assets.")))

          return AssetCatalogListResponse.make({
            assets: assets.map(toAssetCatalogAssetResponse),
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
      .handle("listProviderAssetReviews", ({ urlParams }) =>
        Effect.gen(function* () {
          const providerAssets = yield* providerAssetReviewRepository
            .listProviderAssetReviews({
              providerKey: urlParams.provider ?? null,
              mappingStatus: urlParams.status ?? "pending_review",
              query: urlParams.q ?? null,
              cursorProviderAssetRowId: urlParams.cursor ?? null,
              limit: (urlParams.limit ?? defaultLimit) + 1,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list provider assets.")))
          const totalCount = yield* providerAssetReviewRepository
            .countProviderAssetReviews({
              providerKey: urlParams.provider ?? null,
              mappingStatus: urlParams.status ?? "pending_review",
              query: urlParams.q ?? null,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to count provider assets.")))
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
            totalCount,
          })
        })
      )
      .handle("listProviderAssetCandidates", ({ path }) =>
        Effect.gen(function* () {
          const candidates = yield* providerAssetReviewService
            .listCoinGeckoCandidates({ providerAssetRowId: path.id })
            .pipe(Effect.mapError(mapReviewError))
          return CoinGeckoAssetCandidateListResponse.make({
            candidates: candidates.map((candidate) =>
              CoinGeckoAssetCandidateResponse.make(candidate)
            ),
          })
        })
      )
      .handle("canonicalizeProviderAsset", ({ path, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* providerAssetReviewService
            .canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId: path.id,
              coinId: payload.coinId,
              reviewerNotes: payload.reviewerNotes ?? null,
              reviewedBy: currentUser.userId,
            })
            .pipe(Effect.mapError(mapReviewError))

          return AssetCanonicalizationResponse.make({
            providerAsset: toProviderAssetReviewRow(result.providerAsset),
            canonicalAsset: CanonicalAssetResponse.make(result.canonicalAsset),
            evidence: AssetCanonicalizationEvidenceResponse.make(result.evidence),
            replays: [...result.replays],
          })
        })
      )
      .handle("mapProviderAsset", ({ path, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* providerAssetReviewService
            .mapProviderAssetToExisting({
              providerAssetRowId: path.id,
              canonicalAssetId: payload.canonicalAssetId,
              reviewerNotes: payload.reviewerNotes ?? null,
              reviewedBy: currentUser.userId,
            })
            .pipe(Effect.mapError(mapReviewError))
          return ProviderAssetDecisionResponse.make({
            providerAsset: toProviderAssetReviewRow(result.providerAsset),
            replays: [...result.replays],
          })
        })
      )
      .handle("approveProviderAssetAsFiat", ({ path }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* providerAssetReviewService
            .approveProviderAssetAsFiat({
              providerAssetRowId: path.id,
              reviewedBy: currentUser.userId,
            })
            .pipe(Effect.mapError(mapReviewError))
          return ProviderAssetDecisionResponse.make({
            providerAsset: toProviderAssetReviewRow(result.providerAsset),
            replays: [...result.replays],
          })
        })
      )
      .handle("rejectProviderAsset", ({ path, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* providerAssetReviewService
            .rejectProviderAsset({
              providerAssetRowId: path.id,
              rejectionReason: payload.rejectionReason,
              reviewedBy: currentUser.userId,
            })
            .pipe(Effect.mapError(mapReviewError))
          return ProviderAssetDecisionResponse.make({
            providerAsset: toProviderAssetReviewRow(result.providerAsset),
            replays: [],
          })
        })
      )
      .handle("getProviderAssetReplay", ({ path }) =>
        providerAssetReviewService
          .getProviderAssetReplay({
            providerAssetRowId: path.id,
            sourceId: path.sourceId,
            jobId: path.jobId,
          })
          .pipe(
            Effect.map((job) => SourceSyncJobResponse.make(job)),
            Effect.mapError(mapReplayError)
          )
      )
      .handle("retryProviderAssetReplay", ({ path }) =>
        providerAssetReviewService
          .retryProviderAssetReplay({
            providerAssetRowId: path.id,
            sourceId: path.sourceId,
            jobId: path.jobId,
          })
          .pipe(
            Effect.map((job) => SourceSyncStartResponse.make(job)),
            Effect.mapError(mapReplayError)
          )
      )
  })
)

const mapReviewError = (error: { readonly _tag: string; readonly message: string }) => {
  switch (error._tag) {
    case "ProviderAssetReviewBadRequestError":
      return new AssetBadRequestError({ message: error.message })
    case "ProviderAssetReviewNotFoundError":
      return new AssetNotFoundError({ message: error.message })
    case "ProviderAssetReviewConflictError":
      return new AssetConflictError({ message: error.message })
    default:
      return toInternalServerError(error.message)
  }
}

const mapReplayError = (error: { readonly _tag: string; readonly message: string }) => {
  switch (error._tag) {
    case "ProviderAssetReviewNotFoundError":
      return new AssetNotFoundError({ message: error.message })
    case "ProviderAssetReviewConflictError":
      return new AssetConflictError({ message: error.message })
    default:
      return toInternalServerError(error.message)
  }
}
