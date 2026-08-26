/**
 * AssetOverridesApi - Principal-scoped asset identity and inclusion overrides.
 *
 * @module AssetOverridesApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { AssetOverrideValidationErrorCode } from "@my/persistence/services"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export const AssetOverrideKindSchema = Schema.Literals(["identity", "inclusion"])

export const AssetOverrideTargetSchema = Schema.Union([
  Schema.TaggedStruct("provider_asset", {
    providerAssetRowId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("representation", {
    blockchainId: Schema.String.check(Schema.isUUID()),
    representationType: Schema.Literals(["native", "token", "nft"]),
    contractAddress: Schema.NullOr(Schema.String),
    mintAddress: Schema.NullOr(Schema.String),
  }),
])

export const AssetOverrideReplacementSchema = Schema.Union([
  Schema.TaggedStruct("identity", {
    assetId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("inclusion", {
    state: Schema.Literals(["included", "excluded"]),
  }),
])

export const AssetOverrideConclusionSchema = Schema.Union([
  Schema.TaggedStruct("identity", {
    state: Schema.Literals(["resolved", "unresolved", "excluded"]),
    assetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  }),
  Schema.TaggedStruct("inclusion", {
    state: Schema.Literals(["included", "excluded", "blocked"]),
    reason: Schema.NullOr(Schema.String),
  }),
])

export class AssetOverrideHistoryResponse extends Schema.Class<AssetOverrideHistoryResponse>(
  "AssetOverrideHistoryResponse"
)({
  id: Schema.String.check(Schema.isUUID()),
  kind: AssetOverrideKindSchema,
  target: AssetOverrideTargetSchema,
  action: Schema.Literals(["set", "withdraw"]),
  inspectedSystemRevision: Schema.String,
  inspectedSystemConclusion: AssetOverrideConclusionSchema,
  replacement: Schema.NullOr(AssetOverrideReplacementSchema),
  actorId: Schema.String.check(Schema.isUUID()),
  reason: Schema.String,
  supersedesOverrideId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  createdAt: Schema.String,
}) {}

export class AssetOverrideProjectionResponse extends Schema.Class<AssetOverrideProjectionResponse>(
  "AssetOverrideProjectionResponse"
)({
  kind: AssetOverrideKindSchema,
  target: AssetOverrideTargetSchema,
  systemRevision: Schema.String,
  systemConclusion: AssetOverrideConclusionSchema,
  activeOverride: Schema.NullOr(AssetOverrideHistoryResponse),
  effectiveConclusion: AssetOverrideConclusionSchema,
  staleSystemRevision: Schema.Boolean,
  history: Schema.Array(AssetOverrideHistoryResponse),
  recomputationState: Schema.Literals(["updating", "complete", "failed"]),
}) {}

export class AssetOverrideValidationResponse extends Schema.Class<AssetOverrideValidationResponse>(
  "AssetOverrideValidationResponse"
)({
  valid: Schema.Literal(true),
  projection: AssetOverrideProjectionResponse,
  warnings: Schema.Array(
    Schema.Literals([
      "identity_not_system_verified",
      "identity_differs_from_system",
      "inclusion_differs_from_system",
    ])
  ),
}) {}

export class AssetOverrideNotFoundError extends Schema.TaggedError<AssetOverrideNotFoundError>()(
  "AssetOverrideNotFoundError",
  {
    code: Schema.Literal("asset_override_target_not_found"),
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class AssetOverrideBadRequestError extends Schema.TaggedError<AssetOverrideBadRequestError>()(
  "AssetOverrideBadRequestError",
  {
    code: Schema.Union([Schema.Literal("invalid_target"), AssetOverrideValidationErrorCode]),
    message: Schema.String,
  },
  { httpApiStatus: 422 }
) {}

export class AssetOverrideConflictError extends Schema.TaggedError<AssetOverrideConflictError>()(
  "AssetOverrideConflictError",
  {
    code: Schema.Literal("asset_override_conflict"),
    message: Schema.String,
    current: AssetOverrideProjectionResponse,
  },
  { httpApiStatus: 409 }
) {}

const AssetOverrideTargetQuery = Schema.Struct({
  kind: AssetOverrideKindSchema,
  targetKind: Schema.Literals(["provider_asset", "representation"]),
  providerAssetRowId: Schema.optional(Schema.String.check(Schema.isUUID())),
  blockchainId: Schema.optional(Schema.String.check(Schema.isUUID())),
  representationType: Schema.optional(Schema.Literals(["native", "token", "nft"])),
  contractAddress: Schema.optional(Schema.String),
  mintAddress: Schema.optional(Schema.String),
})

const AssetOverrideBasePayload = Schema.Struct({
  kind: AssetOverrideKindSchema,
  target: AssetOverrideTargetSchema,
  expectedSystemRevision: Schema.String,
  reason: Schema.Trimmed.check(Schema.isNonEmpty()),
})

const AssetOverrideSetPayload = Schema.Struct({
  ...AssetOverrideBasePayload.fields,
  replacement: AssetOverrideReplacementSchema,
})

const current = HttpApiEndpoint.get("getCurrentAssetOverride", "/asset-overrides/current", {
  query: AssetOverrideTargetQuery,
  success: AssetOverrideProjectionResponse,
  error: [AssetOverrideBadRequestError, AssetOverrideNotFoundError, InternalServerError],
})

const history = HttpApiEndpoint.get("getAssetOverrideHistory", "/asset-overrides/history", {
  query: AssetOverrideTargetQuery,
  success: Schema.Array(AssetOverrideHistoryResponse),
  error: [AssetOverrideBadRequestError, AssetOverrideNotFoundError, InternalServerError],
})

const validate = HttpApiEndpoint.post("validateAssetOverride", "/asset-overrides/validate", {
  payload: Schema.Struct({
    kind: AssetOverrideKindSchema,
    target: AssetOverrideTargetSchema,
    replacement: AssetOverrideReplacementSchema,
  }),
  success: AssetOverrideValidationResponse,
  error: [AssetOverrideBadRequestError, AssetOverrideNotFoundError, InternalServerError],
})

const create = HttpApiEndpoint.post("createAssetOverride", "/asset-overrides", {
  payload: AssetOverrideSetPayload,
  success: AssetOverrideProjectionResponse,
  error: [
    AssetOverrideBadRequestError,
    AssetOverrideConflictError,
    AssetOverrideNotFoundError,
    InternalServerError,
  ],
})

const replace = HttpApiEndpoint.post(
  "replaceAssetOverride",
  "/asset-overrides/:overrideId/replacements",
  {
    params: Schema.Struct({ overrideId: Schema.String.check(Schema.isUUID()) }),
    payload: AssetOverrideSetPayload,
    success: AssetOverrideProjectionResponse,
    error: [
      AssetOverrideBadRequestError,
      AssetOverrideConflictError,
      AssetOverrideNotFoundError,
      InternalServerError,
    ],
  }
)

const withdraw = HttpApiEndpoint.post(
  "withdrawAssetOverride",
  "/asset-overrides/:overrideId/withdrawals",
  {
    params: Schema.Struct({ overrideId: Schema.String.check(Schema.isUUID()) }),
    payload: AssetOverrideBasePayload,
    success: AssetOverrideProjectionResponse,
    error: [
      AssetOverrideBadRequestError,
      AssetOverrideConflictError,
      AssetOverrideNotFoundError,
      InternalServerError,
    ],
  }
)

export class AssetOverridesApi extends HttpApiGroup.make("assetOverrides")
  .add(current)
  .add(history)
  .add(validate)
  .add(create)
  .add(replace)
  .add(withdraw)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Asset overrides",
      description: "Principal-scoped asset identity and calculation-inclusion choices",
    })
  ) {}
