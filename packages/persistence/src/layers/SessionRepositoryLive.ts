import { eq, lte } from "drizzle-orm"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AuthUserId, Session, SessionId, UserAgent } from "@my/core/authentication"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { EntityNotFoundError, wrapSqlError } from "../errors/RepositoryError.ts"
import { sessions, type SessionRow } from "../schema/SessionsTable.ts"
import { SessionRepository, type SessionRepositoryService } from "../services/SessionRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedSessionRow = Pick<SessionRow, "id" | "provider" | "expiresAt" | "createdAt"> & {
  readonly userId: string
}

const rowToSession = (row: SelectedSessionRow): Session =>
  Session.make({
    id: SessionId.make(row.id),
    userId: AuthUserId.make(row.userId),
    provider: row.provider,
    expiresAt: Timestamp.make({ epochMillis: row.expiresAt.getTime() }),
    createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
    userAgent: Option.none<UserAgent>(),
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSessionFields = {
    id: sessions.id,
    userId: sessions.userId,
    provider: sessions.provider,
    expiresAt: sessions.expiresAt,
    createdAt: sessions.createdAt,
  } as const

  const findById: SessionRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db.select(selectSessionFields).from(sessions).where(eq(sessions.id, id))

      if (!row || row.userId === null) {
        return Option.none()
      }

      return Option.some(
        rowToSession({
          id: row.id,
          userId: row.userId,
          provider: row.provider,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
        })
      )
    }).pipe(wrapSqlError("findById"))

  const findByUserId: SessionRepositoryService["findByUserId"] = (userId) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select(selectSessionFields)
        .from(sessions)
        .where(eq(sessions.userId, userId))

      const mapped: Session[] = []
      for (const row of rows) {
        if (row.userId === null) {
          continue
        }

        mapped.push(
          rowToSession({
            id: row.id,
            userId: row.userId,
            provider: row.provider,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
          })
        )
      }

      return Chunk.fromIterable(mapped)
    }).pipe(wrapSqlError("findByUserId"))

  const create: SessionRepositoryService["create"] = (session) =>
    Effect.gen(function* () {
      const now = new Date()
      yield* db.insert(sessions).values({
        id: session.id,
        userId: session.userId,
        provider: session.provider,
        expiresAt: session.expiresAt.toDate(),
        createdAt: now,
      })

      return Session.make({
        id: session.id,
        userId: session.userId,
        provider: session.provider,
        expiresAt: session.expiresAt,
        createdAt: Timestamp.make({ epochMillis: now.getTime() }),
        userAgent: session.userAgent,
      })
    }).pipe(wrapSqlError("create"))

  const deleteSession: SessionRepositoryService["delete"] = (id) =>
    db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .pipe(
        Effect.map(() => undefined),
        wrapSqlError("delete")
      )

  const deleteExpired: SessionRepositoryService["deleteExpired"] = () =>
    Effect.gen(function* () {
      const now = new Date()
      const deleted = yield* db
        .delete(sessions)
        .where(lte(sessions.expiresAt, now))
        .returning({ id: sessions.id })
      return deleted.length
    }).pipe(wrapSqlError("deleteExpired"))

  const deleteByUserId: SessionRepositoryService["deleteByUserId"] = (userId) =>
    Effect.gen(function* () {
      const deleted = yield* db
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id })
      return deleted.length
    }).pipe(wrapSqlError("deleteByUserId"))

  const updateExpiry: SessionRepositoryService["updateExpiry"] = (id, expiresAt) =>
    Effect.gen(function* () {
      const updated = yield* db
        .update(sessions)
        .set({ expiresAt: expiresAt.toDate() })
        .where(eq(sessions.id, id))
        .returning({ id: sessions.id })

      if (updated.length === 0) {
        return yield* Effect.fail(new EntityNotFoundError({ entityType: "Session", entityId: id }))
      }

      const maybeSession = yield* findById(id)
      return yield* Option.match(maybeSession, {
        onNone: () => Effect.fail(new EntityNotFoundError({ entityType: "Session", entityId: id })),
        onSome: Effect.succeed,
      })
    }).pipe(wrapSqlError("updateExpiry"))

  return {
    findById,
    findByUserId,
    create,
    delete: deleteSession,
    deleteExpired,
    deleteByUserId,
    updateExpiry,
  } satisfies SessionRepositoryService
})

export const SessionRepositoryLive = Layer.effect(SessionRepository, make)
