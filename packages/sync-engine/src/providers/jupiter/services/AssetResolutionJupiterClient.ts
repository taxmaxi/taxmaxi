/**
 * AssetResolutionJupiterClient - Injectable Jupiter evidence source for asset resolution.
 *
 * Jupiter is a claim-scoped Solana authority: it may supply metadata,
 * verification state, explicit banned state, suspicious signals, and market
 * activity for one exact mint. It never proves that a Solana mint belongs
 * to a chain-independent economic asset.
 *
 * @module AssetResolutionJupiterClient
 */

import type { AssetResolutionRegistryEvidence } from "@my/core/assets"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The only blockchain Jupiter can testify about. */
export const JUPITER_SUPPORTED_BLOCKCHAIN = "solana"

/**
 * AssetResolutionJupiterRetryableError - Transient Jupiter fetch failure.
 *
 * Raised for rate limits, server errors, timeouts, and transport failures
 * after the client's own bounded retries are exhausted. The executor releases
 * the job for a later attempt instead of recording a durable decision,
 * because retrying can change the answer.
 */
export class AssetResolutionJupiterRetryableError extends Schema.TaggedError<AssetResolutionJupiterRetryableError>()(
  "AssetResolutionJupiterRetryableError",
  {
    status: Schema.NullOr(Schema.Int),
    cause: Schema.Unknown,
  }
) {}

/**
 * AssetResolutionJupiterClientShape - Look up Jupiter's token information for
 * one exact Solana mint address.
 */
export interface AssetResolutionJupiterClientShape {
  /**
   * Look up Jupiter's token search result for one exact mint.
   *
   * A 2xx response surfaces as a payload evidence value; the caller decodes
   * it into a legitimacy claim, where a response without the mint is a
   * definitive not-indexed answer. Other terminal outcomes (an unreadable
   * body, an unexpected status) surface as an AssetResolutionUpstreamFailure
   * evidence value so the policy can fail closed. Transient outcomes (rate
   * limit, server error, timeout, transport failure) fail with
   * AssetResolutionJupiterRetryableError so the caller can retry later
   * instead of recording a durable decision.
   */
  readonly fetchTokenByMint: (params: {
    readonly mintAddress: string
  }) => Effect.Effect<AssetResolutionRegistryEvidence, AssetResolutionJupiterRetryableError>
}

/**
 * AssetResolutionJupiterClient - Context tag for the Jupiter evidence source.
 */
export class AssetResolutionJupiterClient extends Context.Service<
  AssetResolutionJupiterClient,
  AssetResolutionJupiterClientShape
>()("AssetResolutionJupiterClient") {}
