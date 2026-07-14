/** CoinGecko-backed current market prices. */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class CoinGeckoPriceError extends Schema.TaggedError<CoinGeckoPriceError>()(
  "CoinGeckoPriceError",
  { message: Schema.String }
) {}

export interface CoinGeckoMarketData {
  readonly price: string
  readonly logoUrl: string
}

export interface CoinGeckoPriceServiceShape {
  readonly getCurrentPrices: (params: {
    readonly coinIds: ReadonlyArray<string>
    readonly currency: string
  }) => Effect.Effect<ReadonlyMap<string, CoinGeckoMarketData>, CoinGeckoPriceError>
}

export class CoinGeckoPriceService extends Context.Tag("CoinGeckoPriceService")<
  CoinGeckoPriceService,
  CoinGeckoPriceServiceShape
>() {}
