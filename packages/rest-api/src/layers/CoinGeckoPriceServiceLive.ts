/** CoinGeckoPriceServiceLive - Current market data projection. */

import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CoinGeckoPriceError,
  CoinGeckoPriceService,
  type CoinGeckoPriceServiceShape,
} from "../services/CoinGeckoPriceService.ts"
import { CoinGeckoClient } from "../services/coingecko/CoinGeckoClient.ts"

const makeError = (message: string) => new CoinGeckoPriceError({ message })

const make = Effect.gen(function* () {
  const coinGeckoClient = yield* CoinGeckoClient

  const getCurrentPrices: CoinGeckoPriceServiceShape["getCurrentPrices"] = ({
    coinIds,
    currency,
  }) =>
    Effect.gen(function* () {
      const markets = yield* coinGeckoClient
        .listMarkets({ coinIds, currency })
        .pipe(Effect.mapError((error) => makeError(error.message)))

      return new Map(
        markets.flatMap((market) =>
          market.currentPrice === null
            ? []
            : [
                [
                  market.id,
                  {
                    price: BigDecimal.format(BigDecimal.unsafeFromNumber(market.currentPrice)),
                    logoUrl: market.image,
                  },
                ] as const,
              ]
        )
      )
    })

  return CoinGeckoPriceService.of({ getCurrentPrices })
})

export const CoinGeckoPriceServiceLive = Layer.effect(CoinGeckoPriceService, make)
