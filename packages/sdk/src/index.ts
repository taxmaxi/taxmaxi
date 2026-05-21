import * as Effect from "effect/Effect"
import {
  makeTaxMaxiEffectClient,
  resolveHeaders,
  type TaxMaxiEffectClient,
  type TaxMaxiEffectClientOptions,
  type TaxMaxiHeaders,
  type TaxMaxiHeadersProvider,
  type TaxMaxiOptions,
  type TaxMaxiBrowserSessionOptions,
  type TaxMaxiRequestOptions,
} from "./client.ts"
import {
  makeAuthEffectResource,
  makeAuthPromiseResource,
  type AuthEffectResource,
  type AuthPromiseResource,
} from "./auth/index.ts"
import { toTaxMaxiError } from "./errors.ts"
import {
  makeSourcesEffectResource,
  makeSourcesPromiseResource,
  type SourcesEffectResource,
  type SourcesPromiseResource,
} from "./sources/index.ts"

export {
  DEFAULT_BASE_URL,
  makeTaxMaxiEffectClient,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
} from "./client.ts"
export type {
  TaxMaxiBrowserSessionOptions,
  TaxMaxiEffectClient,
  TaxMaxiEffectClientOptions,
  TaxMaxiHeaders,
  TaxMaxiHeadersProvider,
  TaxMaxiOptions,
  TaxMaxiRequestCredentials,
  TaxMaxiRequestOptions,
} from "./client.ts"
export type {
  AuthEffectResource,
  AuthLogoutResponse,
  AuthPromiseResource,
  CurrentUserResponse,
} from "./auth/index.ts"
export { TaxMaxiError, toTaxMaxiError } from "./errors.ts"
export type { TaxMaxiFieldError } from "./errors.ts"
export type {
  CalculateTaxInput,
  Source,
  SourceCreate,
  SourceCreateInput,
  SourceIdInput,
  SourceList,
  SourcesEffectResource,
  SourcesPromiseResource,
  SourceSyncJob,
  SourceSyncJobInput,
  SourceSyncStart,
  TaxCalculation,
} from "./sources/index.ts"

export type TaxMaxiEffectResources = {
  readonly auth: AuthEffectResource
  readonly sources: SourcesEffectResource
}

export type TaxMaxiPromiseResources = {
  readonly auth: AuthPromiseResource
  readonly sources: SourcesPromiseResource
}

const makeTaxMaxiEffectResources = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): TaxMaxiEffectResources => ({
  auth: makeAuthEffectResource(client),
  sources: makeSourcesEffectResource(client),
})

const mergeHeaders =
  (
    headers: TaxMaxiHeadersProvider | undefined,
    additionalHeaders: TaxMaxiHeaders
  ): TaxMaxiHeadersProvider =>
  () => ({
    ...resolveHeaders(headers),
    ...additionalHeaders,
  })

export class TaxMaxi implements TaxMaxiPromiseResources {
  readonly auth: AuthPromiseResource
  readonly effect: TaxMaxiEffectResources
  readonly sources: SourcesPromiseResource

  private readonly client: Effect.Effect<TaxMaxiEffectClient, never>

  constructor(options: TaxMaxiOptions) {
    this.client = makeTaxMaxiEffectClient(options)
    this.effect = makeTaxMaxiEffectResources(this.client)
    this.auth = makeAuthPromiseResource(this.effect.auth, this.run)
    this.sources = makeSourcesPromiseResource(this.effect.sources, this.run)
  }

  static makeEffectClient(
    options: TaxMaxiEffectClientOptions = {}
  ): Effect.Effect<TaxMaxiEffectClient, never> {
    return makeTaxMaxiEffectClient(options)
  }

  static fromBrowserSession(options: TaxMaxiBrowserSessionOptions = {}): TaxMaxi {
    return TaxMaxi.fromEffectClientOptions({
      ...options,
      credentials: options.credentials ?? "include",
    })
  }

  static fromRequest(options: TaxMaxiRequestOptions): TaxMaxi {
    return TaxMaxi.fromEffectClientOptions({
      ...options,
      headers: mergeHeaders(options.headers, {
        cookie: options.cookieHeader,
      }),
    })
  }

  private static fromEffectClientOptions(options: TaxMaxiEffectClientOptions): TaxMaxi {
    return new TaxMaxi({
      ...options,
      apiKey: options.apiKey ?? "",
    })
  }

  private readonly run = async <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> => {
    try {
      return await Effect.runPromise(effect)
    } catch (error) {
      throw toTaxMaxiError(error)
    }
  }
}
