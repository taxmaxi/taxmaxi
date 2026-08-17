/**
 * CoinGeckoClient - Typed access to CoinGecko asset and market endpoints.
 *
 * @module services/coingecko/CoinGeckoClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export interface CoinGeckoSearchCoin {
  readonly id: string
  readonly name: string
  readonly symbol: string
}

export interface CoinGeckoCoinPlatform {
  readonly decimal_place: number | null
  readonly contract_address: string
}

export interface CoinGeckoCoin {
  readonly id: string
  readonly symbol: string
  readonly name: string
  readonly asset_platform_id: string | null
  readonly platforms: Readonly<Record<string, string>>
  readonly detail_platforms: Readonly<Record<string, CoinGeckoCoinPlatform>>
  readonly image?:
    | {
        readonly thumb: string
        readonly small: string
        readonly large: string
      }
    | undefined
}

export interface CoinGeckoMarket {
  readonly id: string
  readonly image: string
  readonly currentPrice: number | null
}

export class CoinGeckoClientError extends Schema.TaggedError<CoinGeckoClientError>()(
  "CoinGeckoClientError",
  { message: Schema.String }
) {}

export interface CoinGeckoClientShape {
  readonly searchCoins: (params: {
    readonly query: string
  }) => Effect.Effect<ReadonlyArray<CoinGeckoSearchCoin>, CoinGeckoClientError>
  readonly getCoin: (params: {
    readonly coinId: string
  }) => Effect.Effect<CoinGeckoCoin, CoinGeckoClientError>
  readonly listMarkets: (params: {
    readonly coinIds: ReadonlyArray<string>
    readonly currency: string
  }) => Effect.Effect<ReadonlyArray<CoinGeckoMarket>, CoinGeckoClientError>
}

export class CoinGeckoClient extends Context.Service<CoinGeckoClient, CoinGeckoClientShape>()(
  "CoinGeckoClient"
) {}
