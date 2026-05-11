import { and, eq } from "drizzle-orm"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AuthUserId,
  HashedPassword,
  ProviderId,
  ProviderData,
  UserIdentity,
  UserIdentityId,
} from "@my/core/authentication"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { EntityNotFoundError, wrapSqlError } from "../errors/RepositoryError.ts"
import { identities, type IdentityRow } from "../schema/IdentitiesTable.ts"
import {
  IdentityRepository,
  type IdentityRepositoryService,
} from "../services/IdentityRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedIdentityRow = Pick<
  IdentityRow,
  "id" | "userId" | "provider" | "providerId" | "providerData" | "createdAt"
>

const rowToUserIdentity = (row: SelectedIdentityRow): UserIdentity =>
  UserIdentity.make({
    id: UserIdentityId.make(row.id),
    userId: AuthUserId.make(row.userId),
    provider: row.provider,
    providerId: ProviderId.make(row.providerId),
    providerData: Option.fromNullable(row.providerData).pipe(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONB from DB is typed as unknown but validated on write
      Option.map((data) => ProviderData.make(data as typeof ProviderData.Type))
    ),
    createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectIdentityFields = {
    id: identities.id,
    userId: identities.userId,
    provider: identities.provider,
    providerId: identities.providerId,
    providerData: identities.providerData,
    createdAt: identities.createdAt,
  } as const

  const findById: IdentityRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectIdentityFields)
        .from(identities)
        .where(eq(identities.id, id))
      return Option.fromNullable(row).pipe(Option.map(rowToUserIdentity))
    }).pipe(wrapSqlError("findById"))

  const findByUserId: IdentityRepositoryService["findByUserId"] = (userId) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select(selectIdentityFields)
        .from(identities)
        .where(eq(identities.userId, userId))
      return Chunk.fromIterable(rows.map(rowToUserIdentity))
    }).pipe(wrapSqlError("findByUserId"))

  const findByProvider: IdentityRepositoryService["findByProvider"] = (provider, providerId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectIdentityFields)
        .from(identities)
        .where(and(eq(identities.provider, provider), eq(identities.providerId, providerId)))
      return Option.fromNullable(row).pipe(Option.map(rowToUserIdentity))
    }).pipe(wrapSqlError("findByProvider"))

  const findByUserAndProvider: IdentityRepositoryService["findByUserAndProvider"] = (
    userId,
    provider
  ) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectIdentityFields)
        .from(identities)
        .where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
      return Option.fromNullable(row).pipe(Option.map(rowToUserIdentity))
    }).pipe(wrapSqlError("findByUserAndProvider"))

  const create: IdentityRepositoryService["create"] = (identity) =>
    Effect.gen(function* () {
      const now = new Date()
      const providerDataValue = Option.match(identity.providerData, {
        onNone: () => null,
        onSome: (data) => data,
      })
      const passwordHash = identity.passwordHash ?? null

      yield* db.insert(identities).values({
        id: identity.id,
        userId: identity.userId,
        provider: identity.provider,
        providerId: identity.providerId,
        passwordHash,
        providerData: providerDataValue,
        createdAt: now,
      })

      return UserIdentity.make({
        id: identity.id,
        userId: identity.userId,
        provider: identity.provider,
        providerId: identity.providerId,
        providerData: identity.providerData,
        createdAt: Timestamp.make({ epochMillis: now.getTime() }),
      })
    }).pipe(wrapSqlError("create"))

  const update: IdentityRepositoryService["update"] = (id, data) =>
    Effect.gen(function* () {
      if (data.providerData !== undefined) {
        const providerDataValue = Option.match(data.providerData, {
          onNone: () => null,
          onSome: (pd) => pd,
        })
        const updated = yield* db
          .update(identities)
          .set({ providerData: providerDataValue })
          .where(eq(identities.id, id))
          .returning({ id: identities.id })

        if (updated.length === 0) {
          return yield* Effect.fail(
            new EntityNotFoundError({ entityType: "UserIdentity", entityId: id })
          )
        }
      } else {
        const existing = yield* findById(id)
        if (Option.isNone(existing)) {
          return yield* Effect.fail(
            new EntityNotFoundError({ entityType: "UserIdentity", entityId: id })
          )
        }
      }

      const maybeIdentity = yield* findById(id)
      return yield* Option.match(maybeIdentity, {
        onNone: () =>
          Effect.fail(new EntityNotFoundError({ entityType: "UserIdentity", entityId: id })),
        onSome: Effect.succeed,
      })
    }).pipe(wrapSqlError("update"))

  const deleteIdentity: IdentityRepositoryService["delete"] = (id) =>
    db
      .delete(identities)
      .where(eq(identities.id, id))
      .pipe(
        Effect.map(() => undefined),
        wrapSqlError("delete")
      )

  const deleteByUserId: IdentityRepositoryService["deleteByUserId"] = (userId) =>
    Effect.gen(function* () {
      const deleted = yield* db
        .delete(identities)
        .where(eq(identities.userId, userId))
        .returning({ id: identities.id })
      return deleted.length
    }).pipe(wrapSqlError("deleteByUserId"))

  const getPasswordHash: IdentityRepositoryService["getPasswordHash"] = (provider, providerId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ passwordHash: identities.passwordHash })
        .from(identities)
        .where(and(eq(identities.provider, provider), eq(identities.providerId, providerId)))

      return Option.fromNullable(row).pipe(
        Option.flatMap((result) => Option.fromNullable(result.passwordHash)),
        Option.map((hash) => HashedPassword.make(hash))
      )
    }).pipe(wrapSqlError("getPasswordHash"))

  const updatePasswordHash: IdentityRepositoryService["updatePasswordHash"] = (
    provider,
    providerId,
    newPasswordHash
  ) =>
    Effect.gen(function* () {
      const updated = yield* db
        .update(identities)
        .set({ passwordHash: newPasswordHash })
        .where(and(eq(identities.provider, provider), eq(identities.providerId, providerId)))
        .returning({ id: identities.id })

      if (updated.length === 0) {
        return yield* Effect.fail(
          new EntityNotFoundError({
            entityType: "UserIdentity",
            entityId: `${provider}:${providerId}`,
          })
        )
      }
    }).pipe(wrapSqlError("updatePasswordHash"))

  return {
    findById,
    findByUserId,
    findByProvider,
    findByUserAndProvider,
    create,
    update,
    delete: deleteIdentity,
    deleteByUserId,
    getPasswordHash,
    updatePasswordHash,
  } satisfies IdentityRepositoryService
})

export const IdentityRepositoryLive = Layer.effect(IdentityRepository, make)
