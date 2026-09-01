import {
  AssetOverrideCanonicalTargetError,
  AssetOverrideCurrentResponse,
  AssetOverrideHistoryResponse,
  AssetOverrideIdentityValidationResponse,
  AssetOverrideMutationConflictError,
  AssetOverrideReadonlyError,
  AssetOverrideReplacementValidationError,
  AssetOverrideTargetNotFoundError,
  AssetOverrideReplaceRequest,
  AssetOverrideWithdrawRequest,
  TaxMaxiApi,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HttpApiClient } from "effect/unstable/httpapi"
import type { AssetRequestOptions } from "../assets/index.ts"

type TaxMaxiApiFullClient = HttpApiClient.ForApi<typeof TaxMaxiApi>

type TaxMaxiAssetOverridesClient = Pick<
  TaxMaxiApiFullClient,
  Extract<keyof TaxMaxiApiFullClient, "assetOverrides">
>

type AssetOverridesClient = TaxMaxiAssetOverridesClient["assetOverrides"]

/** Exact network representation or chainless provider-asset fallback. */
export type AssetOverrideTarget = AssetOverrideCurrent["target"]

/** Current effective override decision with blocker and recomputation details. */
export type AssetOverrideCurrent = Schema.Codec.Encoded<typeof AssetOverrideCurrentResponse>

/** Append-only override history for one owned target. */
export type AssetOverrideHistory = Schema.Codec.Encoded<typeof AssetOverrideHistoryResponse>

/** Typed identity validation result, including blockers and non-vetoing warnings. */
export type AssetOverrideIdentityValidation = Schema.Codec.Encoded<
  typeof AssetOverrideIdentityValidationResponse
>

/** Identity or inclusion replacement compare-and-set payload. */
export type AssetOverrideReplacement = Schema.Codec.Encoded<typeof AssetOverrideReplaceRequest>

/** Identity or inclusion withdrawal compare-and-set payload. */
export type AssetOverrideWithdrawal = Schema.Codec.Encoded<typeof AssetOverrideWithdrawRequest>

export type AssetOverrideIdentityValidationInput = {
  readonly target: AssetOverrideTarget
  readonly assetId: string
}

export type AssetOverrideReplaceInput = {
  readonly target: AssetOverrideTarget
  readonly replacement: AssetOverrideReplacement
}

export type AssetOverrideWithdrawInput = {
  readonly target: AssetOverrideTarget
  readonly withdrawal: AssetOverrideWithdrawal
}

export type AssetOverrideCurrentError = Effect.Error<
  ReturnType<AssetOverridesClient["getAssetOverrideCurrent"]>
>

export type AssetOverrideHistoryError = Effect.Error<
  ReturnType<AssetOverridesClient["getAssetOverrideHistory"]>
>

export type AssetOverrideIdentityValidationError = Effect.Error<
  ReturnType<AssetOverridesClient["validateAssetOverrideIdentity"]>
>

export type AssetOverrideReplaceError = Effect.Error<
  ReturnType<AssetOverridesClient["replaceAssetOverride"]>
>

export type AssetOverrideWithdrawError = Effect.Error<
  ReturnType<AssetOverridesClient["withdrawAssetOverride"]>
>

/** Structured API failures callers may inspect after a Promise rejection. */
export type TaxMaxiAssetOverrideError =
  | AssetOverrideCanonicalTargetError
  | AssetOverrideTargetNotFoundError
  | AssetOverrideReadonlyError
  | AssetOverrideMutationConflictError
  | AssetOverrideReplacementValidationError

/** Effect-native reads and mutations for principal asset overrides. */
export interface AssetOverridesEffectResource {
  readonly getCurrent: (
    target: AssetOverrideTarget
  ) => Effect.Effect<AssetOverrideCurrent, AssetOverrideCurrentError, never>
  readonly getHistory: (
    target: AssetOverrideTarget
  ) => Effect.Effect<AssetOverrideHistory, AssetOverrideHistoryError, never>
  readonly validateIdentity: (
    input: AssetOverrideIdentityValidationInput
  ) => Effect.Effect<AssetOverrideIdentityValidation, AssetOverrideIdentityValidationError, never>
  readonly replace: (
    input: AssetOverrideReplaceInput
  ) => Effect.Effect<AssetOverrideCurrent, AssetOverrideReplaceError, never>
  readonly withdraw: (
    input: AssetOverrideWithdrawInput
  ) => Effect.Effect<AssetOverrideCurrent, AssetOverrideWithdrawError, never>
}

/** Promise-based reads and mutations for principal asset overrides. */
export interface AssetOverridesPromiseResource {
  readonly getCurrent: (
    target: AssetOverrideTarget,
    options?: AssetRequestOptions
  ) => Promise<AssetOverrideCurrent>
  readonly getHistory: (
    target: AssetOverrideTarget,
    options?: AssetRequestOptions
  ) => Promise<AssetOverrideHistory>
  readonly validateIdentity: (
    input: AssetOverrideIdentityValidationInput,
    options?: AssetRequestOptions
  ) => Promise<AssetOverrideIdentityValidation>
  readonly replace: (
    input: AssetOverrideReplaceInput,
    options?: AssetRequestOptions
  ) => Promise<AssetOverrideCurrent>
  readonly withdraw: (
    input: AssetOverrideWithdrawInput,
    options?: AssetRequestOptions
  ) => Promise<AssetOverrideCurrent>
}

const encodeCurrent = Schema.encodeSync(AssetOverrideCurrentResponse)
const encodeHistory = Schema.encodeSync(AssetOverrideHistoryResponse)
const encodeIdentityValidation = Schema.encodeSync(AssetOverrideIdentityValidationResponse)

const toTargetQuery = (target: AssetOverrideTarget) =>
  target._tag === "provider_asset"
    ? {
        targetKind: target._tag,
        providerAssetRowId: target.providerAssetRowId,
      }
    : {
        targetKind: target._tag,
        blockchain: target.blockchain,
        representationType: target.type,
        contractAddress: target.contractAddress ?? undefined,
        mintAddress: target.mintAddress ?? undefined,
      }

const replaceAssetOverride = ({
  client,
  payload,
  query,
}: {
  readonly client: AssetOverridesClient
  readonly payload: typeof AssetOverrideReplaceRequest.Type
  readonly query: ReturnType<typeof toTargetQuery>
}) =>
  // The generated client has one call signature for each tagged payload member.
  payload._tag === "identity"
    ? client.replaceAssetOverride({ query, payload })
    : client.replaceAssetOverride({ query, payload })

export const makeAssetOverridesEffectResource = (
  client: Effect.Effect<TaxMaxiAssetOverridesClient, never>
): AssetOverridesEffectResource => ({
  getCurrent: (target) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assetOverrides.getAssetOverrideCurrent({ query: toTargetQuery(target) })
      ),
      encodeCurrent
    ),
  getHistory: (target) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assetOverrides.getAssetOverrideHistory({ query: toTargetQuery(target) })
      ),
      encodeHistory
    ),
  validateIdentity: ({ assetId, target }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assetOverrides.validateAssetOverrideIdentity({
          query: { ...toTargetQuery(target), assetId },
        })
      ),
      encodeIdentityValidation
    ),
  replace: ({ replacement, target }) =>
    Effect.map(
      Effect.flatMap(Schema.decodeEffect(AssetOverrideReplaceRequest)(replacement), (payload) =>
        Effect.flatMap(client, (resolved) =>
          replaceAssetOverride({
            client: resolved.assetOverrides,
            payload,
            query: toTargetQuery(target),
          })
        )
      ),
      encodeCurrent
    ),
  withdraw: ({ target, withdrawal }) =>
    Effect.map(
      Effect.flatMap(Schema.decodeEffect(AssetOverrideWithdrawRequest)(withdrawal), (payload) =>
        Effect.flatMap(client, (resolved) =>
          resolved.assetOverrides.withdrawAssetOverride({
            query: toTargetQuery(target),
            payload,
          })
        )
      ),
      encodeCurrent
    ),
})

export const makeAssetOverridesPromiseResource = (
  effect: AssetOverridesEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): AssetOverridesPromiseResource => ({
  getCurrent: (target, options) => run(effect.getCurrent(target), options),
  getHistory: (target, options) => run(effect.getHistory(target), options),
  validateIdentity: (input, options) => run(effect.validateIdentity(input), options),
  replace: (input, options) => run(effect.replace(input), options),
  withdraw: (input, options) => run(effect.withdraw(input), options),
})
