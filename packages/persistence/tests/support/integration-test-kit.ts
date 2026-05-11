import type { SqlClient } from "@effect/sql/SqlClient"
import { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import {
  makePgClientLayer,
  runDrizzleMigrations,
  runSqlUnsafe,
} from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"

const MIGRATED_TEMPLATE_DATABASE_NAME = "taxmaxi_template"

const testDatabaseConfig = Effect.runSync(
  Effect.gen(function* () {
    const workerId = yield* Config.string("VITEST_WORKER_ID").pipe(Config.withDefault("1"))
    const host = yield* Config.string("PGHOST").pipe(Config.withDefault("localhost"))
    const port = yield* Config.integer("PGPORT").pipe(Config.withDefault(5432))
    const user = yield* Config.string("PGUSER").pipe(Config.withDefault("postgres"))
    const password = yield* Config.redacted("PGPASSWORD").pipe(
      Config.withDefault(Redacted.make("postgres"))
    )

    return { workerId, host, port, user, password } as const
  })
)

const workerId = testDatabaseConfig.workerId.replace(/[^a-zA-Z0-9_]/g, "_")
const pgHost = testDatabaseConfig.host
const pgPort = testDatabaseConfig.port
const pgUser = testDatabaseConfig.user
const pgPassword = Redacted.value(testDatabaseConfig.password)

export const TEST_USER_ID = "00000000-0000-0000-0000-000000000181"
export const TEST_SOURCE_ID = "00000000-0000-0000-0000-000000000281"
export const TEST_RAW_RECORD_ID = "00000000-0000-0000-0000-000000000381"
export const TEST_BTC_ASSET_ID = "00000000-0000-0000-0000-000000000481"
export const TEST_EUR_ASSET_ID = "00000000-0000-0000-0000-000000000482"

export interface SyncEngineRepositoryFixture {
  readonly userId: string
  readonly sourceId: string
  readonly cexAccountId: string
  readonly baseBlockchainId: string
  readonly bitcoinBlockchainId: string
}

export type SyncEngineRepositoryTestRuntime = PgClient.PgClient | SqlClient

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll(`"`, `""`)}"`
const quoteSqlLiteral = (value: string) => `'${value.replaceAll(`'`, `''`)}'`

const PRESERVED_TEST_RESET_TABLES = [
  "__drizzle_migrations",
  "blockchains",
  "cex",
  "contract_registry",
  "event_signatures",
  "function_signatures",
  "jurisdiction_rule_set_rules",
  "jurisdiction_rule_sets",
  "legal_clauses",
  "legal_rule_citations",
  "legal_rules",
  "legal_sources",
  "protocol_function_mappings",
  "transaction_categories",
  "transaction_subcategories",
  "transaction_type_legal_rules",
  "transaction_types",
] as const

const preservedTestResetTablesSql = PRESERVED_TEST_RESET_TABLES.map(quoteSqlLiteral).join(", ")

export const makeIntegrationTestDatabaseContext = ({
  databaseNamePrefix,
}: {
  readonly databaseNamePrefix: string
}) => {
  const databaseName = `${databaseNamePrefix}_${workerId}`
  let defaultSchemaMigrated = false

  const testDatabaseUrl = Redacted.make(
    `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${databaseName}`
  )
  const adminDatabaseUrl = Redacted.make(
    `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/postgres`
  )

  const TestPgClientLive = makePgClientLayer({
    url: testDatabaseUrl,
  })

  const AdminPgClientLive = makePgClientLayer({
    url: adminDatabaseUrl,
    maxConnections: 2,
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

  const migrateTestDatabaseFromFolder = ({
    migrationsFolder,
  }: {
    readonly migrationsFolder: string
  }) =>
    runDrizzleMigrations({ migrationsFolder }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

  const terminateTestDatabaseConnections = () =>
    runAdminSql({
      statement: `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      params: [databaseName],
    })

  const cloneMigratedTemplateDatabase = () =>
    Effect.gen(function* () {
      yield* terminateTestDatabaseConnections()
      yield* runAdminSql({
        statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      })
      yield* runAdminSql({
        statement: `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE ${quoteIdentifier(
          MIGRATED_TEMPLATE_DATABASE_NAME
        )}`,
      })
    })

  const resetTestData = () =>
    runSqlUnsafe({
      statement: `
        DO $$
        DECLARE
          table_list text;
        BEGIN
          SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
          INTO table_list
          FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename <> ALL(ARRAY[${preservedTestResetTablesSql}]);

          IF table_list IS NOT NULL THEN
            EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';
          END IF;
        END $$;
      `,
    }).pipe(Effect.provide(TestPgClientLive), Effect.asVoid, Effect.scoped)

  const recreateTestDatabase = ({
    migrationsFolder,
  }: {
    readonly migrationsFolder?: string
  } = {}) =>
    Effect.gen(function* () {
      if (migrationsFolder === undefined && defaultSchemaMigrated) {
        yield* resetTestData()
        return
      }

      if (migrationsFolder === undefined) {
        yield* cloneMigratedTemplateDatabase()
        defaultSchemaMigrated = true
      } else {
        yield* terminateTestDatabaseConnections()
        yield* runAdminSql({
          statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
        })
        yield* runAdminSql({
          statement: `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
        })
        yield* migrateTestDatabaseFromFolder({ migrationsFolder })
        defaultSchemaMigrated = false
      }
    })

  const recreateEmptyTestDatabase = () =>
    Effect.gen(function* () {
      yield* terminateTestDatabaseConnections()
      yield* runAdminSql({
        statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      })
      yield* runAdminSql({
        statement: `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
      })
      defaultSchemaMigrated = false
    })

  const destroyTestDatabase = () =>
    Effect.sync(() => {
      defaultSchemaMigrated = false
    })

  const runPg = <A, E>(effect: Effect.Effect<A, E, SyncEngineRepositoryTestRuntime>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestPgClientLive), Effect.scoped))

  const runWithLayer = <A, E, R, LE>({
    effect,
    layer,
  }: {
    readonly effect: Effect.Effect<A, E, R>
    readonly layer: Layer.Layer<R, LE, PgClient.PgClient | SqlClient>
  }) => effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestPgClientLive))), Effect.scoped)

  return {
    databaseName,
    TestPgClientLive,
    recreateTestDatabase,
    recreateEmptyTestDatabase,
    destroyTestDatabase,
    runPg,
    runWithLayer,
  }
}

const requireBlockchainId = ({ name }: { readonly name: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [blockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, name))
      .limit(1)

    if (blockchain === undefined) {
      return yield* Effect.dieMessage(`Missing blockchain fixture for ${name}`)
    }

    return blockchain.id
  })

export const seedSyncEngineRepositoryFixture = ({
  userId = TEST_USER_ID,
  sourceId = TEST_SOURCE_ID,
}: {
  readonly userId?: string
  readonly sourceId?: string
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `sync-engine-${userId}@taxmaxi.test`,
      name: "Sync Engine Repository Test User",
    })

    const cexId = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)
      .pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.dieMessage("Missing seeded coinbase CEX fixture")
            : Effect.succeed(rows[0].id)
        )
      )

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId,
        userId,
        providerUserId: `coinbase-user-${sourceId}`,
        providerAccountId: "coinbase-account-1",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (createdAccount === undefined) {
      return yield* Effect.dieMessage("Failed to create cex account fixture")
    }

    yield* db.insert(schema.sources).values({
      id: sourceId,
      userId,
      name: `Coinbase Source ${sourceId}`,
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      addressId: null,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    })

    const baseBlockchainId = yield* requireBlockchainId({ name: "base" })
    const bitcoinBlockchainId = yield* requireBlockchainId({ name: "bitcoin" })

    return {
      userId,
      sourceId,
      cexAccountId: createdAccount.id,
      baseBlockchainId,
      bitcoinBlockchainId,
    } satisfies SyncEngineRepositoryFixture
  })

export const seedSyncEngineAssets = ({
  baseBlockchainId,
  bitcoinBlockchainId,
}: {
  readonly baseBlockchainId: string
  readonly bitcoinBlockchainId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values([
      {
        id: TEST_BTC_ASSET_ID,
        blockchainId: bitcoinBlockchainId,
        contractAddress: "sync-engine-btc-fixture",
        name: "Sync Engine Bitcoin Fixture",
        symbol: "BTC",
        decimals: 8,
        type: "token",
      },
      {
        id: TEST_EUR_ASSET_ID,
        blockchainId: baseBlockchainId,
        contractAddress: "sync-engine-eur-fixture",
        name: "Sync Engine Euro Fixture",
        symbol: "EUR",
        decimals: 2,
        type: "token",
      },
    ])
  })
