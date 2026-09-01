/**
 * CoinGeckoHistoricalPriceClient - Historical daily EUR price snapshots.
 *
 * @module CoinGeckoHistoricalPriceClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** CoinGecko request or response failure for one historical daily snapshot. */
export class CoinGeckoHistoricalPriceError extends Schema.TaggedError<CoinGeckoHistoricalPriceError>()(
  "CoinGeckoHistoricalPriceError",
  {
    coinId: Schema.String,
    date: Schema.String,
    status: Schema.NullOr(Schema.Int),
    cause: Schema.Unknown,
  }
) {}

/** Historical daily CoinGecko price client contract. */
export interface CoinGeckoHistoricalPriceClientShape {
  /** Fetch the EUR value from one CoinGecko coin history snapshot. */
  readonly fetchDailyEurPrice: (params: {
    readonly coinId: string
    readonly snapshotAt: Date
  }) => Effect.Effect<Option.Option<string>, CoinGeckoHistoricalPriceError>
}

/** Injectable CoinGecko historical daily price client. */
export class CoinGeckoHistoricalPriceClient extends Context.Service<
  CoinGeckoHistoricalPriceClient,
  CoinGeckoHistoricalPriceClientShape
>()("CoinGeckoHistoricalPriceClient") {}
