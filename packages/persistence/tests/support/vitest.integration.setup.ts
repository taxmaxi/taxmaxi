import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { TestProject } from "vitest/node"
import {
  makePgClientLayer,
  runDrizzleMigrations,
  runSqlUnsafe,
} from "../../src/layers/PgClientLive.ts"
import { seedData } from "../../src/seed/data.ts"
import {
  makeIntegrationTestDatabaseRunMarker,
  makeTestDatabaseTemplateName,
} from "./test-database-name.ts"

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll(`"`, `""`)}"`

const getDatabaseConfig = Effect.gen(function* () {
  const host = yield* Config.string("PGHOST").pipe(Config.withDefault("localhost"))
  const port = yield* Config.int("PGPORT").pipe(Config.withDefault(5432))
  const user = yield* Config.string("PGUSER").pipe(Config.withDefault("postgres"))
  const password = yield* Config.redacted("PGPASSWORD").pipe(
    Config.withDefault(Redacted.make("postgres"))
  )

  return { host, port, user, password } as const
})

export const prepareTemplateDatabase = <E, R, R2>({
  cleanupTemplate,
  prepareTemplate,
}: {
  readonly cleanupTemplate: Effect.Effect<void, never, R2>
  readonly prepareTemplate: Effect.Effect<void, E, R>
}) => prepareTemplate.pipe(Effect.onError(() => cleanupTemplate))

export const cleanupIntegrationTestDatabases = <E, R>({
  databaseNames,
  cleanupDatabase,
}: {
  readonly databaseNames: ReadonlyArray<string>
  readonly cleanupDatabase: (databaseName: string) => Effect.Effect<void, E, R>
}) => Effect.forEach(databaseNames, cleanupDatabase, { discard: true })

export const setup = async (project: TestProject) => {
  const testRunId = randomUUID()
  const integrationTestDatabaseRunMarker = makeIntegrationTestDatabaseRunMarker({ testRunId })
  const migratedTestDatabaseTemplateName = makeTestDatabaseTemplateName({ testRunId })
  project.provide("integrationTestRunId", testRunId)

  const { host, port, user, password } = Effect.runSync(getDatabaseConfig)
  const passwordValue = Redacted.value(password)
  const adminDatabaseUrl = Redacted.make(
    `postgresql://${user}:${passwordValue}@${host}:${port}/postgres`
  )
  const templateDatabaseUrl = Redacted.make(
    `postgresql://${user}:${passwordValue}@${host}:${port}/${migratedTestDatabaseTemplateName}`
  )
  const AdminPgClientLive = makePgClientLayer({
    url: adminDatabaseUrl,
    maxConnections: 2,
  })
  const TemplatePgClientLive = makePgClientLayer({
    url: templateDatabaseUrl,
  })

  const executeAdminSql = ({
    statement,
    params,
  }: {
    readonly statement: string
    readonly params?: ReadonlyArray<unknown>
  }) =>
    runSqlUnsafe(params === undefined ? { statement } : { statement, params }).pipe(Effect.asVoid)

  const terminateDatabaseConnections = ({ databaseName }: { readonly databaseName: string }) =>
    executeAdminSql({
      statement: `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      params: [databaseName],
    })

  const dropDatabase = ({ databaseName }: { readonly databaseName: string }) =>
    executeAdminSql({
      statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
    })

  const cleanupDatabase = (databaseName: string) =>
    Effect.gen(function* () {
      yield* terminateDatabaseConnections({ databaseName })
      yield* dropDatabase({ databaseName })
    })

  const listIntegrationTestDatabaseNames = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* sql<{ readonly databaseName: string }>`
      SELECT datname AS "databaseName"
      FROM pg_database
      WHERE strpos(datname, ${integrationTestDatabaseRunMarker}) > 0
      ORDER BY datname
    `

    return rows.map((row) => row.databaseName)
  })

  const cleanupTemplate = cleanupDatabase(migratedTestDatabaseTemplateName).pipe(Effect.orDie)

  const prepareTemplate = Effect.gen(function* () {
    yield* cleanupDatabase(migratedTestDatabaseTemplateName)
    yield* executeAdminSql({
      statement: `CREATE DATABASE ${quoteIdentifier(migratedTestDatabaseTemplateName)}`,
    })
    yield* runDrizzleMigrations().pipe(Effect.provide(TemplatePgClientLive), Effect.scoped)
    yield* seedData.pipe(Effect.provide(TemplatePgClientLive), Effect.scoped)
    yield* terminateDatabaseConnections({ databaseName: migratedTestDatabaseTemplateName })
  })

  await Effect.runPromise(
    prepareTemplateDatabase({ cleanupTemplate, prepareTemplate }).pipe(
      Effect.provide(AdminPgClientLive),
      Effect.scoped
    )
  )

  return async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const databaseNames = yield* listIntegrationTestDatabaseNames
        yield* cleanupIntegrationTestDatabases({ databaseNames, cleanupDatabase })
        yield* cleanupTemplate
      }).pipe(Effect.provide(AdminPgClientLive), Effect.scoped)
    )
  }
}
