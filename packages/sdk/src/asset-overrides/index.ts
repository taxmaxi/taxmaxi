import type {
  AssetOverrideHistoryResponse,
  AssetOverrideProjectionResponse,
  AssetOverrideValidationResponse,
} from "@my/rest-api/contracts"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import { HttpApiClient } from "effect/unstable/httpapi"

type FullClient = HttpApiClient.ForApi<typeof TaxMaxiApi>
type Client = Pick<FullClient, Extract<keyof FullClient, "assetOverrides">>

export type AssetOverrideTarget = AssetOverrideProjectionResponse["target"]
export type AssetOverrideReplacement = NonNullable<AssetOverrideHistoryResponse["replacement"]>
export type AssetOverrideProjection = AssetOverrideProjectionResponse
export type AssetOverrideHistory = ReadonlyArray<AssetOverrideHistoryResponse>
export type AssetOverrideValidation = AssetOverrideValidationResponse

export type AssetOverrideReadInput = {
  readonly kind: "identity" | "inclusion"
  readonly target: AssetOverrideTarget
}

export type AssetOverrideSetInput = AssetOverrideReadInput & {
  readonly expectedSystemRevision: string
  readonly replacement: AssetOverrideReplacement
  readonly reason: string
}

export type AssetOverrideReplaceInput = AssetOverrideSetInput & {
  readonly overrideId: string
}

export type AssetOverrideWithdrawInput = AssetOverrideReadInput & {
  readonly overrideId: string
  readonly expectedSystemRevision: string
  readonly reason: string
}

export type AssetOverrideRequestOptions = { readonly signal?: AbortSignal }

const targetQuery = ({ kind, target }: AssetOverrideReadInput) =>
  target._tag === "provider_asset"
    ? {
        kind,
        targetKind: "provider_asset" as const,
        providerAssetRowId: target.providerAssetRowId,
      }
    : {
        kind,
        targetKind: "representation" as const,
        blockchainId: target.blockchainId,
        representationType: target.representationType,
        contractAddress: target.contractAddress ?? undefined,
        mintAddress: target.mintAddress ?? undefined,
      }

export type AssetOverridesEffectResource = {
  readonly current: (
    input: AssetOverrideReadInput
  ) => Effect.Effect<AssetOverrideProjection, unknown>
  readonly history: (input: AssetOverrideReadInput) => Effect.Effect<AssetOverrideHistory, unknown>
  readonly validate: (
    input: AssetOverrideReadInput & { readonly replacement: AssetOverrideReplacement }
  ) => Effect.Effect<AssetOverrideValidation, unknown>
  readonly create: (input: AssetOverrideSetInput) => Effect.Effect<AssetOverrideProjection, unknown>
  readonly replace: (
    input: AssetOverrideReplaceInput
  ) => Effect.Effect<AssetOverrideProjection, unknown>
  readonly withdraw: (
    input: AssetOverrideWithdrawInput
  ) => Effect.Effect<AssetOverrideProjection, unknown>
}

export type AssetOverridesPromiseResource = {
  readonly current: (
    input: AssetOverrideReadInput,
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideProjection>
  readonly history: (
    input: AssetOverrideReadInput,
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideHistory>
  readonly validate: (
    input: AssetOverrideReadInput & { readonly replacement: AssetOverrideReplacement },
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideValidation>
  readonly create: (
    input: AssetOverrideSetInput,
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideProjection>
  readonly replace: (
    input: AssetOverrideReplaceInput,
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideProjection>
  readonly withdraw: (
    input: AssetOverrideWithdrawInput,
    options?: AssetOverrideRequestOptions
  ) => Promise<AssetOverrideProjection>
}

export const makeAssetOverridesEffectResource = (
  client: Effect.Effect<Client, never>
): AssetOverridesEffectResource => ({
  current: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.getCurrentAssetOverride({ query: targetQuery(input) })
    ),
  history: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.getAssetOverrideHistory({ query: targetQuery(input) })
    ),
  validate: ({ kind, target, replacement }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.validateAssetOverride({ payload: { kind, target, replacement } })
    ),
  create: ({ kind, target, expectedSystemRevision, replacement, reason }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.createAssetOverride({
        payload: { kind, target, expectedSystemRevision, replacement, reason },
      })
    ),
  replace: ({ overrideId, kind, target, expectedSystemRevision, replacement, reason }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.replaceAssetOverride({
        params: { overrideId },
        payload: { kind, target, expectedSystemRevision, replacement, reason },
      })
    ),
  withdraw: ({ overrideId, kind, target, expectedSystemRevision, reason }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assetOverrides.withdrawAssetOverride({
        params: { overrideId },
        payload: { kind, target, expectedSystemRevision, reason },
      })
    ),
})

export const makeAssetOverridesPromiseResource = (
  effect: AssetOverridesEffectResource,
  run: <A>(
    effect: Effect.Effect<A, unknown, never>,
    options?: AssetOverrideRequestOptions
  ) => Promise<A>
): AssetOverridesPromiseResource => ({
  current: (input, options) => run(effect.current(input), options),
  history: (input, options) => run(effect.history(input), options),
  validate: (input, options) => run(effect.validate(input), options),
  create: (input, options) => run(effect.create(input), options),
  replace: (input, options) => run(effect.replace(input), options),
  withdraw: (input, options) => run(effect.withdraw(input), options),
})
