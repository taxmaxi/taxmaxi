/**
 * ProviderAssetCandidateServiceLive - Live CoinGecko evidence resolution.
 *
 * @module ProviderAssetCandidateServiceLive
 */

import { ProviderAssetRepository } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProviderAssetCandidateService,
  ProviderAssetCandidateError,
  type ProviderAssetCandidate,
} from "../services/ProviderAssetCandidateService.ts"
import { CoinGeckoClient } from "../services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"
import { selectNativePlatform } from "../services/coingecko/CoinGeckoPlatformSelection.ts"

const normalize = (value: string) => value.trim().toLowerCase()

const make = Effect.gen(function* () {
  const providerAssetRepository = yield* ProviderAssetRepository
  const coinGeckoClient = yield* CoinGeckoClient

  return ProviderAssetCandidateService.of({
    listCandidates: ({ providerAssetRowId }) =>
      Effect.gen(function* () {
        const review = yield* providerAssetRepository
          .findProviderAssetReviewById({ providerAssetRowId })
          .pipe(
            Effect.mapError(
              () => new ProviderAssetCandidateError({ message: "Failed to load provider asset." })
            )
          )
        if (Option.isNone(review)) {
          return yield* new ProviderAssetCandidateError({ message: "Provider asset not found." })
        }

        const providerAsset = review.value.providerAsset
        const searchResults = yield* coinGeckoClient
          .searchCoins({ query: providerAsset.currencyCode })
          .pipe(
            Effect.mapError(
              () => new ProviderAssetCandidateError({ message: "CoinGecko search failed." })
            )
          )
        const matching = searchResults.filter(
          (coin) => normalize(coin.symbol) === normalize(providerAsset.currencyCode)
        )

        return yield* Effect.forEach(matching, (candidate) =>
          coinGeckoClient.getCoin({ coinId: candidate.id }).pipe(
            Effect.mapError(
              () => new ProviderAssetCandidateError({ message: "CoinGecko candidate failed." })
            ),
            Effect.map((coin): ProviderAssetCandidate => {
              const nativePlatform = selectNativePlatform({
                coinId: coin.id,
                assetPlatforms: coinGeckoAssetPlatformSnapshot,
              })
              const tokenRepresentations = Object.entries(coin.platforms).flatMap(
                ([platformId, contractAddress]) => {
                  const trimmedAddress = contractAddress.trim()
                  if (trimmedAddress === "") return []

                  const platform = coinGeckoAssetPlatformSnapshot.find(
                    (entry) => entry.id === platformId
                  )
                  return [
                    {
                      platformId,
                      platformName: platform?.name ?? null,
                      contractAddress: trimmedAddress,
                      kind: "token" as const,
                    },
                  ]
                }
              )
              const representationEvidence =
                nativePlatform === null
                  ? tokenRepresentations
                  : [
                      {
                        platformId: nativePlatform.id,
                        platformName: nativePlatform.name,
                        contractAddress: null,
                        kind: "native" as const,
                      },
                      ...tokenRepresentations,
                    ]

              return {
                economicAsset: {
                  coinId: coin.id,
                  name: coin.name,
                  symbol: coin.symbol.toUpperCase(),
                },
                representationEvidence,
                matchStrength:
                  providerAsset.name !== null &&
                  normalize(providerAsset.name) === normalize(coin.name)
                    ? "exact_name_and_symbol"
                    : "symbol_only",
              }
            })
          )
        )
      }),
  })
})

/** Live candidate resolver. */
export const ProviderAssetCandidateServiceLive = Layer.effect(ProviderAssetCandidateService, make)
