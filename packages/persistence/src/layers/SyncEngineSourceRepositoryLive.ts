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
    principalId,
    sourceId,
  }) =>
    Effect.gen(function* () {
      const [source] = yield* db
        .select({
          id: schema.sources.id,
          principalId: schema.sources.principalId,
          providerKey: schema.sources.providerKey,
          cexAccountId: schema.sources.cexAccountId,
          addressId: schema.sources.addressId,
          walletAddress: schema.addresses.address,
        })
        .from(schema.sources)
        .leftJoin(
          schema.addresses,
          and(
            eq(schema.addresses.id, schema.sources.addressId),
            eq(schema.addresses.principalId, schema.sources.principalId)
          )
        )
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.principalId, principalId)))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("syncEngineSourceRepository.findOwnedSourceSyncContext"))

      return Option.fromNullable(source)
    })

  const listPrincipalSourceSyncContexts: SourceRepositoryShape["listPrincipalSourceSyncContexts"] =
    ({ principalId }) =>
      db
        .select({
          id: schema.sources.id,
          principalId: schema.sources.principalId,
          providerKey: schema.sources.providerKey,
          cexAccountId: schema.sources.cexAccountId,
          addressId: schema.sources.addressId,
          walletAddress: schema.addresses.address,
        })
        .from(schema.sources)
        .leftJoin(
          schema.addresses,
          and(
            eq(schema.addresses.id, schema.sources.addressId),
            eq(schema.addresses.principalId, schema.sources.principalId)
          )
        )
        .where(eq(schema.sources.principalId, principalId))
        .pipe(wrapSyncEngineSqlError("syncEngineSourceRepository.listPrincipalSourceSyncContexts"))

  return SourceRepository.of({
    findOwnedSourceSyncContext,
    listPrincipalSourceSyncContexts,
  } satisfies SourceRepositoryShape)
})

export const SyncEngineSourceRepositoryLive = Layer.effect(SourceRepository, make)
