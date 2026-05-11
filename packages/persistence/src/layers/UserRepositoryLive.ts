import { and, asc, eq, ilike } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AuthUser,
  AuthUserId,
  Email,
  inferDisplayNameFromEmail,
  type AuthProviderType,
  type UserRole,
} from "@my/core/authentication"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { EntityNotFoundError, wrapSqlError } from "../errors/RepositoryError.ts"
import { identities } from "../schema/IdentitiesTable.ts"
import { users, type UserRow } from "../schema/UsersTable.ts"
import { UserRepository, type UserRepositoryService } from "../services/UserRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedUserRow = Pick<
  UserRow,
  | "id"
  | "email"
  | "emailVerified"
  | "name"
  | "role"
  | "googleUserId"
  | "passwordHash"
  | "createdAt"
  | "updatedAt"
>

const toAuthRole = (role: "user" | "admin"): UserRole => (role === "admin" ? "admin" : "member")

const fromAuthRole = (role: UserRole): "user" | "admin" => (role === "admin" ? "admin" : "user")

const toPrimaryProviderFromLegacyUserColumns = (
  row: Pick<SelectedUserRow, "googleUserId" | "passwordHash">
): AuthProviderType => {
  if (row.googleUserId !== null) {
    return "google"
  }

  if (row.passwordHash !== null) {
    return "local"
  }

  return "local"
}

const toDisplayName = ({
  email,
  name,
}: {
  readonly email: Email
  readonly name: string | null
}): string => {
  const trimmedName = name?.trim()
  if (trimmedName && trimmedName.length > 0) {
    return trimmedName
  }
  return inferDisplayNameFromEmail(email)
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectAuthUserFields = {
    id: users.id,
    email: users.email,
    emailVerified: users.emailVerified,
    name: users.name,
    role: users.role,
    googleUserId: users.googleUserId,
    passwordHash: users.passwordHash,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  } as const

  const getPrimaryProviderFromIdentity = (userId: AuthUserId) =>
    Effect.gen(function* () {
      const [identity] = yield* db
        .select({ provider: identities.provider })
        .from(identities)
        .where(eq(identities.userId, userId))
        .orderBy(asc(identities.createdAt))
      return Option.fromNullable(identity).pipe(Option.map((value) => value.provider))
    })

  const rowToAuthUserWithPrimaryProvider = (row: SelectedUserRow) =>
    Effect.gen(function* () {
      const userId = AuthUserId.make(row.id)
      const email = Email.make(row.email)
      const identityProvider = yield* getPrimaryProviderFromIdentity(userId)

      const primaryProvider = Option.match(identityProvider, {
        onNone: () => toPrimaryProviderFromLegacyUserColumns(row),
        onSome: (provider) => provider,
      })

      return AuthUser.make({
        id: userId,
        email,
        displayName: toDisplayName({ email, name: row.name }),
        role: toAuthRole(row.role),
        primaryProvider,
        emailVerified: row.emailVerified,
        createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
        updatedAt: Timestamp.make({ epochMillis: row.updatedAt.getTime() }),
      })
    })

  const findById: UserRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db.select(selectAuthUserFields).from(users).where(eq(users.id, id))

      if (row === undefined) {
        return Option.none<AuthUser>()
      }

      const user = yield* rowToAuthUserWithPrimaryProvider(row)
      return Option.some(user)
    }).pipe(wrapSqlError("findById"))

  const findByEmail: UserRepositoryService["findByEmail"] = (email) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectAuthUserFields)
        .from(users)
        .where(ilike(users.email, email))

      if (row === undefined) {
        return Option.none<AuthUser>()
      }

      const user = yield* rowToAuthUserWithPrimaryProvider(row)
      return Option.some(user)
    }).pipe(wrapSqlError("findByEmail"))

  const create: UserRepositoryService["create"] = (user) =>
    Effect.gen(function* () {
      const now = new Date()

      const [created] = yield* db
        .insert(users)
        .values({
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          name: user.displayName,
          role: fromAuthRole(user.role),
          googleUserId: user.primaryProvider === "google" ? user.id : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(selectAuthUserFields)

      if (!created) {
        return yield* Effect.fail(
          new EntityNotFoundError({ entityType: "AuthUser", entityId: user.id })
        )
      }

      return yield* rowToAuthUserWithPrimaryProvider(created)
    }).pipe(wrapSqlError("create"))

  const update: UserRepositoryService["update"] = (id, data) =>
    Effect.gen(function* () {
      const updateSet: {
        readonly email?: string
        readonly name?: string
        readonly role?: "user" | "admin"
        readonly googleUserId?: string | null
        readonly emailVerified?: boolean
        readonly updatedAt: Date
      } = {
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.displayName !== undefined ? { name: data.displayName } : {}),
        ...(data.role !== undefined ? { role: fromAuthRole(data.role) } : {}),
        ...(data.emailVerified !== undefined ? { emailVerified: data.emailVerified } : {}),
        ...(data.primaryProvider !== undefined
          ? { googleUserId: data.primaryProvider === "google" ? id : null }
          : {}),
        updatedAt: new Date(),
      }

      const [updated] = yield* db
        .update(users)
        .set(updateSet)
        .where(eq(users.id, id))
        .returning(selectAuthUserFields)

      if (!updated) {
        return yield* Effect.fail(new EntityNotFoundError({ entityType: "AuthUser", entityId: id }))
      }

      return yield* rowToAuthUserWithPrimaryProvider(updated)
    }).pipe(wrapSqlError("update"))

  const deleteUser: UserRepositoryService["delete"] = (id) =>
    Effect.gen(function* () {
      const [deleted] = yield* db.delete(users).where(eq(users.id, id)).returning({ id: users.id })

      if (!deleted) {
        return yield* Effect.fail(new EntityNotFoundError({ entityType: "AuthUser", entityId: id }))
      }
    }).pipe(wrapSqlError("delete"))

  const findPlatformAdmins: UserRepositoryService["findPlatformAdmins"] = () =>
    Effect.gen(function* () {
      const rows = yield* db
        .select(selectAuthUserFields)
        .from(users)
        .where(eq(users.role, "admin"))
        .orderBy(asc(users.email))

      return yield* Effect.forEach(rows, rowToAuthUserWithPrimaryProvider)
    }).pipe(wrapSqlError("findPlatformAdmins"))

  const isPlatformAdmin: UserRepositoryService["isPlatformAdmin"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, id), eq(users.role, "admin")))
      return row !== undefined
    }).pipe(wrapSqlError("isPlatformAdmin"))

  return {
    findById,
    findByEmail,
    create,
    update,
    delete: deleteUser,
    findPlatformAdmins,
    isPlatformAdmin,
  } satisfies UserRepositoryService
})

export const UserRepositoryLive = Layer.effect(UserRepository, make)
