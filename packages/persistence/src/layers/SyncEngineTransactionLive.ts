/**
 * SyncEngineTransactionLive - PostgreSQL transaction boundary for repository orchestration.
 *
 * @module SyncEngineTransactionLive
 */

import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { SyncEngineStorageError, SyncEngineTransaction } from "@my/sync-engine/services"

const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  return SyncEngineTransaction.of({
    run: (effect) =>
      sql.withTransaction(effect).pipe(
        Effect.catchTag(
          "SqlError",
          (cause) =>
            new SyncEngineStorageError({
              operation: "syncEngineTransaction.run",
              cause,
            })
        )
      ),
  })
})

/** PostgreSQL-backed transaction boundary. */
export const SyncEngineTransactionLive = Layer.effect(SyncEngineTransaction, make)
