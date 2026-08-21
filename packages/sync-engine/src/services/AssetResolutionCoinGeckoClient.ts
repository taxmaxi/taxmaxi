/**
 * AssetResolutionCoinGeckoClient - Injectable CoinGecko evidence source for asset resolution.
 *
 * @module AssetResolutionCoinGeckoClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AssetResolutionRegistryEvidence } from "@my/core/assets"

/**
 * AssetResolutionCoinGeckoRetryableError - Transient CoinGecko fetch failure.
 *
 * Raised for rate limits, server errors, timeouts, and transport failures
 * after the client's own bounded retries are exhausted. The executor releases
 * the job for a later attempt instead of recording a durable decision,
 * because retrying can change the answer.
 */
export class AssetResolutionCoinGeckoRetryableError extends Schema.TaggedError<AssetResolutionCoinGeckoRetryableError>()(
  "AssetResolutionCoinGeckoRetryableError",
  {
    status: Schema.NullOr(Schema.Int),
    cause: Schema.Unknown,
  }
) {}

/**
 * AssetResolutionCoinGeckoClientShape - Look up one CoinGecko coin by the exact
 * on-chain contract or mint address it represents.
 */
export interface AssetResolutionCoinGeckoClientShape {
  /**
   * Look up the CoinGecko coin for one exact platform address.
   *
   * A 404 is a definitive answer that CoinGecko does not know the
   * representation and surfaces as a RegistryLookupNotFound evidence value,
   * so the policy may consider standalone creation. Other terminal outcomes
   * (an unreadable body, an unexpected status) surface as an
   * AssetResolutionUpstreamFailure evidence value so the policy can fail
   * closed. Transient outcomes (rate limit, server error, timeout, transport
   * failure) fail with AssetResolutionCoinGeckoRetryableError so the caller
   * can retry later instead of recording a durable decision.
   */
  readonly fetchCoinByContract: (params: {
    readonly platformId: string
    readonly address: string
  }) => Effect.Effect<AssetResolutionRegistryEvidence, AssetResolutionCoinGeckoRetryableError>
}

/**
 * AssetResolutionCoinGeckoClient - Context tag for the CoinGecko evidence source.
 */
export class AssetResolutionCoinGeckoClient extends Context.Service<
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoClientShape
>()("AssetResolutionCoinGeckoClient") {}
