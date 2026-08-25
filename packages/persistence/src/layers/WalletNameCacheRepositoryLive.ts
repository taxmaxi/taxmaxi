/**
 * WalletNameCacheRepositoryLive - Wallet name cache backed by PostgreSQL.
 *
 * Stores wallet name resolutions in the wallet_name_cache table, keyed by
 * name-service namespace and lowercased, trimmed name.
 *
 * @module WalletNameCacheRepositoryLive
 */

import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { walletNameCache } from "../schema/WalletNameCacheTable.ts"
import {
  WalletNameCacheRepository,
  type WalletNameCacheRepositoryShape,
} from "../services/WalletNameCacheRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const get: WalletNameCacheRepositoryShape["get"] = ({ name, namespace }) =>
    Effect.gen(function* () {
      const now = new Date()
      const [cached] = yield* db
        .select({
          resolvedAddress: walletNameCache.resolvedAddress,
          expiresAt: walletNameCache.expiresAt,
        })
        .from(walletNameCache)
        .where(and(eq(walletNameCache.namespace, namespace), eq(walletNameCache.name, name)))
        .pipe(wrapSqlError("getWalletNameCacheEntry"))

      return cached && cached.expiresAt > now ? cached.resolvedAddress : null
    })

  const upsert: WalletNameCacheRepositoryShape["upsert"] = ({
    expiresAt,
    name,
    namespace,
    resolvedAddress,
  }) =>
    Effect.gen(function* () {
      const now = new Date()

      yield* db
        .insert(walletNameCache)
        .values({
          namespace,
          name,
          resolvedAddress,
          resolvedAt: now,
          expiresAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [walletNameCache.namespace, walletNameCache.name],
          set: {
            resolvedAddress,
            resolvedAt: now,
            expiresAt,
            updatedAt: now,
          },
        })
        .pipe(wrapSqlError("upsertWalletNameCacheEntry"))
    })

  return {
    get,
    upsert,
  } satisfies WalletNameCacheRepositoryShape
})

/**
 * WalletNameCacheRepositoryLive - Layer providing the live implementation
 */
export const WalletNameCacheRepositoryLive = Layer.effect(WalletNameCacheRepository, make)
