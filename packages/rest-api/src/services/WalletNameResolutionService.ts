/**
 * WalletNameResolutionService - Contract for resolving wallet names to addresses.
 *
 * Takes a raw wallet name string, detects its name-service namespace (ENS,
 * SNS), and resolves it to an onchain address. Resolution checks the durable
 * cache first and falls back to an on-chain lookup. Name records can change,
 * so cache entries expire and get refreshed.
 *
 * @module WalletNameResolutionService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  type ChainType,
  NameServiceNamespace,
  WalletNameResolutionErrorCode,
} from "@my/core/source"
import type { PersistenceError } from "@my/persistence/errors"

/**
 * WalletNameResolutionError - A wallet name could not be resolved to an address.
 *
 * `code` is the stable contract for clients; `message` is developer-facing
 * English and not meant for display. The original cause is preserved for
 * logging.
 */
export class WalletNameResolutionError extends Schema.TaggedError<WalletNameResolutionError>()(
  "WalletNameResolutionError",
  {
    code: WalletNameResolutionErrorCode,
    name: Schema.String,
    namespace: Schema.NullOr(NameServiceNamespace),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * Type guard for WalletNameResolutionError
 */
export const isWalletNameResolutionError = Schema.is(WalletNameResolutionError)

/**
 * WalletNameResolution - A resolved wallet name.
 */
export interface WalletNameResolution {
  /** Name service the name belongs to */
  readonly namespace: NameServiceNamespace
  /** Lowercased and trimmed wallet name */
  readonly name: string
  /** Address the name resolves to */
  readonly resolvedAddress: string
  /** Chain family of the resolved address */
  readonly chainType: ChainType
  /** True when the result came from the cache instead of an on-chain lookup */
  readonly fromCache: boolean
}

/**
 * WalletNameResolutionServiceShape - Operations for wallet name resolution.
 */
export interface WalletNameResolutionServiceShape {
  /**
   * Resolve a raw wallet name string to an onchain address.
   *
   * Detects the namespace from the name itself, checks the cache, then
   * falls back to an on-chain lookup and stores the result.
   *
   * @param name - Wallet name such as `vitalik.eth` or `bonfida.sol`
   * @returns Effect containing the resolution result
   * @errors WalletNameResolutionError - Unsupported name, name without an address, or RPC failure
   * @errors PersistenceError - Cache read/write failure
   */
  readonly resolve: (
    name: string
  ) => Effect.Effect<WalletNameResolution, WalletNameResolutionError | PersistenceError>
}

/**
 * WalletNameResolutionService - Context.Tag for dependency injection
 */
export class WalletNameResolutionService extends Context.Service<
  WalletNameResolutionService,
  WalletNameResolutionServiceShape
>()("WalletNameResolutionService") {}
