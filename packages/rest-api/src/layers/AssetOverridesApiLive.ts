/**
 * AssetOverridesApiLive - Authenticated principal asset override handlers.
 *
 * @module AssetOverridesApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  AssetOverrideRepository,
  AssetOverrideTargetNotFoundError,
  AssetOverrideValidationError,
  type AssetOverrideProjection,
  type AssetOverrideWriteResult,
} from "@my/persistence/services"
import type { PersistenceError } from "@my/persistence/errors"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  AssetOverrideBadRequestError,
  AssetOverrideConflictError,
  AssetOverrideHistoryResponse,
  AssetOverrideNotFoundError,
  AssetOverrideProjectionResponse,
  AssetOverrideValidationResponse,
} from "../definitions/AssetOverridesApi.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const internalError = () =>
  new InternalServerError({
    requestId: Option.none(),
    message: "Failed to process the asset override.",
  })

const toHistoryResponse = (entry: AssetOverrideProjection["history"][number]) =>
  AssetOverrideHistoryResponse.make({
    ...entry,
    createdAt: entry.createdAt.toISOString(),
  })

const toProjectionResponse = (projection: AssetOverrideProjection) =>
  AssetOverrideProjectionResponse.make({
    ...projection,
    activeOverride:
      projection.activeOverride === null ? null : toHistoryResponse(projection.activeOverride),
    history: projection.history.map(toHistoryResponse),
  })

const validationWarnings = ({
  projection,
  replacement,
}: {
  readonly projection: AssetOverrideProjection
  readonly replacement:
    | { readonly _tag: "identity"; readonly assetId: string }
    | { readonly _tag: "inclusion"; readonly state: "included" | "excluded" }
}) => {
  if (replacement._tag === "identity" && projection.systemConclusion._tag === "identity") {
    if (projection.systemConclusion.state === "unresolved") {
      return ["identity_not_system_verified" as const]
    }
    if (
      projection.systemConclusion.state === "resolved" &&
      projection.systemConclusion.assetId !== replacement.assetId
    ) {
      return ["identity_differs_from_system" as const]
    }
  }

  if (
    replacement._tag === "inclusion" &&
    projection.systemConclusion._tag === "inclusion" &&
    projection.systemConclusion.state !== "blocked" &&
    projection.systemConclusion.state !== replacement.state
  ) {
    return ["inclusion_differs_from_system" as const]
  }

  return []
}

const toTarget = (query: {
  readonly targetKind: "provider_asset" | "representation"
  readonly providerAssetRowId?: string | undefined
  readonly blockchainId?: string | undefined
  readonly representationType?: "native" | "token" | "nft" | undefined
  readonly contractAddress?: string | undefined
  readonly mintAddress?: string | undefined
}) => {
  if (query.targetKind === "provider_asset" && query.providerAssetRowId !== undefined) {
    return Effect.succeed({
      _tag: "provider_asset" as const,
      providerAssetRowId: query.providerAssetRowId,
    })
  }
  if (
    query.targetKind === "representation" &&
    query.blockchainId !== undefined &&
    query.representationType !== undefined
  ) {
    return Effect.succeed({
      _tag: "representation" as const,
      blockchainId: query.blockchainId,
      representationType: query.representationType,
      contractAddress: query.contractAddress ?? null,
      mintAddress: query.mintAddress ?? null,
    })
  }
  return Effect.fail(
    new AssetOverrideBadRequestError({
      code: "invalid_target",
      message: "Asset override target fields are incomplete.",
    })
  )
}

const mapRepositoryError = (
  error: AssetOverrideTargetNotFoundError | AssetOverrideValidationError | PersistenceError
) => {
  switch (error._tag) {
    case "AssetOverrideTargetNotFoundError":
      return new AssetOverrideNotFoundError({
        code: "asset_override_target_not_found",
        message: "Asset override target not found.",
      })
    case "AssetOverrideValidationError":
      return new AssetOverrideBadRequestError({
        code: error.code,
        message: error.message,
      })
    default:
      return internalError()
  }
}

export const AssetOverridesApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "assetOverrides",
  (handlers) =>
    Effect.gen(function* () {
      const repository = yield* AssetOverrideRepository
      const principalResolutionService = yield* PrincipalResolutionService

      const principalScope = Effect.map(
        principalResolutionService.resolveCurrentUserPrincipal,
        ({ principal }) => principal.id
      ).pipe(Effect.mapError(() => internalError()))

      const writeResult = (result: AssetOverrideWriteResult) =>
        result._tag === "accepted"
          ? Effect.succeed(toProjectionResponse(result.projection))
          : Effect.fail(
              new AssetOverrideConflictError({
                code: "asset_override_conflict",
                message: "The TaxMaxi conclusion or active override changed.",
                current: toProjectionResponse(result.projection),
              })
            )

      return handlers
        .handle("getCurrentAssetOverride", ({ query }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const target = yield* toTarget(query)
            const projection = yield* repository
              .getProjection({ principalId, kind: query.kind, target })
              .pipe(Effect.mapError(mapRepositoryError))
            return toProjectionResponse(projection)
          })
        )
        .handle("getAssetOverrideHistory", ({ query }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const target = yield* toTarget(query)
            const projection = yield* repository
              .getProjection({ principalId, kind: query.kind, target })
              .pipe(Effect.mapError(mapRepositoryError))
            return projection.history.map(toHistoryResponse)
          })
        )
        .handle("validateAssetOverride", ({ payload }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const projection = yield* repository
              .validateOverride({ principalId, ...payload })
              .pipe(Effect.mapError(mapRepositoryError))
            return AssetOverrideValidationResponse.make({
              valid: true,
              projection: toProjectionResponse(projection),
              warnings: validationWarnings({ projection, replacement: payload.replacement }),
            })
          })
        )
        .handle("createAssetOverride", ({ payload }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const currentUser = yield* CurrentUser
            const result = yield* repository
              .setOverride({
                principalId,
                actorId: currentUser.userId,
                ...payload,
                expectedActiveOverrideId: null,
              })
              .pipe(Effect.mapError(mapRepositoryError))
            return yield* writeResult(result)
          })
        )
        .handle("replaceAssetOverride", ({ params, payload }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const currentUser = yield* CurrentUser
            const result = yield* repository
              .setOverride({
                principalId,
                actorId: currentUser.userId,
                ...payload,
                expectedActiveOverrideId: params.overrideId,
              })
              .pipe(Effect.mapError(mapRepositoryError))
            return yield* writeResult(result)
          })
        )
        .handle("withdrawAssetOverride", ({ params, payload }) =>
          Effect.gen(function* () {
            const principalId = yield* principalScope
            const currentUser = yield* CurrentUser
            const result = yield* repository
              .withdrawOverride({
                principalId,
                actorId: currentUser.userId,
                ...payload,
                expectedActiveOverrideId: params.overrideId,
              })
              .pipe(Effect.mapError(mapRepositoryError))
            return yield* writeResult(result)
          })
        )
    })
)
