/**
 * AssetResolutionCoinGeckoClient - Injectable CoinGecko evidence source for attach-only resolution.
 *
 * @module AssetResolutionCoinGeckoClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AssetResolutionProviderEvidence } from "@my/core/assets"

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
 * AssetResolutionCoinGeckoClientShape - Fetch one CoinGecko coin payload by its stable coin id.
 */
export interface AssetResolutionCoinGeckoClientShape {
  /**
   * Fetch a CoinGecko coin payload.
   *
   * Terminal outcomes (a missing coin or a body that cannot be read) surface
   * as an AssetResolutionUpstreamFailure evidence value so attach-only policy
   * can fail closed. Transient outcomes (rate limit, server error, timeout,
   * transport failure) fail with AssetResolutionCoinGeckoRetryableError so
   * the caller can retry later instead of recording a durable decision.
   */
  readonly fetchCoin: (params: {
    readonly coinGeckoCoinId: string
  }) => Effect.Effect<AssetResolutionProviderEvidence, AssetResolutionCoinGeckoRetryableError>
}

/**
 * AssetResolutionCoinGeckoClient - Context tag for the CoinGecko evidence source.
 */
export class AssetResolutionCoinGeckoClient extends Context.Service<
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoClientShape
>()("AssetResolutionCoinGeckoClient") {}
