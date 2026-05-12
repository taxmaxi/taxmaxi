/**
 * PrincipalRepositoryLive - Postgres-backed ownership principal repository.
 *
 * @module PrincipalRepositoryLive
 */

import { eq } from "drizzle-orm"
import { AuthUserId } from "@my/core/authentication"
import { PrincipalId } from "@my/core/ownership"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PrincipalRepository,
  type Principal,
  type PrincipalRepositoryService,
} from "../services/PrincipalRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const selectPrincipalFields = {
  id: schema.principals.id,
  kind: schema.principals.kind,
  userId: schema.principals.userId,
} as const

type SelectedPrincipalRow = {
  readonly id: string
  readonly kind: Principal["kind"]
  readonly userId: string | null
}

const rowToPrincipal = (row: SelectedPrincipalRow): Principal => ({
  id: PrincipalId.make(row.id),
  kind: row.kind,
  userId: row.userId === null ? null : AuthUserId.make(row.userId),
})

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findUserPrincipal: PrincipalRepositoryService["findUserPrincipal"] = (userId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectPrincipalFields)
        .from(schema.principals)
        .where(eq(schema.principals.userId, userId))
        .limit(1)

      return Option.fromNullable(row).pipe(Option.map(rowToPrincipal))
    }).pipe(wrapSqlError("principalRepository.findUserPrincipal"))

  const createUserPrincipal: PrincipalRepositoryService["createUserPrincipal"] = (userId) =>
    Effect.gen(function* () {
      const now = new Date()
      const [row] = yield* db
        .insert(schema.principals)
        .values({
          kind: "user",
          userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.principals.userId,
          set: { updatedAt: now },
        })
        .returning(selectPrincipalFields)

      if (row === undefined) {
        return yield* Effect.fail(
          new PersistenceError({
            operation: "principalRepository.createUserPrincipal",
            cause: "failed to create user principal",
          })
        )
      }

      return rowToPrincipal(row)
    }).pipe(wrapSqlError("principalRepository.createUserPrincipal"))

  const createAnonymousWalletPrincipal: PrincipalRepositoryService["createAnonymousWalletPrincipal"] =
    () =>
      Effect.gen(function* () {
        const now = new Date()
        const [row] = yield* db
          .insert(schema.principals)
          .values({
            kind: "anonymous_wallet",
            userId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning(selectPrincipalFields)

        if (row === undefined) {
          return yield* Effect.fail(
            new PersistenceError({
              operation: "principalRepository.createAnonymousWalletPrincipal",
              cause: "failed to create anonymous wallet principal",
            })
          )
        }

        return rowToPrincipal(row)
      }).pipe(wrapSqlError("principalRepository.createAnonymousWalletPrincipal"))

  return PrincipalRepository.of({
    findUserPrincipal,
    createUserPrincipal,
    createAnonymousWalletPrincipal,
  } satisfies PrincipalRepositoryService)
})

/**
 * PrincipalRepositoryLive - Live ownership principal repository layer.
 */
export const PrincipalRepositoryLive = Layer.effect(PrincipalRepository, make)
