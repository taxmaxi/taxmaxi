/**
 * CoinbaseCredentialRepositoryLive - Persistence-backed Coinbase credential storage.
 *
 * @module CoinbaseCredentialRepositoryLive
 */

import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CoinbaseCredentialRepository,
  type CoinbaseCredentialRepositoryShape,
} from "@my/sync-engine/providers/coinbase"
import { drizzle } from "./PgClientLive.ts"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findSourceCredentials: CoinbaseCredentialRepositoryShape["findSourceCredentials"] = ({
    sourceId,
  }) =>
    Effect.gen(function* () {
      const [sourceAccount] = yield* db
        .select({
          cexAccountId: schema.cexAccount.id,
          accessToken: schema.cexAccount.accessToken,
          refreshToken: schema.cexAccount.refreshToken,
          expiresAt: schema.cexAccount.expiresAt,
        })
        .from(schema.sources)
        .leftJoin(schema.cexAccount, eq(schema.sources.cexAccountId, schema.cexAccount.id))
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.providerKey, "coinbase")))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("coinbaseCredentialRepository.findSourceCredentials"))

      if (sourceAccount === undefined || sourceAccount.cexAccountId === null) {
        return null
      }

      return {
        cexAccountId: sourceAccount.cexAccountId,
        accessToken: sourceAccount.accessToken,
        refreshToken: sourceAccount.refreshToken,
        expiresAt: sourceAccount.expiresAt,
      }
    })

  const updateSourceCredentials: CoinbaseCredentialRepositoryShape["updateSourceCredentials"] = ({
    cexAccountId,
    accessToken,
    refreshToken,
    expiresAt,
    scopes,
  }) =>
    db
      .update(schema.cexAccount)
      .set({
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        credentialsUpdatedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(eq(schema.cexAccount.id, cexAccountId))
      .pipe(
        wrapSyncEngineSqlError("coinbaseCredentialRepository.updateSourceCredentials"),
        Effect.asVoid
      )

  return CoinbaseCredentialRepository.of({
    findSourceCredentials,
    updateSourceCredentials,
  } satisfies CoinbaseCredentialRepositoryShape)
})

export const CoinbaseCredentialRepositoryLive = Layer.effect(CoinbaseCredentialRepository, make)
