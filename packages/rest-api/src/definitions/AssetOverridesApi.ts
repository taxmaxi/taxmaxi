/**
 * AssetOverridesApi - Principal-scoped asset override read endpoints.
 *
 * @module AssetOverridesApi
 */

import {
  PrincipalAssetEffectiveDecision,
  PrincipalAssetIdentity,
  PrincipalAssetInclusion,
  PrincipalAssetOverrideTarget,
  PrincipalAssetTechnicalBlocker,
  RepresentationType,
  ResolvedPrincipalAssetIdentity,
} from "@my/core/assets"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

const Uuid = Schema.String.check(Schema.isUUID())

const TargetQueryFields = {
  targetKind: Schema.Literals(["representation", "provider_asset"]),
  blockchain: Schema.optional(Schema.String),
  representationType: Schema.optional(RepresentationType),
  contractAddress: Schema.optional(Schema.String),
  mintAddress: Schema.optional(Schema.String),
  providerAssetRowId: Schema.optional(Schema.String),
}

/** Flat query representation of an exact or chainless override target. */
export const AssetOverrideTargetQuery = Schema.Struct(TargetQueryFields)

/** Query used to validate one identity replacement. */
export const AssetOverrideIdentityValidationQuery = Schema.Struct({
  ...TargetQueryFields,
  assetId: Uuid,
})

/** One recomputation state derivable before target-linked scheduling exists. */
export class AssetOverrideRecomputationResponse extends Schema.Class<AssetOverrideRecomputationResponse>(
  "AssetOverrideRecomputationResponse"
)({
  status: Schema.Literal("not_scheduled"),
}) {}

/** Machine-readable rejection of a target that cannot be canonicalized. */
export class AssetOverrideCanonicalTargetError extends Schema.TaggedError<AssetOverrideCanonicalTargetError>()(
  "AssetOverrideCanonicalTargetError",
  {
    code: Schema.Literal("invalid_canonical_target"),
    reason: Schema.Literals(["invalid_target_shape", "invalid_evm_address", "unknown_blockchain"]),
  },
  { httpApiStatus: 400 }
) {}

/** Missing and other-principal targets intentionally share this response. */
export class AssetOverrideTargetNotFoundError extends Schema.TaggedError<AssetOverrideTargetNotFoundError>()(
  "AssetOverrideTargetNotFoundError",
  { code: Schema.Literal("target_not_found") },
  { httpApiStatus: 404 }
) {}

/** One append-only identity or inclusion override record. */
export class AssetOverrideHistoryRecordResponse extends Schema.Class<AssetOverrideHistoryRecordResponse>(
  "AssetOverrideHistoryRecordResponse"
)({
  id: Uuid,
  kind: Schema.Literals(["identity", "inclusion"]),
  operation: Schema.Literals(["create", "replace", "withdraw"]),
  inspectedSystemRevision: Schema.String,
  inspectedSystemIdentity: Schema.NullOr(PrincipalAssetIdentity),
  inspectedSystemInclusion: Schema.NullOr(PrincipalAssetInclusion),
  replacementIdentity: Schema.NullOr(ResolvedPrincipalAssetIdentity),
  replacementInclusion: Schema.NullOr(PrincipalAssetInclusion),
  actorUserId: Uuid,
  reason: Schema.String,
  supersedesOverrideId: Schema.NullOr(Uuid),
  recordedAt: Schema.DateTimeUtcFromString,
}) {}

/** TaxMaxi's current identity and inclusion conclusions. */
export class AssetOverrideSystemResponse extends Schema.Class<AssetOverrideSystemResponse>(
  "AssetOverrideSystemResponse"
)({
  identity: PrincipalAssetIdentity,
  identityRevision: Schema.String,
  inclusion: PrincipalAssetInclusion,
  inclusionRevision: Schema.String,
}) {}

/** Current principal-scoped effective asset decision. */
export class AssetOverrideCurrentResponse extends Schema.Class<AssetOverrideCurrentResponse>(
  "AssetOverrideCurrentResponse"
)({
  target: PrincipalAssetOverrideTarget,
  system: AssetOverrideSystemResponse,
  activeIdentityOverride: Schema.NullOr(AssetOverrideHistoryRecordResponse),
  activeInclusionOverride: Schema.NullOr(AssetOverrideHistoryRecordResponse),
  effectiveDecision: PrincipalAssetEffectiveDecision,
  checkedTechnicalBlockerKinds: Schema.Array(PrincipalAssetTechnicalBlocker),
  technicalBlockers: Schema.Array(PrincipalAssetTechnicalBlocker),
  identityOverrideUsesStaleSystemRevision: Schema.Boolean,
  inclusionOverrideUsesStaleSystemRevision: Schema.Boolean,
  history: Schema.Array(AssetOverrideHistoryRecordResponse),
  recomputation: AssetOverrideRecomputationResponse,
}) {}

/** Full append-only history for one owned canonical target. */
export class AssetOverrideHistoryResponse extends Schema.Class<AssetOverrideHistoryResponse>(
  "AssetOverrideHistoryResponse"
)({
  target: PrincipalAssetOverrideTarget,
  history: Schema.Array(AssetOverrideHistoryRecordResponse),
  recomputation: AssetOverrideRecomputationResponse,
}) {}

/** Existing economic asset selected for an identity replacement. */
export class AssetOverrideSelectedAssetResponse extends Schema.Class<AssetOverrideSelectedAssetResponse>(
  "AssetOverrideSelectedAssetResponse"
)({
  id: Uuid,
  type: Schema.Literals(["fungible", "nft"]),
  name: Schema.String,
  symbol: Schema.String,
  marketDataId: Schema.NullOr(Schema.String),
}) {}

/** Non-blocking difference between the selected asset and stored evidence. */
export class AssetOverrideValidationWarningResponse extends Schema.Class<AssetOverrideValidationWarningResponse>(
  "AssetOverrideValidationWarningResponse"
)({
  code: Schema.Literals([
    "market_data_identity_mismatch",
    "name_mismatch",
    "symbol_mismatch",
    "system_confidence_conflict",
    "system_confidence_fail_closed",
    "system_confidence_pending",
    "system_identity_mismatch",
  ]),
  current: Schema.NullOr(Schema.String),
  selected: Schema.NullOr(Schema.String),
}) {}

const ValidationFacts = {
  checkedTechnicalBlockerKinds: Schema.Array(PrincipalAssetTechnicalBlocker),
  technicalBlockers: Schema.Array(PrincipalAssetTechnicalBlocker),
  recomputation: AssetOverrideRecomputationResponse,
}

/** Validation result when the selected economic asset does not exist. */
export class AssetOverrideAssetNotFoundValidationResponse extends Schema.TaggedClass<AssetOverrideAssetNotFoundValidationResponse>()(
  "asset_not_found",
  {
    assetId: Uuid,
    ...ValidationFacts,
  }
) {}

/** Validation result for a known fungible/NFT mismatch. */
export class AssetOverrideIncompatibleAssetTypeValidationResponse extends Schema.TaggedClass<AssetOverrideIncompatibleAssetTypeValidationResponse>()(
  "incompatible_asset_type",
  {
    asset: AssetOverrideSelectedAssetResponse,
    targetAssetType: Schema.Literals(["fungible", "nft"]),
    ...ValidationFacts,
  }
) {}

/** Validation result for an allowed identity replacement. */
export class AssetOverrideReadyValidationResponse extends Schema.TaggedClass<AssetOverrideReadyValidationResponse>()(
  "ready",
  {
    asset: AssetOverrideSelectedAssetResponse,
    projection: AssetOverrideCurrentResponse,
    warnings: Schema.Array(AssetOverrideValidationWarningResponse),
    ...ValidationFacts,
  }
) {}

/** Typed identity-replacement validation response. */
export const AssetOverrideIdentityValidationResponse = Schema.Union([
  AssetOverrideAssetNotFoundValidationResponse,
  AssetOverrideIncompatibleAssetTypeValidationResponse,
  AssetOverrideReadyValidationResponse,
])

const ReadErrors = [
  AssetOverrideCanonicalTargetError,
  AssetOverrideTargetNotFoundError,
  InternalServerError,
] as const

const getCurrent = HttpApiEndpoint.get("getAssetOverrideCurrent", "/current", {
  query: AssetOverrideTargetQuery,
  success: AssetOverrideCurrentResponse,
  error: ReadErrors,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Read the current principal asset override decision",
    description:
      "Returns TaxMaxi's current conclusion, the active principal override, the effective decision, blockers, stale state, history, and recomputation state for one owned target.",
  })
)

const getHistory = HttpApiEndpoint.get("getAssetOverrideHistory", "/history", {
  query: AssetOverrideTargetQuery,
  success: AssetOverrideHistoryResponse,
  error: ReadErrors,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Read principal asset override history",
    description: "Returns the append-only override history for one owned canonical target.",
  })
)

const validateIdentity = HttpApiEndpoint.get("validateAssetOverrideIdentity", "/validation", {
  query: AssetOverrideIdentityValidationQuery,
  success: AssetOverrideIdentityValidationResponse,
  error: ReadErrors,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Validate a principal asset identity replacement",
    description:
      "Checks an existing economic asset against one owned target and returns typed blockers and non-vetoing warnings.",
  })
)

/** Authenticated principal asset override read API. */
export class AssetOverridesApi extends HttpApiGroup.make("assetOverrides")
  .add(getCurrent)
  .add(getHistory)
  .add(validateIdentity)
  .middleware(AuthMiddleware)
  .prefix("/v1/asset-overrides")
  .annotateMerge(
    OpenApi.annotations({
      title: "Principal Asset Overrides",
      description: "Principal-scoped current, history, and validation reads.",
    })
  ) {}
