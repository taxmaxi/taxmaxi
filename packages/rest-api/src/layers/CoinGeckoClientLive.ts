/**
 * CoinGeckoClientLive - HTTP adapter for typed CoinGecko access.
 *
 * @module CoinGeckoClientLive
 */

import { HttpClient } from "effect/unstable/http"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeCoinGeckoRequest } from "@my/sync-engine/shared"
import {
  CoinGeckoClient,
  CoinGeckoClientError,
  type CoinGeckoClientShape,
} from "../services/coingecko/CoinGeckoClient.ts"

const CoinGeckoSearchCoin = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
})

const CoinGeckoSearchResponse = Schema.Struct({
  coins: Schema.Array(CoinGeckoSearchCoin),
})

const CoinGeckoDetailPlatform = Schema.Struct({
  decimal_place: Schema.NullOr(Schema.Finite),
  contract_address: Schema.String,
})

const CoinGeckoCoin = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  asset_platform_id: Schema.NullOr(Schema.String),
  platforms: Schema.Record(Schema.String, Schema.String),
  detail_platforms: Schema.Record(Schema.String, CoinGeckoDetailPlatform),
  image: Schema.optional(
    Schema.Struct({
      thumb: Schema.String,
      small: Schema.String,
      large: Schema.String,
    })
  ),
})

const CoinGeckoMarket = Schema.Struct({
  id: Schema.String,
  image: Schema.String,
  current_price: Schema.NullOr(Schema.Finite),
})

const CoinGeckoMarketsResponse = Schema.Array(CoinGeckoMarket)

const makeError = (message: string) => new CoinGeckoClientError({ message })

const decodeJson = <S extends Schema.Constraint>(schema: S, endpoint: string, payload: unknown) =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError((error) =>
      makeError(`Failed to decode CoinGecko response for ${endpoint}: ${error.message}`)
    )
  )

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const coinGeckoRequest = yield* makeCoinGeckoRequest

  const executeGetJson = (endpoint: string) =>
    Effect.gen(function* () {
      const request = coinGeckoRequest.getRequest(endpoint)
      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.mapError((error) =>
            makeError(`CoinGecko request failed for ${endpoint}: ${error.message}`)
          )
        )

      if (response.status < 200 || response.status >= 300) {
        const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* makeError(
          `CoinGecko request failed (${response.status}) ${endpoint}: ${bodyText}`
        )
      }

      return yield* response.json.pipe(
        Effect.mapError((error) =>
          makeError(`Failed to parse CoinGecko JSON for ${endpoint}: ${String(error)}`)
        )
      )
    })

  const searchCoins: CoinGeckoClientShape["searchCoins"] = ({ query }) =>
    Effect.gen(function* () {
      const endpoint = `/search?query=${encodeURIComponent(query)}`
      const payload = yield* executeGetJson(endpoint)
      const decoded = yield* decodeJson(CoinGeckoSearchResponse, endpoint, payload)
      return decoded.coins
    })

  const getCoin: CoinGeckoClientShape["getCoin"] = ({ coinId }) =>
    Effect.gen(function* () {
      const endpoint = `/coins/${encodeURIComponent(coinId)}`
      const payload = yield* executeGetJson(endpoint)
      return yield* decodeJson(CoinGeckoCoin, endpoint, payload)
    })

  const listMarkets: CoinGeckoClientShape["listMarkets"] = ({ coinIds, currency }) =>
    Effect.gen(function* () {
      const chunks: Array<ReadonlyArray<string>> = []
      for (let index = 0; index < coinIds.length; index += 250) {
        chunks.push(coinIds.slice(index, index + 250))
      }
      const pages = yield* Effect.forEach(
        chunks,
        (chunk) =>
          Effect.gen(function* () {
            const endpoint = `/coins/markets?vs_currency=${encodeURIComponent(currency)}&ids=${encodeURIComponent(chunk.join(","))}&per_page=250&page=1`
            const payload = yield* executeGetJson(endpoint)
            return yield* decodeJson(CoinGeckoMarketsResponse, endpoint, payload)
          }),
        { concurrency: 2 }
      )

      return pages.flatMap((page) =>
        page.map((market) => ({
          id: market.id,
          image: market.image,
          currentPrice: market.current_price,
        }))
      )
    })

  return CoinGeckoClient.of({ getCoin, listMarkets, searchCoins })
})

export const CoinGeckoClientLive = Layer.effect(CoinGeckoClient, make)
