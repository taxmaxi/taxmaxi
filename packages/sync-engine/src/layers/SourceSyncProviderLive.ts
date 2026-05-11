/**
 * SourceSyncProviderLive - Generic raw-fetch provider registry backed by sync-engine providers.
 *
 * @module SourceSyncProviderLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CoinbaseSourceSyncProvider } from "../providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import { SourceSyncProvider, type SourceSyncProviderShape } from "../services/SourceSyncProvider.ts"

const make = Effect.gen(function* () {
  const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider

  const fetchRawBatch: SourceSyncProviderShape["fetchRawBatch"] = (params) =>
    coinbaseSourceSyncProvider.fetchRawBatch(params)

  return SourceSyncProvider.of({
    fetchRawBatch,
  } satisfies SourceSyncProviderShape)
})

/**
 * SourceSyncProviderLive - Live generic provider registry for raw provider pulls.
 */
export const SourceSyncProviderLive = Layer.effect(SourceSyncProvider, make)
