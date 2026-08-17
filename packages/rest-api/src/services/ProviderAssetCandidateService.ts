/**
 * ProviderAssetCandidateService - Internal CoinGecko evidence resolution seam.
 *
 * @module ProviderAssetCandidateService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ProviderAssetResolutionProposalSearchResult } from "./ProviderAssetReviewService.ts"

/** Candidate lookup failed before evidence could be returned. */
export class ProviderAssetCandidateError extends Schema.TaggedError<ProviderAssetCandidateError>()(
  "ProviderAssetCandidateError",
  { message: Schema.String }
) {}

/** Internal contract for resolving current provider-asset candidates. */
export interface ProviderAssetCandidateServiceShape {
  readonly searchProposals: (params: {
    readonly providerAssetRowId: string
    readonly query: string | null
  }) => Effect.Effect<ProviderAssetResolutionProposalSearchResult, ProviderAssetCandidateError>
}

/** Internal candidate resolver used by the provider asset review module. */
export class ProviderAssetCandidateService extends Context.Service<
  ProviderAssetCandidateService,
  ProviderAssetCandidateServiceShape
>()("ProviderAssetCandidateService") {}
