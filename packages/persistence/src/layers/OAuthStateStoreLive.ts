/**
 * OAuthStateStoreLive - PostgreSQL-backed OAuth state repository
 *
 * Persists one-time OAuth state records for login/link callback validation.
 * State records are consumed atomically to prevent replay.
 *
 * @module OAuthStateStoreLive
 */

import { and, eq, gt, isNull, lte } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AuthUserId } from "@my/core/authentication"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { oauthStates } from "../schema/OAuthStatesTable.ts"
import { OAuthStateStore, type OAuthStateStoreService } from "../services/OAuthStateStore.ts"
import { drizzle } from "./PgClientLive.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  /**
   * Insert a new OAuth state record
   */
  const create: OAuthStateStoreService["create"] = (record) =>
    db
      .insert(oauthStates)
      .values({
        state: record.state,
        intent: record.intent,
        provider: record.provider,
        userId: Option.getOrNull(record.userId),
        redirectUri: record.redirectUri,
        expiresAt: record.expiresAt.toDate(),
        status: record.status,
        sessionToken: Option.getOrNull(record.sessionToken),
        statusMessage: Option.getOrNull(record.statusMessage),
        completedAt: Option.match(record.completedAt, {
          onNone: () => null,
          onSome: (value) => value.toDate(),
        }),
        consumedAt: Option.match(record.consumedAt, {
          onNone: () => null,
          onSome: (value) => value.toDate(),
        }),
      })
      .pipe(Effect.asVoid, wrapSqlError("create"))

  const mapRow = (row: {
    state: string
    intent: "login" | "link"
    provider: "local" | "google" | "coinbase"
    userId: string | null
    redirectUri: string
    expiresAt: Date
    status: "pending" | "completed" | "failed"
    sessionToken: string | null
    statusMessage: string | null
    completedAt: Date | null
    consumedAt: Date | null
  }) => ({
    state: row.state,
    intent: row.intent,
    provider: row.provider,
    userId: Option.fromNullable(row.userId).pipe(Option.map((id) => AuthUserId.make(id))),
    redirectUri: row.redirectUri,
    expiresAt: Timestamp.make({ epochMillis: row.expiresAt.getTime() }),
    status: row.status,
    sessionToken: Option.fromNullable(row.sessionToken),
    statusMessage: Option.fromNullable(row.statusMessage),
    completedAt: Option.fromNullable(row.completedAt).pipe(
      Option.map((value) => Timestamp.make({ epochMillis: value.getTime() }))
    ),
    consumedAt: Option.fromNullable(row.consumedAt).pipe(
      Option.map((value) => Timestamp.make({ epochMillis: value.getTime() }))
    ),
  })

  /**
   * Consume a state token exactly once if present and not expired
   */
  const consume: OAuthStateStoreService["consume"] = (state) =>
    Effect.gen(function* () {
      const now = new Date()
      const [row] = yield* db
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthStates.state, state),
            gt(oauthStates.expiresAt, now),
            isNull(oauthStates.consumedAt)
          )
        )
        .returning({
          state: oauthStates.state,
          intent: oauthStates.intent,
          provider: oauthStates.provider,
          userId: oauthStates.userId,
          redirectUri: oauthStates.redirectUri,
          expiresAt: oauthStates.expiresAt,
          status: oauthStates.status,
          sessionToken: oauthStates.sessionToken,
          statusMessage: oauthStates.statusMessage,
          completedAt: oauthStates.completedAt,
          consumedAt: oauthStates.consumedAt,
        })

      if (row === undefined) {
        return Option.none()
      }

      return Option.some(mapRow(row))
    }).pipe(wrapSqlError("consume"))

  const get: OAuthStateStoreService["get"] = (state) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({
          state: oauthStates.state,
          intent: oauthStates.intent,
          provider: oauthStates.provider,
          userId: oauthStates.userId,
          redirectUri: oauthStates.redirectUri,
          expiresAt: oauthStates.expiresAt,
          status: oauthStates.status,
          sessionToken: oauthStates.sessionToken,
          statusMessage: oauthStates.statusMessage,
          completedAt: oauthStates.completedAt,
          consumedAt: oauthStates.consumedAt,
        })
        .from(oauthStates)
        .where(eq(oauthStates.state, state))
        .limit(1)

      if (row === undefined) {
        return Option.none()
      }

      return Option.some(mapRow(row))
    }).pipe(wrapSqlError("get"))

  const markCompleted: OAuthStateStoreService["markCompleted"] = (input) =>
    db
      .update(oauthStates)
      .set({
        status: "completed",
        sessionToken: input.sessionToken,
        userId: input.userId,
        statusMessage: Option.getOrNull(input.statusMessage),
        completedAt: input.completedAt.toDate(),
      })
      .where(eq(oauthStates.state, input.state))
      .pipe(Effect.asVoid, wrapSqlError("markCompleted"))

  const markFailed: OAuthStateStoreService["markFailed"] = (input) =>
    db
      .update(oauthStates)
      .set({
        status: "failed",
        statusMessage: input.statusMessage,
        completedAt: input.completedAt.toDate(),
      })
      .where(eq(oauthStates.state, input.state))
      .pipe(Effect.asVoid, wrapSqlError("markFailed"))

  /**
   * Delete all expired OAuth state records
   */
  const deleteExpired: OAuthStateStoreService["deleteExpired"] = () =>
    Effect.gen(function* () {
      const now = new Date()
      const deleted = yield* db
        .delete(oauthStates)
        .where(lte(oauthStates.expiresAt, now))
        .returning({ state: oauthStates.state })

      return deleted.length
    }).pipe(wrapSqlError("deleteExpired"))

  return {
    create,
    consume,
    get,
    markCompleted,
    markFailed,
    deleteExpired,
  } satisfies OAuthStateStoreService
})

export const OAuthStateStoreLive = Layer.effect(OAuthStateStore, make)
