/**
 * AssetOverridesApiLive - Principal-scoped asset override read handlers.
 *
 * @module AssetOverridesApiLive
 */

import { PrincipalAssetOverrideTarget } from "@my/core/assets"
import {
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideHistoryRecord,
  type PrincipalAssetOverrideProjection,
  type PrincipalAssetOverrideReadError,
  type PrincipalAssetIdentityOverrideValidation,
} from "@my/persistence/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  AssetOverrideAssetNotFoundValidationResponse,
  AssetOverrideCanonicalTargetError,
  AssetOverrideCurrentResponse,
  AssetOverrideHistoryRecordResponse,
  AssetOverrideHistoryResponse,
  AssetOverrideIncompatibleAssetTypeValidationResponse,
  AssetOverrideReadyValidationResponse,
  AssetOverrideRecomputationResponse,
  AssetOverrideSelectedAssetResponse,
  AssetOverrideSystemResponse,
  AssetOverrideTargetNotFoundError,
  AssetOverrideValidationWarningResponse,
  type AssetOverrideTargetQuery,
} from "../definitions/AssetOverridesApi.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const recomputation = AssetOverrideRecomputationResponse.make({ status: "not_scheduled" })

const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const canonicalTargetError = (
  reason: "invalid_target_shape" | "invalid_evm_address" | "unknown_blockchain"
) =>
  new AssetOverrideCanonicalTargetError({
    code: "invalid_canonical_target",
    reason,
  })

const targetNotFound = () => new AssetOverrideTargetNotFoundError({ code: "target_not_found" })

const decodeTarget = (
  query: typeof AssetOverrideTargetQuery.Type
): Effect.Effect<PrincipalAssetOverrideTarget, AssetOverrideCanonicalTargetError> => {
  if (query.targetKind === "provider_asset") {
    if (
      query.blockchain !== undefined ||
      query.representationType !== undefined ||
      query.contractAddress !== undefined ||
      query.mintAddress !== undefined
    ) {
      return Effect.fail(canonicalTargetError("invalid_target_shape"))
    }

    return Schema.decodeUnknownEffect(PrincipalAssetOverrideTarget)({
      _tag: "provider_asset",
      providerAssetRowId: query.providerAssetRowId,
    }).pipe(Effect.mapError(() => canonicalTargetError("invalid_target_shape")))
  }

  if (query.providerAssetRowId !== undefined) {
    return Effect.fail(canonicalTargetError("invalid_target_shape"))
  }

  return Schema.decodeUnknownEffect(PrincipalAssetOverrideTarget)({
    _tag: "representation",
    blockchain: query.blockchain,
    type: query.representationType,
    contractAddress: query.contractAddress ?? null,
    mintAddress: query.mintAddress ?? null,
  }).pipe(Effect.mapError(() => canonicalTargetError("invalid_target_shape")))
}

const mapReadError = (
  error: PrincipalAssetOverrideReadError
): AssetOverrideCanonicalTargetError | InternalServerError =>
  error._tag === "PrincipalAssetOverrideInvalidTargetError"
    ? canonicalTargetError(error.reason)
    : internalError("Failed to read the principal asset override.")

const toHistoryRecord = (
  record: PrincipalAssetOverrideHistoryRecord
): AssetOverrideHistoryRecordResponse =>
  AssetOverrideHistoryRecordResponse.make({
    ...record,
    recordedAt: DateTime.makeUnsafe(record.recordedAt),
  })

const toSelectedAsset = (
  asset: Extract<PrincipalAssetIdentityOverrideValidation, { readonly _tag: "ready" }>["asset"]
): AssetOverrideSelectedAssetResponse => AssetOverrideSelectedAssetResponse.make(asset)

const toCurrentResponse = (
  projection: PrincipalAssetOverrideProjection
): AssetOverrideCurrentResponse =>
  AssetOverrideCurrentResponse.make({
    target: projection.target,
    system: AssetOverrideSystemResponse.make(projection.system),
    activeIdentityOverride:
      projection.activeIdentityOverride === null
        ? null
        : toHistoryRecord(projection.activeIdentityOverride),
    activeInclusionOverride:
      projection.activeInclusionOverride === null
        ? null
        : toHistoryRecord(projection.activeInclusionOverride),
    effectiveDecision: projection.effectiveDecision,
    checkedTechnicalBlockerKinds: projection.checkedTechnicalBlockerKinds,
    technicalBlockers: projection.technicalBlockers,
    identityOverrideUsesStaleSystemRevision: projection.identityOverrideUsesStaleSystemRevision,
    inclusionOverrideUsesStaleSystemRevision: projection.inclusionOverrideUsesStaleSystemRevision,
    history: projection.history.map(toHistoryRecord),
    recomputation,
  })

const toValidationResponse = (validation: PrincipalAssetIdentityOverrideValidation) => {
  switch (validation._tag) {
    case "asset_not_found":
      return AssetOverrideAssetNotFoundValidationResponse.make({
        assetId: validation.assetId,
        checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
        technicalBlockers: validation.technicalBlockers,
        recomputation,
      })
    case "incompatible_asset_type":
      return AssetOverrideIncompatibleAssetTypeValidationResponse.make({
        asset: AssetOverrideSelectedAssetResponse.make(validation.asset),
        targetAssetType: validation.targetAssetType,
        checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
        technicalBlockers: validation.technicalBlockers,
        recomputation,
      })
    case "ready":
      return AssetOverrideReadyValidationResponse.make({
        asset: toSelectedAsset(validation.asset),
        projection: toCurrentResponse(validation.projection),
        checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
        technicalBlockers: validation.technicalBlockers,
        warnings: validation.warnings.map((warning) =>
          AssetOverrideValidationWarningResponse.make(warning)
        ),
        recomputation,
      })
  }
}

/** Live authenticated current, history, and validation handlers. */
export const AssetOverridesApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "assetOverrides",
  (handlers) =>
    Effect.gen(function* () {
      const repository = yield* PrincipalAssetOverrideRepository
      const principalResolution = yield* PrincipalResolutionService

      const resolvePrincipalId = principalResolution.resolveCurrentUserPrincipal.pipe(
        Effect.map(({ principal }) => principal.id),
        Effect.mapError(() => internalError("Failed to resolve the current user."))
      )

      const findOwnedProjection = (query: typeof AssetOverrideTargetQuery.Type) =>
        Effect.gen(function* () {
          const target = yield* decodeTarget(query)
          const principalId = yield* resolvePrincipalId
          const projection = yield* repository
            .findProjection({ principalId, target })
            .pipe(Effect.mapError(mapReadError))

          if (Option.isNone(projection)) return yield* targetNotFound()

          return projection.value
        })

      return handlers
        .handle("getAssetOverrideCurrent", ({ query }) =>
          Effect.gen(function* () {
            const projection = yield* findOwnedProjection(query)
            return toCurrentResponse(projection)
          })
        )
        .handle("getAssetOverrideHistory", ({ query }) =>
          Effect.gen(function* () {
            const projection = yield* findOwnedProjection(query)

            return AssetOverrideHistoryResponse.make({
              target: projection.target,
              history: projection.history.map(toHistoryRecord),
              recomputation,
            })
          })
        )
        .handle("validateAssetOverrideIdentity", ({ query }) =>
          Effect.gen(function* () {
            const target = yield* decodeTarget(query)
            const principalId = yield* resolvePrincipalId
            const validation = yield* repository
              .validateIdentityReplacement({
                assetId: query.assetId,
                principalId,
                target,
              })
              .pipe(Effect.mapError(mapReadError))

            if (Option.isNone(validation)) return yield* targetNotFound()

            return toValidationResponse(validation.value)
          })
        )
    })
)
