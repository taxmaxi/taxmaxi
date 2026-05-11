import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import {
  makePgClientLayer,
  runDrizzleMigrations,
  runSqlUnsafe,
} from "../src/layers/PgClientLive.ts"
import { seedSolanaReferenceData } from "../src/seed/SolanaReferenceData.ts"

const TEMPLATE_DATABASE_NAME = "taxmaxi_template"

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll(`"`, `""`)}"`

const getDatabaseConfig = Effect.gen(function* () {
  const host = yield* Config.string("PGHOST").pipe(Config.withDefault("localhost"))
  const port = yield* Config.integer("PGPORT").pipe(Config.withDefault(5432))
  const user = yield* Config.string("PGUSER").pipe(Config.withDefault("postgres"))
  const password = yield* Config.redacted("PGPASSWORD").pipe(
    Config.withDefault(Redacted.make("postgres"))
  )

  return { host, port, user, password } as const
})

export const setup = async () => {
  const { host, port, user, password } = Effect.runSync(getDatabaseConfig)
  const passwordValue = Redacted.value(password)
  const adminDatabaseUrl = Redacted.make(
    `postgresql://${user}:${passwordValue}@${host}:${port}/postgres`
  )
  const templateDatabaseUrl = Redacted.make(
    `postgresql://${user}:${passwordValue}@${host}:${port}/${TEMPLATE_DATABASE_NAME}`
  )
  const AdminPgClientLive = makePgClientLayer({
    url: adminDatabaseUrl,
    maxConnections: 2,
  })
  const TemplatePgClientLive = makePgClientLayer({
    url: templateDatabaseUrl,
  })

  const runAdminSql = ({
    statement,
    params,
  }: {
    readonly statement: string
    readonly params?: ReadonlyArray<unknown>
  }) =>
    runSqlUnsafe(params === undefined ? { statement } : { statement, params }).pipe(
      Effect.provide(AdminPgClientLive),
      Effect.asVoid,
      Effect.scoped
    )

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runAdminSql({
        statement: `
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()
        `,
        params: [TEMPLATE_DATABASE_NAME],
      })
      yield* runAdminSql({
        statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(TEMPLATE_DATABASE_NAME)}`,
      })
      yield* runAdminSql({
        statement: `CREATE DATABASE ${quoteIdentifier(TEMPLATE_DATABASE_NAME)}`,
      })
      yield* runDrizzleMigrations().pipe(Effect.provide(TemplatePgClientLive), Effect.scoped)
      yield* seedSolanaReferenceData.pipe(Effect.provide(TemplatePgClientLive), Effect.scoped)
      yield* runAdminSql({
        statement: `
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()
        `,
        params: [TEMPLATE_DATABASE_NAME],
      })
    })
  )
}
