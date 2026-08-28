/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import {
  AssetExceptionClaim,
  AssetExceptionReason,
  AssetExceptionRematerializationStatus,
  AssetExceptionSeverity,
  ProviderAssetMappingStatus,
} from "@my/core/assets"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

export class AssetBadRequestError extends Schema.TaggedError<AssetBadRequestError>()(
  "AssetBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {}

export class AssetNotFoundError extends Schema.TaggedError<AssetNotFoundError>()(
  "AssetNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class AssetLookupValidationError extends Schema.TaggedError<AssetLookupValidationError>()(
  "AssetLookupValidationError",
  {
    code: Schema.Literal("invalid_lookup"),
  },
  { httpApiStatus: 400 }
) {}

export class AssetLookupNotFoundError extends Schema.TaggedError<AssetLookupNotFoundError>()(
  "AssetLookupNotFoundError",
  {
    code: Schema.Literal("observation_not_found"),
  },
  { httpApiStatus: 404 }
) {}

export class AssetStaleRevisionError extends Schema.TaggedError<AssetStaleRevisionError>()(
  "AssetStaleRevisionError",
  {
    code: Schema.Literal("stale_revision"),
    evidenceRevision: Schema.Number,
    currentConclusionRevision: Schema.String,
    currentPolicyEvaluationRevision: Schema.String,
  },
  { httpApiStatus: 409 }
) {}

export class AssetDecisionConflictError extends Schema.TaggedError<AssetDecisionConflictError>()(
  "AssetDecisionConflictError",
  {
    code: Schema.Literals(["ambiguous_identity", "identity_changed"]),
  },
  { httpApiStatus: 409 }
) {}

export class AssetDecisionValidationError extends Schema.TaggedError<AssetDecisionValidationError>()(
  "AssetDecisionValidationError",
  {
    code: Schema.Literals(["invalid_evidence", "invalid_claim"]),
  },
  { httpApiStatus: 400 }
) {}

export class AssetExceptionImpactResponse extends Schema.Class<AssetExceptionImpactResponse>(
  "AssetExceptionImpactResponse"
)({
  blockedReports: Schema.Number,
  affectedPrincipals: Schema.Number,
  affectedTransactions: Schema.Number,
  affectedSources: Schema.Number,
  affectedCalculations: Schema.Number,
  existingGeneratedReportSnapshots: Schema.Number,
  affectedTransactionValueEur: Schema.NullOr(Schema.String),
}) {}

export class AssetExceptionListRowResponse extends Schema.Class<AssetExceptionListRowResponse>(
  "AssetExceptionListRowResponse"
)({
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  naturalKey: Schema.NullOr(Schema.String),
  currencyCode: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerType: Schema.NullOr(Schema.String),
  reason: AssetExceptionReason,
  severity: AssetExceptionSeverity,
  evidenceRevision: Schema.Number,
  policyRevision: Schema.String,
  currentConclusionRevision: Schema.String,
  currentPolicyEvaluationRevision: Schema.String,
  blockedReports: Schema.Number,
  affectedPrincipals: Schema.Number,
  affectedTransactions: Schema.Number,
  affectedSources: Schema.Number,
  affectedCalculations: Schema.Number,
  existingGeneratedReportSnapshots: Schema.Number,
  affectedTransactionValueEur: Schema.NullOr(Schema.String),
  oldestAt: Schema.DateTimeUtcFromString,
}) {}

export class AssetExceptionListResponse extends Schema.Class<AssetExceptionListResponse>(
  "AssetExceptionListResponse"
)({
  exceptions: Schema.Array(AssetExceptionListRowResponse),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class AssetExceptionEvidenceResponse extends Schema.Class<AssetExceptionEvidenceResponse>(
  "AssetExceptionEvidenceResponse"
)({
  id: Schema.String.check(Schema.isUUID()),
  authority: Schema.String,
  claimKind: Schema.String,
  sourceLocator: Schema.NullOr(Schema.String),
  retrievedAt: Schema.DateTimeUtcFromString,
  evidenceRevision: Schema.Number,
  decodedClaim: Schema.Unknown,
  rawPayload: Schema.Unknown,
}) {}

export class AssetExceptionDecisionHistoryResponse extends Schema.Class<AssetExceptionDecisionHistoryResponse>(
  "AssetExceptionDecisionHistoryResponse"
)({
  id: Schema.String.check(Schema.isUUID()),
  supersedesConclusionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  isCurrentConclusion: Schema.Boolean,
  isCurrentPolicyEvaluation: Schema.Boolean,
  outcome: Schema.Literals([
    "attach",
    "create_standalone",
    "identity",
    "excluded",
    "pending",
    "fail_closed",
  ]),
  claim: Schema.NullOr(AssetExceptionClaim),
  rationale: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  assetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  assetRepresentationId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  actorId: Schema.String,
  policyRevision: Schema.String,
  evidenceRevision: Schema.Number,
  evidenceSnapshotIds: Schema.Array(Schema.String.check(Schema.isUUID())),
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export class AssetExceptionRematerializationResponse extends Schema.Class<AssetExceptionRematerializationResponse>(
  "AssetExceptionRematerializationResponse"
)({
  status: AssetExceptionRematerializationStatus,
  affectedSourceCount: Schema.Number,
  pendingSourceCount: Schema.Number,
  runningSourceCount: Schema.Number,
  completedSourceCount: Schema.Number,
  failedSourceCount: Schema.Number,
  retryingSourceCount: Schema.Number,
  remainingSourceCount: Schema.Number,
  lastFailureAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  failureCode: Schema.NullOr(Schema.String),
}) {}

export class AssetExceptionDetailResponse extends Schema.Class<AssetExceptionDetailResponse>(
  "AssetExceptionDetailResponse"
)({
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  naturalKey: Schema.NullOr(Schema.String),
  currencyCode: Schema.String,
  name: Schema.NullOr(Schema.String),
  exponent: Schema.NullOr(Schema.Number),
  providerType: Schema.NullOr(Schema.String),
  rawProviderPayload: Schema.Unknown,
  evidenceRevision: Schema.Number,
  currentConclusionRevision: Schema.String,
  currentPolicyEvaluationRevision: Schema.String,
  reviewStatus: Schema.Literals(["unresolved", "approved", "excluded"]),
  currentConclusion: Schema.NullOr(AssetExceptionDecisionHistoryResponse),
  currentPolicyEvaluation: Schema.NullOr(AssetExceptionDecisionHistoryResponse),
  decisionHistory: Schema.Array(AssetExceptionDecisionHistoryResponse),
  evidence: Schema.Array(AssetExceptionEvidenceResponse),
  impact: AssetExceptionImpactResponse,
  rematerialization: AssetExceptionRematerializationResponse,
}) {}

export class AssetExceptionPreviewResponse extends Schema.Class<AssetExceptionPreviewResponse>(
  "AssetExceptionPreviewResponse"
)({
  claim: AssetExceptionClaim,
  decisionAction: Schema.Literals(["initial", "supersession", "reversal"]),
  resultingAssetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  assetOutcome: Schema.Literals(["none", "reuse", "create"]),
  representationOutcome: Schema.Literals(["none", "reuse", "create", "reassign"]),
  supersededConclusion: Schema.NullOr(AssetExceptionDecisionHistoryResponse),
  impact: AssetExceptionImpactResponse,
  rematerializationSourceCount: Schema.Number,
  evidenceRevision: Schema.Number,
  currentConclusionRevision: Schema.String,
  currentPolicyEvaluationRevision: Schema.String,
  affectedObservationRevisions: Schema.Array(
    Schema.Struct({
      providerAssetRowId: Schema.String.check(Schema.isUUID()),
      evidenceRevision: Schema.Number,
      currentConclusionRevision: Schema.String,
      currentPolicyEvaluationRevision: Schema.String,
    })
  ),
}) {}

/** Maximum accepted length for public asset catalog search queries. */
export const ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH = 128

const AssetCatalogSearchQuery = Schema.String.check(
  Schema.isMaxLength(ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH)
)

export class ProviderAssetReviewRow extends Schema.Class<ProviderAssetReviewRow>(
  "ProviderAssetReviewRow"
)({
  id: Schema.String,
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  naturalKey: Schema.NullOr(Schema.String),
  currencyCode: Schema.String,
  name: Schema.NullOr(Schema.String),
  exponent: Schema.NullOr(Schema.Number),
  providerType: Schema.NullOr(Schema.String),
  mappingKind: Schema.NullOr(Schema.Literals(["asset", "fiat"])),
  canonicalAssetId: Schema.NullOr(Schema.String),
  assetRepresentationId: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: Schema.NullOr(ProviderAssetMappingStatus),
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
}) {}

export class ProviderAssetReviewListResponse extends Schema.Class<ProviderAssetReviewListResponse>(
  "ProviderAssetReviewListResponse"
)({
  providerAssets: Schema.Array(ProviderAssetReviewRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class UnresolvedTransferReconciliationRow extends Schema.Class<UnresolvedTransferReconciliationRow>(
  "UnresolvedTransferReconciliationRow"
)({
  id: Schema.String.check(Schema.isUUID()),
  principalId: Schema.String.check(Schema.isUUID()),
  providerTransferId: Schema.String.check(Schema.isUUID()),
  providerSourceId: Schema.String.check(Schema.isUUID()),
  providerTimestamp: Schema.String,
  providerDirection: Schema.Literals(["inbound", "outbound"]),
  providerAmount: Schema.String,
  networkName: Schema.NullOr(Schema.String),
  networkHash: Schema.NullOr(Schema.String),
  canonicalTransferId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  canonicalTransactionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  status: Schema.Literals(["pending", "needs_review"]),
  matchReason: Schema.String,
  confidence: Schema.String,
  deterministic: Schema.Boolean,
  reviewMetadata: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class UnresolvedTransferReconciliationListResponse extends Schema.Class<UnresolvedTransferReconciliationListResponse>(
  "UnresolvedTransferReconciliationListResponse"
)({
  reconciliations: Schema.Array(UnresolvedTransferReconciliationRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class PendingAssetResponse extends Schema.Class<PendingAssetResponse>(
  "PendingAssetResponse"
)({
  id: Schema.String,
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  symbol: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerType: Schema.NullOr(Schema.String),
}) {}

export class PendingAssetListResponse extends Schema.Class<PendingAssetListResponse>(
  "PendingAssetListResponse"
)({
  pendingAssets: Schema.Array(PendingAssetResponse),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class AssetRepresentationResponse extends Schema.Class<AssetRepresentationResponse>(
  "AssetRepresentationResponse"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  blockchainChainType: Schema.String,
  blockchainChainId: Schema.NullOr(Schema.Number),
  blockchainExplorerUrl: Schema.NullOr(Schema.String),
  blockchainLogoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literals(["native", "token", "nft"]),
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  decimals: Schema.Number,
  logoUrl: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
}) {}

export class AssetCatalogAssetResponse extends Schema.Class<AssetCatalogAssetResponse>(
  "AssetCatalogAssetResponse"
)({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  coingeckoCoinId: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literals(["fungible", "nft"]),
  representations: Schema.Array(AssetRepresentationResponse),
}) {}

export class AssetCatalogListResponse extends Schema.Class<AssetCatalogListResponse>(
  "AssetCatalogListResponse"
)({
  assets: Schema.Array(AssetCatalogAssetResponse),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class AssetCanonicalizationRequest extends Schema.Class<AssetCanonicalizationRequest>(
  "AssetCanonicalizationRequest"
)({
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class ProviderAssetApprovalRequest extends Schema.Class<ProviderAssetApprovalRequest>(
  "ProviderAssetApprovalRequest"
)({
  canonicalAssetId: Schema.String.check(Schema.isUUID()),
  assetRepresentationId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class CanonicalAssetResponse extends Schema.Class<CanonicalAssetResponse>(
  "CanonicalAssetResponse"
)({
  id: Schema.String,
  representationId: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  type: Schema.Literals(["fungible", "nft"]),
  decimals: Schema.Number,
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  representationType: Schema.Literals(["native", "token", "nft"]),
}) {}

export class AssetCanonicalizationEvidenceResponse extends Schema.Class<AssetCanonicalizationEvidenceResponse>(
  "AssetCanonicalizationEvidenceResponse"
)({
  source: Schema.Literal("coingecko"),
  coinId: Schema.String,
  coinName: Schema.String,
  coinSymbol: Schema.String,
  platformId: Schema.String,
  platformName: Schema.String,
  contractAddress: Schema.NullOr(Schema.String),
}) {}

export class AssetCanonicalizationResponse extends Schema.Class<AssetCanonicalizationResponse>(
  "AssetCanonicalizationResponse"
)({
  providerAsset: ProviderAssetReviewRow,
  canonicalAsset: CanonicalAssetResponse,
  evidence: AssetCanonicalizationEvidenceResponse,
}) {}

const ProviderAssetReviewQuery = Schema.Struct({
  provider: Schema.optional(Schema.String),
  status: Schema.optional(ProviderAssetMappingStatus),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const UnresolvedTransferReconciliationQuery = Schema.Struct({
  status: Schema.optional(Schema.Literals(["pending", "needs_review"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const PendingAssetListQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  provider: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const AssetCatalogListQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(500)
    )
  ),
})

const AssetExceptionListQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const AssetExceptionLookupQuery = Schema.Struct({
  provider: Schema.String,
  providerAssetId: Schema.optional(Schema.String),
  naturalKey: Schema.optional(Schema.String),
})

export class AssetExceptionDecisionRequest extends Schema.Class<AssetExceptionDecisionRequest>(
  "AssetExceptionDecisionRequest"
)({
  claim: AssetExceptionClaim,
  evidenceRevision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  currentConclusionRevision: Schema.String,
  currentPolicyEvaluationRevision: Schema.String,
  evidenceSnapshotIds: Schema.Array(Schema.String.check(Schema.isUUID())),
  rationale: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
}) {}

export class AssetExceptionDecisionConfirmationRequest extends Schema.Class<AssetExceptionDecisionConfirmationRequest>(
  "AssetExceptionDecisionConfirmationRequest"
)({
  ...AssetExceptionDecisionRequest.fields,
  expectedResultingAssetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  expectedAssetOutcome: Schema.Literals(["none", "reuse", "create"]),
  expectedRepresentationOutcome: Schema.Literals(["none", "reuse", "create", "reassign"]),
  expectedAffectedObservationRevisions: Schema.Array(
    Schema.Struct({
      providerAssetRowId: Schema.String.check(Schema.isUUID()),
      evidenceRevision: Schema.Number,
      currentConclusionRevision: Schema.String,
      currentPolicyEvaluationRevision: Schema.String,
    })
  ),
}) {}

const listAssets = HttpApiEndpoint.get("listAssets", "/assets", {
  query: AssetCatalogListQuery,
  success: AssetCatalogListResponse,
  error: [AssetBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List canonical assets",
    description: "Lists non-spam canonical assets from the TaxMaxi asset registry.",
  })
)

const getAsset = HttpApiEndpoint.get("getAsset", "/assets/:assetId", {
  params: Schema.Struct({
    assetId: Schema.String.check(Schema.isUUID()),
  }),
  success: AssetCatalogAssetResponse,
  error: [AssetNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get canonical asset",
    description: "Returns one non-spam canonical asset from the TaxMaxi asset registry.",
  })
)

const listPendingAssets = HttpApiEndpoint.get("listPendingAssets", "/assets/pending", {
  query: PendingAssetListQuery,
  success: PendingAssetListResponse,
  error: [AssetBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List pending assets",
    description:
      "Lists provider assets waiting for TaxMaxi review without exposing internal review data.",
  })
)

const listProviderAssetReviews = HttpApiEndpoint.get(
  "listProviderAssetReviews",
  "/assets/provider-assets",
  {
    query: ProviderAssetReviewQuery,
    success: ProviderAssetReviewListResponse,
    error: [AssetBadRequestError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "List provider asset review rows",
      description: "Lists provider assets by mapping review status.",
    })
  )
  .middleware(AdminAuthMiddleware)

const listUnresolvedTransferReconciliations = HttpApiEndpoint.get(
  "listUnresolvedTransferReconciliations",
  "/assets/transfer-reconciliations/unresolved",
  {
    query: UnresolvedTransferReconciliationQuery,
    success: UnresolvedTransferReconciliationListResponse,
    error: [AssetBadRequestError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "List unresolved transfer reconciliation evidence",
      description:
        "Lists pending and ambiguous transfer matches for the narrow admin review queue.",
    })
  )
  .middleware(AdminAuthMiddleware)

const canonicalizeProviderAsset = HttpApiEndpoint.post(
  "canonicalizeProviderAsset",
  "/assets/provider-assets/:id/canonicalize",
  {
    params: Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
    }),
    payload: Schema.Struct(AssetCanonicalizationRequest.fields),
    success: AssetCanonicalizationResponse,
    error: [AssetBadRequestError, AssetNotFoundError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Canonicalize provider asset",
      description:
        "Creates or refreshes a canonical asset and approves the provider asset mapping.",
    })
  )
  .middleware(AdminAuthMiddleware)

const approveProviderAsset = HttpApiEndpoint.post(
  "approveProviderAsset",
  "/assets/provider-assets/:id/approve",
  {
    params: Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
    }),
    payload: Schema.Struct(ProviderAssetApprovalRequest.fields),
    success: ProviderAssetReviewRow,
    error: [AssetBadRequestError, AssetNotFoundError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Approve provider asset mapping",
      description:
        "Approves an exact provider-asset target and requests replay for affected sources.",
    })
  )
  .middleware(AdminAuthMiddleware)

const listAssetExceptions = HttpApiEndpoint.get("listAssetExceptions", "/assets/exceptions", {
  query: AssetExceptionListQuery,
  success: AssetExceptionListResponse,
  error: [AssetBadRequestError, InternalServerError],
})
  .annotateMerge(
    OpenApi.annotations({
      summary: "List actionable asset exceptions",
      description: "Lists completed deterministic domain exceptions in fixed impact order.",
    })
  )
  .middleware(AdminAuthMiddleware)

const lookupAssetException = HttpApiEndpoint.get(
  "lookupAssetException",
  "/assets/exceptions/lookup",
  {
    query: AssetExceptionLookupQuery,
    success: AssetExceptionDetailResponse,
    error: [AssetLookupValidationError, AssetLookupNotFoundError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Look up an asset observation",
      description:
        "Finds an unresolved, approved, or excluded observation by an exact provider key.",
    })
  )
  .middleware(AdminAuthMiddleware)

const getAssetException = HttpApiEndpoint.get("getAssetException", "/assets/exceptions/:id", {
  params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
  success: AssetExceptionDetailResponse,
  error: [AssetNotFoundError, InternalServerError],
})
  .annotateMerge(
    OpenApi.annotations({
      summary: "Get asset exception detail",
      description:
        "Returns persisted evidence, policy output, impact, and complete decision history.",
    })
  )
  .middleware(AdminAuthMiddleware)

const previewAssetExceptionDecision = HttpApiEndpoint.post(
  "previewAssetExceptionDecision",
  "/assets/exceptions/:id/preview",
  {
    params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
    payload: Schema.Struct(AssetExceptionDecisionRequest.fields),
    success: AssetExceptionPreviewResponse,
    error: [
      AssetNotFoundError,
      AssetStaleRevisionError,
      AssetDecisionConflictError,
      AssetDecisionValidationError,
      InternalServerError,
    ],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Preview an asset decision",
      description: "Derives the identity and rematerialization outcome without writing.",
    })
  )
  .middleware(AdminAuthMiddleware)

const submitAssetExceptionDecision = HttpApiEndpoint.post(
  "submitAssetExceptionDecision",
  "/assets/exceptions/:id/decisions",
  {
    params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
    payload: Schema.Struct(AssetExceptionDecisionConfirmationRequest.fields),
    success: AssetExceptionDetailResponse,
    error: [
      AssetNotFoundError,
      AssetStaleRevisionError,
      AssetDecisionConflictError,
      AssetDecisionValidationError,
      InternalServerError,
    ],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Accept an asset decision",
      description: "Appends a human decision and atomically schedules affected source rebuilds.",
    })
  )
  .middleware(AdminAuthMiddleware)

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listAssets)
  .add(getAsset)
  .add(listPendingAssets)
  .add(listAssetExceptions)
  .add(lookupAssetException)
  .add(getAssetException)
  .add(previewAssetExceptionDecision)
  .add(submitAssetExceptionDecision)
  .add(listProviderAssetReviews)
  .add(listUnresolvedTransferReconciliations)
  .add(approveProviderAsset)
  .add(canonicalizeProviderAsset)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
