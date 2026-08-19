/**
 * AssetResolutionCoinGeckoClient - Injectable CoinGecko evidence source for attach-only resolution.
 *
 * @module AssetResolutionCoinGeckoClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { AssetResolutionProviderEvidence } from "@my/core/assets"

/**
 * AssetResolutionCoinGeckoClientShape - Fetch one CoinGecko coin payload by its stable coin id.
 */
export interface AssetResolutionCoinGeckoClientShape {
  /**
   * Fetch a CoinGecko coin payload. Never fails: upstream errors surface as
   * an AssetResolutionUpstreamFailure evidence value so attach-only policy
   * can fail closed instead of stopping the resolution job.
   */
  readonly fetchCoin: (params: {
    readonly coinGeckoCoinId: string
  }) => Effect.Effect<AssetResolutionProviderEvidence>
}

/**
 * AssetResolutionCoinGeckoClient - Context tag for the CoinGecko evidence source.
 */
export class AssetResolutionCoinGeckoClient extends Context.Service<
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoClientShape
>()("AssetResolutionCoinGeckoClient") {}
