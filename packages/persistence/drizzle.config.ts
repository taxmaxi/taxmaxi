import { defineConfig } from "drizzle-kit"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const drizzleDbConfig = Config.all({
  host: Config.string("PGHOST").pipe(Config.withDefault("localhost")),
  port: Config.integer("PGPORT").pipe(Config.withDefault(5432)),
  user: Config.string("PGUSER").pipe(Config.withDefault("postgres")),
  password: Config.redacted("PGPASSWORD").pipe(Config.withDefault(Redacted.make("postgres"))),
  database: Config.string("PGDATABASE").pipe(Config.withDefault("taxmaxi")),
})

const dbCredentials = Effect.runSync(
  Effect.gen(function* () {
    const config = yield* drizzleDbConfig
    return {
      host: config.host,
      port: config.port,
      user: config.user,
      password: Redacted.value(config.password),
      database: config.database,
      ssl: false,
    } as const
  })
)

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./drizzle",
  dbCredentials,
})
