/**
 * SyncEngineSourceRepositoryLive - Source visibility lookup for sync-engine entrypoints.
 *
 * @module SyncEngineSourceRepositoryLive
 */

import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { SourceRepository, type SourceRepositoryShape } from "@my/sync-engine/services"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findOwnedSourceSyncContext: SourceRepositoryShape["findOwnedSourceSyncContext"] = ({
    userId,
    sourceId,
  }) =>
    Effect.gen(function* () {
      const [source] = yield* db
        .select({
          id: schema.sources.id,
          userId: schema.sources.userId,
          providerKey: schema.sources.providerKey,
          cexAccountId: schema.sources.cexAccountId,
          addressId: schema.sources.addressId,
        })
        .from(schema.sources)
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("syncEngineSourceRepository.findOwnedSourceSyncContext"))

      return Option.fromNullable(source)
    })

  const listUserSourceSyncContexts: SourceRepositoryShape["listUserSourceSyncContexts"] = ({
    userId,
  }) =>
    db
      .select({
        id: schema.sources.id,
        userId: schema.sources.userId,
        providerKey: schema.sources.providerKey,
        cexAccountId: schema.sources.cexAccountId,
        addressId: schema.sources.addressId,
      })
      .from(schema.sources)
      .where(eq(schema.sources.userId, userId))
      .pipe(wrapSyncEngineSqlError("syncEngineSourceRepository.listUserSourceSyncContexts"))

  return SourceRepository.of({
    findOwnedSourceSyncContext,
    listUserSourceSyncContexts,
  } satisfies SourceRepositoryShape)
})

export const SyncEngineSourceRepositoryLive = Layer.effect(SourceRepository, make)
