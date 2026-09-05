/**
 * AssetOverridesApi - Principal-scoped asset override REST endpoints.
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
const Reason = Schema.Trimmed.check(Schema.isNonEmpty())

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

/** No durable target-linked work exists for this override stream. */
export class AssetOverrideNotScheduledRecomputationResponse extends Schema.Class<AssetOverrideNotScheduledRecomputationResponse>(
  "AssetOverrideNotScheduledRecomputationResponse"
)({
  status: Schema.Literal("not_scheduled"),
}) {}

/** One durable source replay selected for an override record. */
export class AssetOverrideReplayJobResponse extends Schema.Class<AssetOverrideReplayJobResponse>(
  "AssetOverrideReplayJobResponse"
)({
  overrideId: Uuid,
  sourceId: Uuid,
  requestedJobId: Schema.NullOr(Uuid),
  jobId: Schema.NullOr(Uuid),
  status: Schema.Literals(["pending", "running", "complete", "failed", "credit_required"]),
  failureCode: Schema.NullOr(Schema.String),
}) {}

/** Calculation run whose factual snapshot covers the current override work. */
export class AssetOverrideCalculationRunResponse extends Schema.Class<AssetOverrideCalculationRunResponse>(
  "AssetOverrideCalculationRunResponse"
)({
  runId: Uuid,
  status: Schema.Literals(["running", "complete", "partial", "failed"]),
  failureCode: Schema.NullOr(Schema.String),
}) {}

/** Durable replay and calculation state for one scheduled override stream. */
export class AssetOverrideScheduledRecomputationResponse extends Schema.Class<AssetOverrideScheduledRecomputationResponse>(
  "AssetOverrideScheduledRecomputationResponse"
)({
  status: Schema.Literals(["updating", "complete", "partial", "failed"]),
  overrideIds: Schema.Array(Uuid),
  sourceJobs: Schema.Array(AssetOverrideReplayJobResponse),
  calculationRun: Schema.NullOr(AssetOverrideCalculationRunResponse),
}) {}

/** Current durable recomputation state for one override target. */
export const AssetOverrideRecomputationResponse = Schema.Union([
  AssetOverrideNotScheduledRecomputationResponse,
  AssetOverrideScheduledRecomputationResponse,
])

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

/** Readonly callers cannot append principal asset override history. */
export class AssetOverrideReadonlyError extends Schema.TaggedError<AssetOverrideReadonlyError>()(
  "AssetOverrideReadonlyError",
  { code: Schema.Literal("readonly_user") },
  { httpApiStatus: 403 }
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

const MutationCompareAndSetFields = {
  expectedActiveOverrideId: Uuid,
  expectedSystemRevision: Schema.String,
  reason: Reason,
}

const CreateMutationFields = {
  expectedSystemRevision: Schema.String,
  reason: Reason,
}

/** Create an identity override selecting an existing economic asset. */
export class AssetOverrideIdentityCreateRequest extends Schema.TaggedClass<AssetOverrideIdentityCreateRequest>()(
  "identity",
  {
    ...CreateMutationFields,
    assetId: Uuid,
  }
) {}

/** Create an inclusion override selecting included or excluded. */
export class AssetOverrideInclusionCreateRequest extends Schema.TaggedClass<AssetOverrideInclusionCreateRequest>()(
  "inclusion",
  {
    ...CreateMutationFields,
    inclusion: PrincipalAssetInclusion,
  }
) {}

/** Typed initial override payload; create expects no active override ID. */
export const AssetOverrideCreateRequest = Schema.Union([
  AssetOverrideIdentityCreateRequest,
  AssetOverrideInclusionCreateRequest,
])

/** Replace an active identity override with another existing economic asset. */
export class AssetOverrideIdentityReplaceRequest extends Schema.TaggedClass<AssetOverrideIdentityReplaceRequest>()(
  "identity",
  {
    ...MutationCompareAndSetFields,
    assetId: Uuid,
  }
) {}

/** Replace an active inclusion override. */
export class AssetOverrideInclusionReplaceRequest extends Schema.TaggedClass<AssetOverrideInclusionReplaceRequest>()(
  "inclusion",
  {
    ...MutationCompareAndSetFields,
    inclusion: PrincipalAssetInclusion,
  }
) {}

/** Typed replacement payload for one active override stream. */
export const AssetOverrideReplaceRequest = Schema.Union([
  AssetOverrideIdentityReplaceRequest,
  AssetOverrideInclusionReplaceRequest,
])

/** Withdraw one active override and return to TaxMaxi's current conclusion. */
export class AssetOverrideWithdrawRequest extends Schema.Class<AssetOverrideWithdrawRequest>(
  "AssetOverrideWithdrawRequest"
)({
  ...MutationCompareAndSetFields,
  kind: Schema.Literals(["identity", "inclusion"]),
}) {}

/** A compare-and-set value changed before the mutation acquired its lock. */
export class AssetOverrideMutationConflictError extends Schema.TaggedError<AssetOverrideMutationConflictError>()(
  "AssetOverrideMutationConflictError",
  {
    code: Schema.Literal("override_conflict"),
    conflictKinds: Schema.Array(Schema.Literals(["active_override", "system_revision"])),
    currentProjection: AssetOverrideCurrentResponse,
    currentActiveOverrideId: Schema.NullOr(Uuid),
    currentSystemRevision: Schema.String,
    expectedActiveOverrideId: Schema.NullOr(Uuid),
    expectedSystemRevision: Schema.String,
  },
  { httpApiStatus: 409 }
) {}

/** An identity replacement does not select a compatible existing asset. */
export class AssetOverrideReplacementValidationError extends Schema.TaggedError<AssetOverrideReplacementValidationError>()(
  "AssetOverrideReplacementValidationError",
  {
    code: Schema.Literal("invalid_replacement"),
    validation: Schema.Union([
      AssetOverrideAssetNotFoundValidationResponse,
      AssetOverrideIncompatibleAssetTypeValidationResponse,
    ]),
    currentProjection: AssetOverrideCurrentResponse,
  },
  { httpApiStatus: 422 }
) {}

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

const MutationErrors = [
  AssetOverrideCanonicalTargetError,
  AssetOverrideTargetNotFoundError,
  AssetOverrideMutationConflictError,
  AssetOverrideReadonlyError,
  InternalServerError,
] as const

const create = HttpApiEndpoint.post("createAssetOverride", "/create", {
  query: AssetOverrideTargetQuery,
  payload: AssetOverrideCreateRequest,
  success: AssetOverrideCurrentResponse,
  error: [
    AssetOverrideCanonicalTargetError,
    AssetOverrideTargetNotFoundError,
    AssetOverrideMutationConflictError,
    AssetOverrideReplacementValidationError,
    AssetOverrideReadonlyError,
    InternalServerError,
  ],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Create a principal asset override",
    description:
      "Appends an initial identity or inclusion override after checking TaxMaxi's revision, schedules durable source replay work, and returns the updating projection.",
  })
)

const replace = HttpApiEndpoint.post("replaceAssetOverride", "/replace", {
  query: AssetOverrideTargetQuery,
  payload: AssetOverrideReplaceRequest,
  success: AssetOverrideCurrentResponse,
  error: [
    AssetOverrideCanonicalTargetError,
    AssetOverrideTargetNotFoundError,
    AssetOverrideMutationConflictError,
    AssetOverrideReplacementValidationError,
    AssetOverrideReadonlyError,
    InternalServerError,
  ],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Replace a principal asset override",
    description:
      "Appends a replacement after checking the expected active override and TaxMaxi revision. Returns the current projection on conflict.",
  })
)

const withdraw = HttpApiEndpoint.post("withdrawAssetOverride", "/withdraw", {
  query: AssetOverrideTargetQuery,
  payload: AssetOverrideWithdrawRequest,
  success: AssetOverrideCurrentResponse,
  error: MutationErrors,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Withdraw a principal asset override",
    description:
      "Appends a withdrawal after checking the expected active override and TaxMaxi revision. Returns to TaxMaxi's current conclusion.",
  })
)

/** Authenticated principal asset override REST API. */
export class AssetOverridesApi extends HttpApiGroup.make("assetOverrides")
  .add(getCurrent)
  .add(getHistory)
  .add(validateIdentity)
  .add(create)
  .add(replace)
  .add(withdraw)
  .middleware(AuthMiddleware)
  .prefix("/v1/asset-overrides")
  .annotateMerge(
    OpenApi.annotations({
      title: "Principal Asset Overrides",
      description:
        "Principal-scoped current, history, validation, creation, replacement, and withdrawal operations.",
    })
  ) {}
