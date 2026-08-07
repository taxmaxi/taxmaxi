import { FetchHttpClient, HttpApiClient } from "@effect/platform"
import type { HttpApi } from "@effect/platform"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import {
  makeInternalAssetsEffectResource,
  makeInternalAssetsPromiseResource,
  type InternalAssetsEffectResource,
  type InternalAssetsPromiseResource,
} from "./assets/index.ts"
import {
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  type TaxMaxiEffectClientOptions,
} from "./client.ts"
import { toTaxMaxiError } from "./errors.ts"

export type {
  AssetCanonicalization,
  AssetCanonicalizationInput,
  AssetCatalogAsset,
  AssetCatalogDetailInput,
  AssetCatalogList,
  AssetCatalogListInput,
  AssetsEffectResource,
  AssetsPromiseResource,
  InternalAssetsEffectResource,
  InternalAssetsPromiseResource,
  ProviderAssetReview,
  ProviderAssetApprovalInput,
  ProviderAssetReviewList,
  ProviderAssetReviewListInput,
} from "./assets/index.ts"

export type TaxMaxiInternalEffectClient =
  typeof TaxMaxiApi extends HttpApi.HttpApi<string, infer Groups, infer ApiError, infer _ApiContext>
    ? HttpApiClient.Client<Groups, ApiError, never>
    : never

export const makeTaxMaxiInternalEffectClient = (
  options: TaxMaxiEffectClientOptions = {}
): Effect.Effect<TaxMaxiInternalEffectClient, never> => {
  const client = HttpApiClient.make(TaxMaxiApi, {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    transformClient: makeTaxMaxiHttpClientTransform(options),
  }).pipe(Effect.provide(FetchHttpClient.layer))

  const clientWithFetch =
    options.fetch === undefined
      ? client
      : client.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))

  return options.credentials === undefined
    ? clientWithFetch
    : clientWithFetch.pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: options.credentials,
        })
      )
}

export type TaxMaxiInternalEffectResources = {
  readonly assets: InternalAssetsEffectResource
}

export type TaxMaxiInternalPromiseResources = {
  readonly assets: InternalAssetsPromiseResource
}

const makeTaxMaxiInternalEffectResources = (
  client: Effect.Effect<TaxMaxiInternalEffectClient, never>
): TaxMaxiInternalEffectResources => ({
  assets: makeInternalAssetsEffectResource(client),
})

export class TaxMaxiInternal implements TaxMaxiInternalPromiseResources {
  readonly assets: InternalAssetsPromiseResource
  readonly effect: TaxMaxiInternalEffectResources

  private readonly client: Effect.Effect<TaxMaxiInternalEffectClient, never>

  constructor(options: TaxMaxiEffectClientOptions = {}) {
    this.client = makeTaxMaxiInternalEffectClient(options)
    this.effect = makeTaxMaxiInternalEffectResources(this.client)
    this.assets = makeInternalAssetsPromiseResource(this.effect.assets, this.run)
  }

  static makeEffectClient(
    options: TaxMaxiEffectClientOptions = {}
  ): Effect.Effect<TaxMaxiInternalEffectClient, never> {
    return makeTaxMaxiInternalEffectClient(options)
  }

  private readonly run = async <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> => {
    try {
      return await Effect.runPromise(effect)
    } catch (error) {
      throw toTaxMaxiError(error)
    }
  }
}
