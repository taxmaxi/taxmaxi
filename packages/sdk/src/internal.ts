import { FetchHttpClient, HttpApiClient } from "@effect/platform"
import type { HttpApi } from "@effect/platform"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import {
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  type TaxMaxiEffectClientOptions,
} from "./client.ts"

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
