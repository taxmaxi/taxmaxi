/**
 * ProviderAssetCandidateService - Internal CoinGecko evidence resolution seam.
 *
 * @module ProviderAssetCandidateService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Candidate lookup failed before evidence could be returned. */
export class ProviderAssetCandidateError extends Schema.TaggedError<ProviderAssetCandidateError>()(
  "ProviderAssetCandidateError",
  { message: Schema.String }
) {}

/** Network representation evidence attached to one economic-asset candidate. */
export interface ProviderAssetCandidateRepresentationEvidence {
  readonly platformId: string
  readonly platformName: string | null
  readonly contractAddress: string | null
  readonly kind: "native" | "token"
}

/** A CoinGecko economic asset candidate and its separate representation evidence. */
export interface ProviderAssetCandidate {
  readonly economicAsset: {
    readonly coinId: string
    readonly name: string
    readonly symbol: string
  }
  readonly representationEvidence: ReadonlyArray<ProviderAssetCandidateRepresentationEvidence>
  readonly matchStrength: "exact_name_and_symbol" | "symbol_only"
}

/** Internal contract for resolving current provider-asset candidates. */
export interface ProviderAssetCandidateServiceShape {
  readonly listCandidates: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<ProviderAssetCandidate>, ProviderAssetCandidateError>
}

/** Internal candidate resolver used by the provider asset review module. */
export class ProviderAssetCandidateService extends Context.Service<
  ProviderAssetCandidateService,
  ProviderAssetCandidateServiceShape
>()("ProviderAssetCandidateService") {}
