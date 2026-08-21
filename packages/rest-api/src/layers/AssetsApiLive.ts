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
  AssetExceptionRepository,
  ProviderAssetRepository,
  TransferReconciliationRepository,
  type AssetExceptionDecisionHistory,
  type AssetExceptionDetail,
  type AssetExceptionImpact,
  type AssetExceptionListRow,
  type AssetExceptionRematerializationSummary,
  type ProviderAssetReviewRecord,
  type UnresolvedTransferReconciliationRecord,
} from "@my/sync-engine/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  AssetBadRequestError,
  AssetDecisionConflictError,
  AssetDecisionValidationError,
  AssetExceptionDecisionHistoryResponse,
  AssetExceptionDetailResponse,
  AssetExceptionEvidenceResponse,
  AssetExceptionImpactResponse,
  AssetExceptionListResponse,
  AssetExceptionListRowResponse,
  AssetExceptionPreviewResponse,
  AssetExceptionRematerializationResponse,
  AssetStaleRevisionError,
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
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { AssetCanonicalizationService } from "../services/AssetCanonicalizationService.ts"

const defaultLimit = 50
const defaultAssetLimit = 500

const toDateTimeUtc = (date: Date): DateTime.Utc => DateTime.makeUnsafe(date)

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const AssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  assetId: Schema.String.check(Schema.isUUID()),
})

const ProviderAssetCursorPayload = Schema.Struct({
  version: Schema.Literal(2),
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const TransferReconciliationCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  reconciliationId: Schema.String.check(Schema.isUUID()),
})

const AssetExceptionCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  blockedReports: Schema.Number,
  affectedPrincipals: Schema.Number,
  affectedTransactions: Schema.Number,
  affectedSources: Schema.Number,
  affectedTransactionValueEur: Schema.NullOr(Schema.String),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  oldestAt: Schema.DateTimeUtcFromString,
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const EncodedAssetCursorPayload = Schema.fromJsonString(AssetCursorPayload)
const EncodedProviderAssetCursorPayload = Schema.fromJsonString(ProviderAssetCursorPayload)
const EncodedTransferReconciliationCursorPayload = Schema.fromJsonString(
  TransferReconciliationCursorPayload
)
const EncodedAssetExceptionCursorPayload = Schema.fromJsonString(AssetExceptionCursorPayload)

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
    : decodeCursor(cursor, EncodedProviderAssetCursorPayload)

const decodeTransferReconciliationCursor = (cursor: string | undefined) =>
  cursor === undefined
    ? Effect.succeed(null)
    : decodeCursor(cursor, EncodedTransferReconciliationCursorPayload)

const decodeAssetExceptionCursor = (cursor: string | undefined) =>
  Effect.gen(function* () {
    if (cursor === undefined) {
      return null
    }
    const value = yield* decodeCursor(cursor, EncodedAssetExceptionCursorPayload)
    return {
      blockedReports: value.blockedReports,
      affectedPrincipals: value.affectedPrincipals,
      affectedTransactions: value.affectedTransactions,
      affectedSources: value.affectedSources,
      affectedTransactionValueEur: value.affectedTransactionValueEur,
      severity: value.severity,
      oldestAt: DateTime.toDateUtc(value.oldestAt),
      providerAssetRowId: value.providerAssetRowId,
    }
  })

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

const assetExceptionCursorFor = (row: AssetExceptionListRow): string =>
  encodeCursor({
    version: 1,
    blockedReports: row.blockedReports,
    affectedPrincipals: row.affectedPrincipals,
    affectedTransactions: row.affectedTransactions,
    affectedSources: row.affectedSources,
    affectedTransactionValueEur: row.affectedTransactionValueEur,
    severity: row.severity,
    oldestAt: row.oldestAt.toISOString(),
    providerAssetRowId: row.providerAssetRowId,
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

const toAssetExceptionImpactResponse = (impact: AssetExceptionImpact) =>
  AssetExceptionImpactResponse.make(impact)

const toAssetExceptionDecisionHistoryResponse = (decision: AssetExceptionDecisionHistory) =>
  AssetExceptionDecisionHistoryResponse.make({
    ...decision,
    evidenceSnapshotIds: [...decision.evidenceSnapshotIds],
    createdAt: toDateTimeUtc(decision.createdAt),
  })

const toAssetExceptionRematerializationResponse = (
  rematerialization: AssetExceptionRematerializationSummary
) =>
  AssetExceptionRematerializationResponse.make({
    ...rematerialization,
    lastFailureAt:
      rematerialization.lastFailureAt === null
        ? null
        : toDateTimeUtc(rematerialization.lastFailureAt),
  })

const toAssetExceptionListRowResponse = (row: AssetExceptionListRow) =>
  AssetExceptionListRowResponse.make({
    ...row,
    oldestAt: toDateTimeUtc(row.oldestAt),
  })

const toAssetExceptionDetailResponse = (detail: AssetExceptionDetail) =>
  AssetExceptionDetailResponse.make({
    providerAssetRowId: detail.providerAssetRowId,
    provider: detail.provider,
    providerAssetId: detail.providerAssetId,
    naturalKey: detail.naturalKey,
    currencyCode: detail.currencyCode,
    name: detail.name,
    exponent: detail.exponent,
    providerType: detail.providerType,
    rawProviderPayload: detail.rawProviderPayload,
    evidenceRevision: detail.evidenceRevision,
    policyRevision: detail.policyRevision,
    activeDecisionRevision: detail.activeDecisionRevision,
    reviewStatus: detail.reviewStatus,
    policyOutput: detail.policyOutput,
    activeDecision:
      detail.activeDecision === null
        ? null
        : toAssetExceptionDecisionHistoryResponse(detail.activeDecision),
    decisionHistory: detail.decisionHistory.map(toAssetExceptionDecisionHistoryResponse),
    evidence: detail.evidence.map((evidence) =>
      AssetExceptionEvidenceResponse.make({
        ...evidence,
        retrievedAt: toDateTimeUtc(evidence.retrievedAt),
      })
    ),
    impact: toAssetExceptionImpactResponse(detail.impact),
    rematerialization: toAssetExceptionRematerializationResponse(detail.rematerialization),
  })

const staleRevisionError = ({
  evidenceRevision,
  activeDecisionRevision,
}: {
  readonly evidenceRevision: number
  readonly activeDecisionRevision: string
}) =>
  new AssetStaleRevisionError({
    code: "stale_revision",
    evidenceRevision,
    activeDecisionRevision,
  })

const mapDecisionResultError = (
  result:
    | { readonly _tag: "not_found" }
    | {
        readonly _tag: "stale_revision"
        readonly evidenceRevision: number
        readonly activeDecisionRevision: string
      }
    | { readonly _tag: "ambiguous_identity" }
    | { readonly _tag: "identity_changed" }
    | { readonly _tag: "invalid_evidence" }
    | { readonly _tag: "invalid_claim" }
) => {
  switch (result._tag) {
    case "not_found":
      return new AssetNotFoundError({ message: "Asset observation not found." })
    case "stale_revision":
      return staleRevisionError(result)
    case "ambiguous_identity":
      return new AssetDecisionConflictError({
        code: "ambiguous_identity",
      })
    case "identity_changed":
      return new AssetDecisionConflictError({
        code: "identity_changed",
      })
    case "invalid_evidence":
      return new AssetDecisionValidationError({
        code: "invalid_evidence",
      })
    case "invalid_claim":
      return new AssetDecisionValidationError({
        code: "invalid_claim",
      })
  }
}

export const AssetsApiLive = HttpApiBuilder.group(TaxMaxiApi, "assets", (handlers) =>
  Effect.gen(function* () {
    const assetCatalogRepository = yield* AssetCatalogRepository
    const assetExceptionRepository = yield* AssetExceptionRepository
    const providerAssetRepository = yield* ProviderAssetRepository
    const transferReconciliationRepository = yield* TransferReconciliationRepository
    const assetCanonicalizationService = yield* AssetCanonicalizationService

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
      .handle("listAssetExceptions", ({ query: urlParams }) =>
        Effect.gen(function* () {
          const limit = urlParams.limit ?? defaultLimit
          const cursor = yield* decodeAssetExceptionCursor(urlParams.cursor)
          const exceptions = yield* assetExceptionRepository
            .listExceptions({ cursor, limit: limit + 1 })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list asset exceptions.")))
          const visibleExceptions = exceptions.slice(0, limit)
          const lastException = visibleExceptions.at(-1)
          const hasMore = exceptions.length > limit

          return AssetExceptionListResponse.make({
            exceptions: visibleExceptions.map(toAssetExceptionListRowResponse),
            page: {
              nextCursor:
                hasMore && lastException !== undefined
                  ? assetExceptionCursorFor(lastException)
                  : null,
              hasMore,
            },
          })
        })
      )
      .handle("lookupAssetException", ({ query: urlParams }) =>
        Effect.gen(function* () {
          const lookup = (() => {
            if (urlParams.providerAssetId !== undefined && urlParams.naturalKey === undefined) {
              return {
                _tag: "provider_asset_id" as const,
                provider: urlParams.provider,
                providerAssetId: urlParams.providerAssetId,
              }
            }
            if (urlParams.naturalKey !== undefined && urlParams.providerAssetId === undefined) {
              return {
                _tag: "natural_key" as const,
                provider: urlParams.provider,
                naturalKey: urlParams.naturalKey,
              }
            }
            return null
          })()
          if (lookup === null) {
            return yield* new AssetBadRequestError({
              message: "Provide exactly one of providerAssetId or naturalKey.",
            })
          }

          const detail = yield* assetExceptionRepository
            .findDetail(lookup)
            .pipe(
              Effect.mapError(() => toInternalServerError("Failed to look up asset observation."))
            )
          return yield* Option.match(detail, {
            onNone: () =>
              Effect.fail(new AssetNotFoundError({ message: "Asset observation not found." })),
            onSome: (value) => Effect.succeed(toAssetExceptionDetailResponse(value)),
          })
        })
      )
      .handle("getAssetException", ({ params: path }) =>
        Effect.gen(function* () {
          const detail = yield* assetExceptionRepository
            .findDetail({ _tag: "row_id", providerAssetRowId: path.id })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to load asset exception.")))
          return yield* Option.match(detail, {
            onNone: () =>
              Effect.fail(new AssetNotFoundError({ message: "Asset observation not found." })),
            onSome: (value) => Effect.succeed(toAssetExceptionDetailResponse(value)),
          })
        })
      )
      .handle("previewAssetExceptionDecision", ({ params: path, payload }) =>
        assetExceptionRepository
          .previewDecision({
            providerAssetRowId: path.id,
            claim: payload.claim,
            evidenceRevision: payload.evidenceRevision,
            activeDecisionRevision: payload.activeDecisionRevision,
            evidenceSnapshotIds: payload.evidenceSnapshotIds,
            rationale: payload.rationale,
          })
          .pipe(
            Effect.mapError(() => toInternalServerError("Failed to preview asset decision.")),
            Effect.flatMap((result) => {
              if (result._tag !== "ready") {
                return Effect.fail(mapDecisionResultError(result))
              }
              return Effect.succeed(
                AssetExceptionPreviewResponse.make({
                  ...result.preview,
                  supersededDecision:
                    result.preview.supersededDecision === null
                      ? null
                      : toAssetExceptionDecisionHistoryResponse(result.preview.supersededDecision),
                  impact: toAssetExceptionImpactResponse(result.preview.impact),
                })
              )
            })
          )
      )
      .handle("submitAssetExceptionDecision", ({ params: path, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const result = yield* assetExceptionRepository
            .submitDecision({
              input: {
                providerAssetRowId: path.id,
                claim: payload.claim,
                evidenceRevision: payload.evidenceRevision,
                activeDecisionRevision: payload.activeDecisionRevision,
                evidenceSnapshotIds: payload.evidenceSnapshotIds,
                rationale: payload.rationale,
                expectedResultingAssetId: payload.expectedResultingAssetId,
                expectedAssetOutcome: payload.expectedAssetOutcome,
                expectedRepresentationOutcome: payload.expectedRepresentationOutcome,
              },
              actorId: currentUser.userId,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to accept asset decision.")))
          if (result._tag !== "accepted") {
            return yield* mapDecisionResultError(result)
          }
          return toAssetExceptionDetailResponse(result.detail)
        })
      )
      .handle("listProviderAssetReviews", ({ query: urlParams }) =>
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
      .handle("canonicalizeProviderAsset", ({ params: path, payload }) =>
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
      .handle("approveProviderAsset", ({ params: path, payload }) =>
        assetCanonicalizationService
          .approveProviderAssetMapping({
            providerAssetRowId: path.id,
            canonicalAssetId: payload.canonicalAssetId,
            assetRepresentationId: payload.assetRepresentationId,
            reviewerNotes: payload.reviewerNotes ?? null,
          })
          .pipe(
            Effect.map(toProviderAssetReviewRow),
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
      )
  })
)
