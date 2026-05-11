/**
 * CexAccountRepositoryLive - Drizzle-backed cex_account repository
 *
 * Provides idempotent provisioning for exchange credential containers used by
 * source creation flows after OAuth callbacks.
 *
 * @module CexAccountRepositoryLive
 */

import { and, eq, ilike } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EntityNotFoundError, wrapSqlError } from "../errors/RepositoryError.ts"
import { cexAccount, type CexAccount } from "../schema/CexAccountTable.ts"
import { cex } from "../schema/CexTable.ts"
import {
  CexAccountRepository,
  type CexAccountRecord,
  type CexAccountRepositoryService,
} from "../services/CexAccountRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedCexAccountRow = Pick<
  CexAccount,
  "id" | "cexId" | "userId" | "providerUserId" | "providerAccountId"
>

const rowToCexAccountRecord = (row: SelectedCexAccountRow): CexAccountRecord => ({
  id: row.id,
  cexId: row.cexId,
  userId: row.userId,
  providerUserId: row.providerUserId,
  providerAccountId: row.providerAccountId,
})

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectCexAccountFields = {
    id: cexAccount.id,
    cexId: cexAccount.cexId,
    userId: cexAccount.userId,
    providerUserId: cexAccount.providerUserId,
    providerAccountId: cexAccount.providerAccountId,
  } as const

  const ensureForProviderWithOAuthCredentials: CexAccountRepositoryService["ensureForProviderWithOAuthCredentials"] =
    (params) =>
      Effect.gen(function* () {
        const [exchange] = yield* db
          .select({ id: cex.id })
          .from(cex)
          .where(ilike(cex.name, params.cexName))
          .limit(1)

        if (exchange === undefined) {
          return yield* Effect.fail(
            new EntityNotFoundError({ entityType: "Cex", entityId: params.cexName })
          )
        }

        const credentialsUpdatedAt = new Date()
        const expiresAt = new Date(params.oauthCredentials.expiresAtEpochMillis)

        const [existing] = yield* db
          .select(selectCexAccountFields)
          .from(cexAccount)
          .where(
            and(
              eq(cexAccount.userId, params.userId),
              eq(cexAccount.cexId, exchange.id),
              eq(cexAccount.providerUserId, params.providerUserId)
            )
          )
          .limit(1)

        if (existing !== undefined) {
          const [updatedExisting] = yield* db
            .update(cexAccount)
            .set({
              providerAccountId: params.providerAccountId ?? existing.providerAccountId,
              accessToken: params.oauthCredentials.accessToken,
              refreshToken: params.oauthCredentials.refreshToken,
              expiresAt,
              scopes: params.oauthCredentials.scopes,
              credentialsUpdatedAt,
            })
            .where(eq(cexAccount.id, existing.id))
            .returning(selectCexAccountFields)

          if (updatedExisting === undefined) {
            return yield* Effect.fail(
              new EntityNotFoundError({
                entityType: "CexAccount",
                entityId: existing.id,
              })
            )
          }

          return rowToCexAccountRecord(updatedExisting)
        }

        const [created] = yield* db
          .insert(cexAccount)
          .values({
            cexId: exchange.id,
            userId: params.userId,
            providerUserId: params.providerUserId,
            providerAccountId: params.providerAccountId ?? null,
            accessToken: params.oauthCredentials.accessToken,
            refreshToken: params.oauthCredentials.refreshToken,
            expiresAt,
            scopes: params.oauthCredentials.scopes,
            credentialsUpdatedAt,
          })
          .returning(selectCexAccountFields)

        if (created === undefined) {
          return yield* Effect.fail(
            new EntityNotFoundError({
              entityType: "CexAccount",
              entityId: `${params.userId}:${params.cexName}:${params.providerUserId}`,
            })
          )
        }

        return rowToCexAccountRecord(created)
      }).pipe(wrapSqlError("ensureForProviderWithOAuthCredentials"))

  return {
    ensureForProviderWithOAuthCredentials,
  } satisfies CexAccountRepositoryService
})

/**
 * CexAccountRepositoryLive - Live layer for cex account provisioning.
 */
export const CexAccountRepositoryLive = Layer.effect(CexAccountRepository, make)
