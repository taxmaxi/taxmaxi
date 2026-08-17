import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import { CoinGeckoPriceServiceLive } from "../src/layers/CoinGeckoPriceServiceLive.ts"
import { CoinGeckoPriceService } from "../src/services/CoinGeckoPriceService.ts"
import { CoinGeckoClient } from "../src/services/coingecko/CoinGeckoClient.ts"

describe("CoinGeckoPriceServiceLive", () => {
  it("projects priced markets and omits assets without a current price", async () => {
    const ClientTestLive = Layer.succeed(
      CoinGeckoClient,
      CoinGeckoClient.of({
        searchCoins: () => Effect.succeed([]),
        getCoin: () => Effect.die("not used"),
        listMarkets: () =>
          Effect.succeed([
            {
              id: "bitcoin",
              image: "https://images.example.test/bitcoin.png",
              currentPrice: 123.45,
            },
            {
              id: "unpriced",
              image: "https://images.example.test/unpriced.png",
              currentPrice: null,
            },
          ]),
      })
    )

    const prices = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CoinGeckoPriceService
        return yield* service.getCurrentPrices({
          coinIds: ["bitcoin", "unpriced"],
          currency: "eur",
        })
      }).pipe(Effect.provide(CoinGeckoPriceServiceLive.pipe(Layer.provide(ClientTestLive))))
    )

    expect(Array.from(prices.entries())).toEqual([
      [
        "bitcoin",
        {
          price: "123.45",
          logoUrl: "https://images.example.test/bitcoin.png",
        },
      ],
    ])
  })
})
