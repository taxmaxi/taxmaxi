import { nextTestUuid } from "./support/TestUuid.ts"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { HttpApiClient } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SOURCE_SYNC_QUEUE_NAME,
  CalculationRunOrchestrator,
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceProviderRegistry,
  SyncEngineTransaction,
  TransferReconciliationService,
  terminalizeSourceJobAndWakeCalculation,
  type SourceProviderModuleShape,
  type SourceSyncQueuePayload,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import {
  SourceSyncJobExecutorLive,
  SourceSyncRunServiceLive,
  SourceSyncServiceLive,
} from "@my/sync-engine/layers"
import { FetchProviderRawBatchResult } from "../../sync-engine/src/shared/SourceProviderRawBatch.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../../sync-engine/tests/support/SourceSyncQueueInlineExecutorTestLive.ts"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle, runSqlUnsafe } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { TaxCalculationService } from "../../persistence/src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sync_runs",
  maxConnections: 1,
})
const TestPgClientLive = context.TestPgClientLive
const lockHolderContext = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sync_runs",
  maxConnections: 1,
})
const LockHolderPgClientLive = lockHolderContext.TestPgClientLive
const LockHolderPersistenceLive = Layer.fresh(RepositoriesLive).pipe(
  Layer.provideMerge(LockHolderPgClientLive)
)

const queuedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
const queueEvents: Array<SourceSyncQueuePayload> = []
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const SourceSyncQueueTestLive = Layer.effect(
  SourceSyncQueue,
  Effect.gen(function* () {
    const sourceSyncJobRepository = yield* SourceSyncJobRepository

    return SourceSyncQueue.of({
      enqueueSourceSyncJob: (payload) =>
        Effect.gen(function* () {
          queueEvents.push(payload)
          yield* sourceSyncJobRepository
            .attachQueueMetadata({
              jobId: payload.jobId,
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId: payload.jobId,
              queuedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SourceSyncQueueError({
                    operation: "test.attachQueueMetadata",
                    cause,
                  })
              )
            )
        }),
    })
  })
)

const AuthServiceTestLive = Layer.succeed(AuthService, {
  login: () => Effect.die("AuthService test stub: login not implemented"),
  register: () => Effect.die("AuthService test stub: register not implemented"),
  startEmailVerification: () =>
    Effect.die("AuthService test stub: startEmailVerification not implemented"),
  resendEmailVerification: () =>
    Effect.die("AuthService test stub: resendEmailVerification not implemented"),
  verifyEmail: () => Effect.die("AuthService test stub: verifyEmail not implemented"),
  startOAuthLogin: () => Effect.die("AuthService test stub: startOAuthLogin not implemented"),
  completeOAuthLogin: () => Effect.die("AuthService test stub: completeOAuthLogin not implemented"),
  startLink: () => Effect.die("AuthService test stub: startLink not implemented"),
  completeLink: () => Effect.die("AuthService test stub: completeLink not implemented"),
  logout: () => Effect.die("AuthService test stub: logout not implemented"),
  validateSession: () => Effect.die("AuthService test stub: validateSession not implemented"),
  linkIdentity: () => Effect.die("AuthService test stub: linkIdentity not implemented"),
  getEnabledProviders: Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
} satisfies AuthServiceShape)

const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
  hash: () => Effect.succeed(HashedPassword.make("test-password-hash")),
  verify: () => Effect.succeed(true),
})

const TaxCalculationServiceTestLive = Layer.succeed(TaxCalculationService, {
  calculateTax: () => Effect.die("TaxCalculationService test stub: calculateTax"),
})

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.succeed({
      evaluatedProviderTransfers: 0,
      pending: 0,
      needsReview: 0,
      autoApplied: 0,
    }),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.succeed({ canonicalizedPairs: 0 }),
} satisfies TransferReconciliationServiceShape)

const EmptyProviderModule: SourceProviderModuleShape = {
  fetchRawBatch: () =>
    Effect.succeed(
      FetchProviderRawBatchResult.make({
        records: [],
        cursorPayload: null,
        highWatermark: null,
        done: true,
      })
    ),
  refreshReferenceData: Effect.succeed({
    transactionTypeCatalogCount: 0,
    providerAssetCatalogCount: 0,
    defaultTransactionMappingCount: 0,
    defaultProviderAssetMappingCount: 0,
  }),
  refreshDefaultMappings: Effect.succeed({
    defaultTransactionMappingCount: 0,
    defaultProviderAssetMappingCount: 0,
  }),
  makeRawRecordNormalizer: Effect.succeed(() => Effect.succeed({ kind: "skipped" })),
}

const SourceProviderRegistryTestLive = Layer.succeed(SourceProviderRegistry, {
  resolveProviderModule: () => Effect.succeed(EmptyProviderModule),
})

const SourceSyncServiceWithDepsTestLive = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncRunServiceWithDepsTestLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SourceSyncServiceWithDepsTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncJobExecutorWithDepsTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(SourceProviderRegistryTestLive),
  Layer.provide(TransferReconciliationServiceTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncQueueInlineTestLive = SourceSyncQueueInlineExecutorTestLive.pipe(
  Layer.provide(SourceSyncJobExecutorWithDepsTestLive)
)

const SourceSyncServiceInlineTestLive = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncRunServiceInlineTestLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SourceSyncServiceInlineTestLive),
  Layer.provide(RepositoriesLive)
)

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncJobExecutorWithDepsTestLive,
  SourceSyncServiceWithDepsTestLive,
  SourceSyncRunServiceWithDepsTestLive,
  TaxCalculationServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const InlinePersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncJobExecutorWithDepsTestLive,
  SourceSyncServiceInlineTestLive,
  SourceSyncRunServiceInlineTestLive,
  TaxCalculationServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpInlineLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(InlinePersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const seedCoinbaseSources = ({
  userId,
  principalId,
  sourceIds,
}: {
  readonly userId: string
  readonly principalId: string
  readonly sourceIds: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `${userId}@taxmaxi.test`,
      name: "Sync Runs API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })

    const coinbaseCex = yield* db
      .select({ id: schema.cex.id, name: schema.cex.name })
      .from(schema.cex)
      .pipe(Effect.map((rows) => rows.find((row) => row.name === "coinbase")))

    if (coinbaseCex === undefined) {
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
    }

    yield* Effect.forEach(sourceIds, (sourceId, index) =>
      Effect.gen(function* () {
        const [createdAccount] = yield* db
          .insert(schema.cexAccount)
          .values({
            cexId: coinbaseCex.id,
            principalId,
            providerUserId: `${sourceId}-provider-user`,
            providerAccountId: `${sourceId}-provider-account`,
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
            scopes: "wallet:accounts:read wallet:transactions:read",
          })
          .returning({ id: schema.cexAccount.id })

        if (createdAccount === undefined) {
          return yield* Effect.die("Failed to create cex account fixture")
        }

        yield* db.insert(schema.sources).values({
          id: sourceId,
          name: `Coinbase ${index}`,
          providerKey: "coinbase",
          sourceableType: "cex",
          cexAccountId: createdAccount.id,
          principalId,
        })
      })
    )
  })

const seedPrincipalUser = ({
  userId,
  principalId,
}: {
  readonly userId: string
  readonly principalId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.users).values({
      id: userId,
      email: `${userId}@taxmaxi.test`,
      name: "Sync Runs API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })
  })

const markJobTerminal = ({
  jobId,
  status,
}: {
  readonly jobId: string
  readonly status: "completed" | "failed"
}) =>
  runSqlUnsafe({
    statement: `
      UPDATE processing_jobs
      SET
        status = $1,
        completed_at = $2,
        error_message = $3,
        progress_details = $4::jsonb,
        updated_at = $2
      WHERE id = $5
    `,
    params: [
      status,
      DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")),
      status === "failed" ? "Provider failed" : null,
      JSON.stringify({
        fetchedRecords: status === "completed" ? 4 : 0,
        normalizedRecords: status === "completed" ? 3 : 0,
        failedRecords: status === "failed" ? 1 : 0,
      }),
      jobId,
    ],
  })

const markJobProcessing = ({ jobId }: { readonly jobId: string }) =>
  runSqlUnsafe({
    statement: `
      UPDATE processing_jobs
      SET
        status = 'processing',
        started_at = $1,
        heartbeat_at = $1,
        updated_at = $1
      WHERE id = $2
    `,
    params: [DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:04:00.000Z")), jobId],
  })

const makePartialCalculationFixture = ({
  removeCustodyMembership = false,
}: {
  readonly removeCustodyMembership?: boolean
} = {}) =>
  Effect.gen(function* () {
    const userId = nextTestUuid()
    const principalId = nextTestUuid()
    const sourceId = nextTestUuid()
    const assetId = nextTestUuid()
    const eventId = nextTestUuid()
    yield* seedCoinbaseSources({ userId, principalId, sourceIds: [sourceId] })

    const db = yield* drizzle
    yield* db.insert(schema.assets).values({ id: assetId, name: "Bitcoin", symbol: "BTC" })
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId,
        principalId,
        externalId: "t13-unknown-cause",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1970-01-02T10:00:00.000Z")),
        transactionType: null,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to seed T13 transaction")
    }

    yield* db.insert(schema.transactionLegs).values({
      id: eventId,
      sourceId,
      principalId,
      externalId: "t13-unknown-cause-leg",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1970-01-02T10:00:00.000Z")),
      transactionId: transaction.id,
      assetId,
      amount: "1",
      kind: "acquisition",
      provenance: "deterministic",
    })
    if (removeCustodyMembership) {
      yield* runSqlUnsafe({
        statement: "DELETE FROM custody_unit_sources WHERE source_id = $1",
        params: [sourceId],
      })
    }

    const client = yield* makeAuthenticatedClient({ userId })
    const started = yield* client.syncRuns.startSyncRun(undefined)
    const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
    const storedRun = yield* db
      .select({
        id: schema.calculationRuns.id,
        principalId: schema.calculationRuns.principalId,
        jurisdiction: schema.calculationRuns.jurisdiction,
        taxYear: schema.calculationRuns.taxYear,
        reportingCurrency: schema.calculationRuns.reportingCurrency,
        engineVersion: schema.calculationRuns.engineVersion,
        ruleSetVersion: schema.calculationRuns.ruleSetVersion,
        inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
        valuationRevision: schema.calculationRuns.valuationRevision,
        processedEventIds: schema.calculationRuns.processedEventIds,
      })
      .from(schema.calculationRuns)
      .pipe(Effect.map((runs) => runs.find(({ id }) => id === loaded.items[0]?.jobId)))

    if (storedRun === undefined) {
      return yield* Effect.die("Expected the completed calculation run")
    }

    return { client, eventId, loaded, principalId, sourceId, started, storedRun }
  })

type PartialCalculationFixture = Effect.Success<ReturnType<typeof makePartialCalculationFixture>>

const replaceCalculationWithRunning = ({
  storedRun,
  inputLedgerRevision = storedRun.inputLedgerRevision,
  taxYear = storedRun.taxYear,
  engineVersion = storedRun.engineVersion,
}: {
  readonly storedRun: PartialCalculationFixture["storedRun"]
  readonly inputLedgerRevision?: string
  readonly taxYear?: number
  readonly engineVersion?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* runSqlUnsafe({
      statement: "DELETE FROM active_calculation_runs WHERE run_id = $1",
      params: [storedRun.id],
    })
    yield* runSqlUnsafe({
      statement: "DELETE FROM calculation_runs WHERE id = $1",
      params: [storedRun.id],
    })
    yield* db.insert(schema.calculationRuns).values({
      ...storedRun,
      inputLedgerRevision,
      taxYear,
      engineVersion,
      status: "running",
      processedEventIds: [],
      appliedChoiceIds: [],
      appliedRules: [],
      startedAt: yield* DateTime.nowAsDate,
    })
  })

const holdPrincipalExclusiveLock = ({
  principalId,
  acquired,
  release,
}: {
  readonly principalId: string
  readonly acquired: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}) =>
  Effect.gen(function* () {
    const transaction = yield* SyncEngineTransaction
    yield* transaction.run(
      runSqlUnsafe({
        statement: "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        params: [principalId],
      }).pipe(
        Effect.andThen(Deferred.succeed(acquired, undefined)),
        Effect.andThen(Deferred.await(release))
      )
    )
  }).pipe(Effect.provide(LockHolderPersistenceLive), Effect.scoped)

await Effect.runPromise(context.recreateTestDatabase())

describe("SyncRunsApiLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        queueEvents.length = 0
        yield* context.recreateTestDatabase()
      })
    )
  )

  it.effect("starts a user-wide run with one queued child item per source", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceA = nextTestUuid()
      const sourceB = nextTestUuid()
      const sourceIds = [sourceA, sourceB]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const run = yield* client.syncRuns.startSyncRun(undefined)

      expect(run.status).toBe("queued")
      expect(run.requestedSourceCount).toBe(2)
      expect(run.queuedSourceCount).toBe(2)
      expect(run.items).toHaveLength(2)
      expect(run.items.map((item) => item.sourceId).sort()).toEqual(sourceIds.sort())
      expect(run.items.every((item) => item.provider === "coinbase")).toBe(true)
      expect(run.items.every((item) => item.status === "queued")).toBe(true)
      expect(queueEvents).toHaveLength(2)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the current user's run", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const loaded = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(loaded.runId).toBe(started.runId)
      expect(loaded.items).toHaveLength(1)
      const loadedJobId = loaded.items[0]?.jobId
      const startedJobId = started.items[0]?.jobId
      expect(loadedJobId).toBeDefined()
      expect(startedJobId).toBeDefined()
      expect(loadedJobId).toBe(startedJobId)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects another user's run", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const otherUserId = nextTestUuid()
      yield* seedCoinbaseSources({
        userId,
        principalId: nextTestUuid(),
        sourceIds: [nextTestUuid()],
      })
      yield* seedPrincipalUser({ userId: otherUserId, principalId: nextTestUuid() })

      const ownerClient = yield* makeAuthenticatedClient({ userId })
      const started = yield* ownerClient.syncRuns.startSyncRun(undefined)
      const otherClient = yield* makeAuthenticatedClient({ userId: otherUserId })
      const result = yield* otherClient.syncRuns
        .getSyncRun({
          params: { runId: started.runId },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SyncRunNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("refreshes child completion into aggregate API status", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)

      const [firstItem, secondItem] = started.items
      if (
        firstItem === undefined ||
        secondItem === undefined ||
        firstItem.jobId === null ||
        secondItem.jobId === null
      ) {
        return yield* Effect.die("Expected two sync run items")
      }

      yield* markJobTerminal({ jobId: firstItem.jobId, status: "completed" })
      yield* markJobTerminal({ jobId: secondItem.jobId, status: "failed" })

      const loaded = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(loaded.status).toBe("partially_failed")
      expect(loaded.completedSourceCount).toBe(1)
      expect(loaded.failedSourceCount).toBe(1)
      expect(loaded.items.map((item) => item.status).sort()).toEqual(["completed", "failed"])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("exposes the calculation run linked to a completed source item", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [sourceId] })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const [item] = started.items

      if (item?.jobId === null || item?.jobId === undefined) {
        return yield* Effect.die("Expected one queued source job")
      }

      yield* markJobTerminal({ jobId: item.jobId, status: "completed" })

      const db = yield* drizzle
      const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:05:01.000Z"))
      yield* db.insert(schema.calculationRuns).values({
        id: item.jobId,
        principalId,
        jurisdiction: "DE",
        taxYear: 2026,
        reportingCurrency: "EUR",
        engineVersion: "1",
        ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
        inputLedgerRevision: "ledger-test-revision",
        valuationRevision: "valuation-test-revision",
        status: "failed",
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [],
        failureCode: "calculation_engine_failed",
        failureMessage: "Calculation engine failed.",
        startedAt: completedAt,
        completedAt,
      })

      const loaded = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(loaded.items[0]?.calculationRun).toEqual({
        runId: item.jobId,
        status: "failed",
        failureCode: "calculation_engine_failed",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("runs a deferred calculation when the last active source job fails", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const [completedItem, failedItem] = started.items

      if (
        completedItem?.jobId === null ||
        completedItem?.jobId === undefined ||
        failedItem?.jobId === null ||
        failedItem?.jobId === undefined
      ) {
        return yield* Effect.die("Expected two queued source jobs")
      }

      yield* markJobTerminal({ jobId: completedItem.jobId, status: "completed" })
      const orchestrator = yield* CalculationRunOrchestrator
      yield* orchestrator.runAfterSync({ jobId: completedItem.jobId, principalId })

      const deferred = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      expect(
        deferred.items.find(({ jobId }) => jobId === completedItem.jobId)?.calculationRun
      ).toBe(null)

      yield* markJobTerminal({ jobId: failedItem.jobId, status: "failed" })
      const executor = yield* SourceSyncJobExecutor
      const failedRedelivery = yield* executor.execute({ jobId: failedItem.jobId })

      const settled = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      expect(failedRedelivery.status).toBe("failed")
      expect(settled.status).toBe("partially_failed")
      expect(
        settled.items.find(({ jobId }) => jobId === completedItem.jobId)?.calculationRun?.status
      ).toBe("complete")
      expect(settled.items.find(({ jobId }) => jobId === failedItem.jobId)?.calculationRun).toBe(
        null
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("terminalizes and wakes accounting inside one-connection transaction", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const [completedItem, staleItem] = started.items
      if (
        completedItem?.jobId === null ||
        completedItem?.jobId === undefined ||
        staleItem?.jobId === null ||
        staleItem?.jobId === undefined
      ) {
        return yield* Effect.die("Expected two queued source jobs")
      }

      yield* markJobTerminal({ jobId: completedItem.jobId, status: "completed" })
      yield* runSqlUnsafe({
        statement: `
          UPDATE processing_jobs
          SET status = 'processing', started_at = $1, heartbeat_at = $1, updated_at = $1
          WHERE id = $2
        `,
        params: [
          DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          staleItem.jobId,
        ],
      })

      const orchestrator = yield* CalculationRunOrchestrator
      yield* orchestrator.runAfterSync({ jobId: completedItem.jobId, principalId })

      const sourceSyncJobRepository = yield* SourceSyncJobRepository
      const syncEngineTransaction = yield* SyncEngineTransaction
      yield* terminalizeSourceJobAndWakeCalculation({
        calculationRunOrchestrator: orchestrator,
        principalId,
        transaction: syncEngineTransaction,
        terminalize: sourceSyncJobRepository.recoverStaleActiveJob({
          sourceId: staleItem.sourceId,
          jobId: staleItem.jobId,
          staleBefore: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
          message: "Recovered stale source sync job.",
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-03T00:00:00.000Z")),
        }),
        wake: orchestrator.runAfterPrincipalTerminal({ principalId }),
      })

      const settled = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      expect(settled.items.find(({ jobId }) => jobId === staleItem.jobId)?.status).toBe("failed")
      expect(
        settled.items.find(({ jobId }) => jobId === completedItem.jobId)?.calculationRun?.status
      ).toBe("complete")
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("serializes factual writes and calculation with one database connection", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [sourceId] })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const [item] = started.items
      if (item?.jobId === null || item?.jobId === undefined) {
        return yield* Effect.die("Expected one queued source job")
      }
      yield* markJobTerminal({ jobId: item.jobId, status: "completed" })

      const orchestrator = yield* CalculationRunOrchestrator
      const writerAcquired = yield* Deferred.make<void>()
      const releaseWriter = yield* Deferred.make<void>()
      const writerFiber = yield* orchestrator
        .withPrincipalSyncLock({
          principalId,
          effect: Deferred.succeed(writerAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter))
          ),
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(writerAcquired)

      const calculationFiber = yield* orchestrator
        .runAfterSync({ jobId: item.jobId, principalId })
        .pipe(Effect.forkScoped)
      expect(calculationFiber.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(releaseWriter, undefined)
      yield* Fiber.join(writerFiber)
      yield* Fiber.join(calculationFiber)

      const settled = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      expect(settled.items[0]?.calculationRun?.status).toBe("complete")
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("stores one stable calculation run for each completed source callback", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const jobIds = started.items.flatMap(({ jobId }) => (jobId === null ? [] : [jobId]))
      if (jobIds.length !== 2) {
        return yield* Effect.die("Expected two queued source jobs")
      }
      const orchestrator = yield* CalculationRunOrchestrator
      const [firstJobId, secondJobId] = jobIds
      if (firstJobId === undefined || secondJobId === undefined) {
        return yield* Effect.die("Expected two source job IDs")
      }
      yield* markJobTerminal({ jobId: firstJobId, status: "completed" })
      yield* markJobProcessing({ jobId: secondJobId })

      const secondWriterAcquired = yield* Deferred.make<void>()
      const releaseSecondWriter = yield* Deferred.make<void>()
      const secondWriter = yield* orchestrator
        .withPrincipalSyncLock({
          principalId,
          effect: Deferred.succeed(secondWriterAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSecondWriter)),
            Effect.andThen(markJobTerminal({ jobId: secondJobId, status: "completed" }))
          ),
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(secondWriterAcquired)

      const firstCalculation = yield* orchestrator
        .runAfterSync({ jobId: firstJobId, principalId })
        .pipe(Effect.forkScoped)
      expect(firstCalculation.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(releaseSecondWriter, undefined)
      yield* Fiber.join(secondWriter)
      const secondCalculation = yield* orchestrator
        .runAfterSync({ jobId: secondJobId, principalId })
        .pipe(Effect.forkScoped)
      yield* Fiber.join(firstCalculation)
      yield* Fiber.join(secondCalculation)

      const db = yield* drizzle
      const runs = yield* db
        .select({
          id: schema.calculationRuns.id,
          status: schema.calculationRuns.status,
          inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
          valuationRevision: schema.calculationRuns.valuationRevision,
        })
        .from(schema.calculationRuns)
      const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      const sortedJobIds = [...jobIds].sort((left, right) => left.localeCompare(right))
      expect(runs.map(({ id }) => id).sort((left, right) => left.localeCompare(right))).toEqual(
        sortedJobIds
      )
      expect(runs.every(({ status }) => status === "complete")).toBe(true)
      expect(new Set(runs.map(({ inputLedgerRevision }) => inputLedgerRevision)).size).toBe(1)
      expect(new Set(runs.map(({ valuationRevision }) => valuationRevision)).size).toBe(1)
      expect(
        loaded.items
          .map(({ calculationRun }) => calculationRun?.runId ?? null)
          .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
      ).toEqual(sortedJobIds)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("calculates and snapshots grouped source inventory under its custody unit", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceA = nextTestUuid()
      const sourceB = nextTestUuid()
      const sourceIds = [sourceA, sourceB]
      const custodyUnitId = nextTestUuid()
      const assetId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const db = yield* drizzle
      yield* db.insert(schema.assets).values({ id: assetId, name: "Bitcoin", symbol: "BTC" })
      yield* db.insert(schema.custodyUnits).values({ id: custodyUnitId, principalId })
      yield* runSqlUnsafe({
        statement: `
          UPDATE custody_unit_sources
          SET custody_unit_id = $1
          WHERE principal_id = $2
        `,
        params: [custodyUnitId, principalId],
      })

      const [acquisition, disposition] = yield* db
        .insert(schema.transactions)
        .values([
          {
            sourceId: sourceA,
            principalId,
            externalId: "grouped-acquisition",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1969-12-01T10:00:00.000Z")),
            transactionType: "buy_fiat",
            providerFiatAmount: "100",
            providerFiatCurrency: "EUR",
          },
          {
            sourceId: sourceB,
            principalId,
            externalId: "grouped-disposition",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1970-01-02T10:00:00.000Z")),
            transactionType: "sell_fiat",
            providerFiatAmount: "150",
            providerFiatCurrency: "EUR",
          },
        ])
        .returning({ id: schema.transactions.id })
      if (acquisition === undefined || disposition === undefined) {
        return yield* Effect.die("Failed to seed grouped custody facts")
      }
      yield* db.insert(schema.transactionLegs).values([
        {
          id: nextTestUuid(),
          sourceId: sourceA,
          principalId,
          externalId: "grouped-acquisition-leg",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1969-12-01T10:00:00.000Z")),
          transactionId: acquisition.id,
          assetId,
          amount: "1",
          kind: "acquisition",
          provenance: "deterministic",
        },
        {
          id: nextTestUuid(),
          sourceId: sourceB,
          principalId,
          externalId: "grouped-disposition-leg",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("1970-01-02T10:00:00.000Z")),
          transactionId: disposition.id,
          assetId,
          amount: "1",
          kind: "disposal",
          provenance: "deterministic",
        },
      ])

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const runId = started.items.find(({ calculationRun }) => calculationRun !== null)
        ?.calculationRun?.runId
      if (runId === undefined) {
        return yield* Effect.die("Expected grouped custody calculation run")
      }

      const allocations = yield* db
        .select({
          runId: schema.calculationRunAllocations.runId,
          custodyUnitId: schema.calculationRunAllocations.custodyUnitId,
        })
        .from(schema.calculationRunAllocations)
        .pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.runId === runId)
              .map(({ custodyUnitId: storedCustodyUnitId }) => ({
                custodyUnitId: storedCustodyUnitId,
              }))
          )
        )
      const membership = yield* db
        .select({
          runId: schema.calculationRunCustodyUnitSources.runId,
          sourceId: schema.calculationRunCustodyUnitSources.sourceId,
          custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
        })
        .from(schema.calculationRunCustodyUnitSources)
        .orderBy(schema.calculationRunCustodyUnitSources.sourceId)
        .pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.runId === runId)
              .map(({ sourceId, custodyUnitId: storedCustodyUnitId }) => ({
                sourceId,
                custodyUnitId: storedCustodyUnitId,
              }))
          )
        )

      expect(allocations).toEqual([{ custodyUnitId }])
      expect(membership).toEqual(
        sourceIds
          .sort((left, right) => left.localeCompare(right))
          .map((sourceId) => ({ sourceId, custodyUnitId }))
      )
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect(
    "keeps the source heartbeat fresh while one connection waits for the principal lock",
    () =>
      Effect.gen(function* () {
        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        const sourceId = nextTestUuid()
        yield* seedCoinbaseSources({ userId, principalId, sourceIds: [sourceId] })

        const client = yield* makeAuthenticatedClient({ userId })
        const started = yield* client.syncRuns.startSyncRun(undefined)
        const [item] = started.items
        if (item?.jobId === null || item?.jobId === undefined) {
          return yield* Effect.die("Expected one queued source job")
        }

        const lockAcquired = yield* Deferred.make<void>()
        const releaseLock = yield* Deferred.make<void>()
        const lockHolder = yield* holdPrincipalExclusiveLock({
          principalId,
          acquired: lockAcquired,
          release: releaseLock,
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(lockAcquired)

        const executor = yield* SourceSyncJobExecutor
        const executorFiber = yield* executor.execute({ jobId: item.jobId }).pipe(Effect.forkScoped)
        const db = yield* drizzle

        let claimedJob:
          | {
              readonly status: string
              readonly startedAt: Date | null
              readonly heartbeatAt: Date | null
            }
          | undefined
        for (let attempt = 0; attempt < 100; attempt += 1) {
          claimedJob = yield* db
            .select({
              id: schema.processingJobs.id,
              status: schema.processingJobs.status,
              startedAt: schema.processingJobs.startedAt,
              heartbeatAt: schema.processingJobs.heartbeatAt,
            })
            .from(schema.processingJobs)
            .pipe(Effect.map((jobs) => jobs.find(({ id }) => id === item.jobId)))
          if (claimedJob?.status === "processing") {
            break
          }
          yield* Effect.yieldNow
        }

        if (claimedJob?.startedAt === null || claimedJob?.startedAt === undefined) {
          return yield* Effect.die("Expected the source job to be claimed")
        }

        yield* TestClock.adjust("31 seconds")
        const heartbeatWhileWaiting = yield* db
          .select({
            id: schema.processingJobs.id,
            status: schema.processingJobs.status,
            heartbeatAt: schema.processingJobs.heartbeatAt,
          })
          .from(schema.processingJobs)
          .pipe(Effect.map((jobs) => jobs.find(({ id }) => id === item.jobId)))

        expect(heartbeatWhileWaiting?.status).toBe("processing")
        expect(heartbeatWhileWaiting?.heartbeatAt?.getTime()).toBeGreaterThan(
          claimedJob.startedAt.getTime()
        )

        yield* Deferred.succeed(releaseLock, undefined)
        yield* Fiber.join(lockHolder)
        yield* TestClock.adjust("1 second")
        const result = yield* Fiber.join(executorFiber)
        const completed = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

        expect(result.status).toBe("completed")
        expect(completed.items[0]?.status).toBe("completed")
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("keeps sync completed when the linked calculation run is partial", () =>
    Effect.gen(function* () {
      const db = yield* drizzle
      const { eventId, loaded, storedRun } = yield* makePartialCalculationFixture()
      const storedLegIds = yield* db
        .select({ id: schema.transactionLegs.id })
        .from(schema.transactionLegs)
        .pipe(Effect.map((legs) => legs.map(({ id }) => id)))

      expect(loaded.status).toBe("completed")
      expect(loaded.items[0]?.status).toBe("completed")
      expect(storedLegIds).toContain(eventId)
      expect(storedRun?.taxYear).toBe(1970)
      expect(storedRun?.processedEventIds).toContain(eventId)
      expect(loaded.items[0]?.calculationRun?.status).toBe("partial")
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("resumes an interrupted calculation and keeps terminal redelivery idempotent", () =>
    Effect.gen(function* () {
      const { client, started, storedRun } = yield* makePartialCalculationFixture()
      yield* replaceCalculationWithRunning({ storedRun })

      const executor = yield* SourceSyncJobExecutor
      const redelivered = yield* executor.execute({ jobId: storedRun.id })
      const recovered = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      const terminalRedelivery = yield* executor.execute({ jobId: storedRun.id })
      const afterTerminalRedelivery = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(redelivered.status).toBe("completed")
      expect(terminalRedelivery.status).toBe("completed")
      expect(recovered.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "partial",
        failureCode: null,
      })
      expect(afterTerminalRedelivery.items[0]?.calculationRun).toEqual(
        recovered.items[0]?.calculationRun
      )
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect(
    "recovers calculation settlement after the final source attempt without rerunning factual sync",
    () =>
      Effect.gen(function* () {
        const { client, started, storedRun } = yield* makePartialCalculationFixture()
        yield* replaceCalculationWithRunning({ storedRun })
        const db = yield* drizzle
        const factsBefore = yield* db
          .select({
            id: schema.transactionLegs.id,
            transactionId: schema.transactionLegs.transactionId,
          })
          .from(schema.transactionLegs)
          .orderBy(schema.transactionLegs.id)

        const orchestrator = yield* CalculationRunOrchestrator
        const recovery = yield* orchestrator.recoverTerminalCalculations({ limit: 10 })

        const factsAfter = yield* db
          .select({
            id: schema.transactionLegs.id,
            transactionId: schema.transactionLegs.transactionId,
          })
          .from(schema.transactionLegs)
          .orderBy(schema.transactionLegs.id)
        const sourceJob = yield* db
          .select({ id: schema.processingJobs.id, status: schema.processingJobs.status })
          .from(schema.processingJobs)
          .pipe(Effect.map((jobs) => jobs.find(({ id }) => id === storedRun.id)))
        const recovered = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

        expect(recovery).toEqual({
          scannedPrincipals: 1,
          recoveredPrincipals: 1,
          failedPrincipals: 0,
        })
        expect(sourceJob?.status).toBe("completed")
        expect(factsAfter).toEqual(factsBefore)
        expect(recovered.items[0]?.calculationRun).toEqual({
          runId: storedRun.id,
          status: "partial",
          failureCode: null,
        })
      }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("fails a superseded running calculation without changing the latest active run", () =>
    Effect.gen(function* () {
      const { client, principalId, sourceId, started, storedRun } =
        yield* makePartialCalculationFixture()
      const supersededRunId = nextTestUuid()
      const supersededAt = DateTime.toDateUtc(DateTime.makeUnsafe("1969-12-31T00:00:00.000Z"))
      const db = yield* drizzle
      const factsBefore = yield* db
        .select({
          id: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
        })
        .from(schema.transactionLegs)
        .orderBy(schema.transactionLegs.id)

      yield* db.insert(schema.processingJobs).values({
        id: supersededRunId,
        sourceId,
        principalId,
        status: "completed",
        startedAt: supersededAt,
        heartbeatAt: supersededAt,
        completedAt: supersededAt,
        createdAt: supersededAt,
        updatedAt: supersededAt,
      })
      yield* db.insert(schema.calculationRuns).values({
        ...storedRun,
        id: supersededRunId,
        status: "running",
        processedEventIds: [],
        appliedChoiceIds: [],
        appliedRules: [],
        startedAt: supersededAt,
      })

      const orchestrator = yield* CalculationRunOrchestrator
      const recovery = yield* orchestrator.recoverTerminalCalculations({ limit: 10 })
      const calculations = yield* db
        .select({
          id: schema.calculationRuns.id,
          status: schema.calculationRuns.status,
          failureCode: schema.calculationRuns.failureCode,
        })
        .from(schema.calculationRuns)
      const active = yield* db
        .select({
          principalId: schema.activeCalculationRuns.principalId,
          runId: schema.activeCalculationRuns.runId,
        })
        .from(schema.activeCalculationRuns)
        .pipe(Effect.map((runs) => runs.find((run) => run.principalId === principalId)))
      const factsAfter = yield* db
        .select({
          id: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
        })
        .from(schema.transactionLegs)
        .orderBy(schema.transactionLegs.id)
      const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(recovery).toEqual({
        scannedPrincipals: 1,
        recoveredPrincipals: 1,
        failedPrincipals: 0,
      })
      expect(calculations.find(({ id }) => id === supersededRunId)).toEqual({
        id: supersededRunId,
        status: "failed",
        failureCode: "calculation_superseded",
      })
      expect(calculations.find(({ id }) => id === storedRun.id)).toEqual({
        id: storedRun.id,
        status: "partial",
        failureCode: null,
      })
      expect(active?.runId).toBe(storedRun.id)
      expect(factsAfter).toEqual(factsBefore)
      expect(loaded.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "partial",
        failureCode: null,
      })
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("snapshots the one-source default when live custody membership is missing", () =>
    Effect.gen(function* () {
      const { client, sourceId, started, storedRun } = yield* makePartialCalculationFixture({
        removeCustodyMembership: true,
      })
      const db = yield* drizzle
      const snapshot = yield* db
        .select({
          runId: schema.calculationRunCustodyUnitSources.runId,
          sourceId: schema.calculationRunCustodyUnitSources.sourceId,
          custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
        })
        .from(schema.calculationRunCustodyUnitSources)
        .pipe(Effect.map((rows) => rows.find(({ runId }) => runId === storedRun.id)))
      const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(loaded.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "partial",
        failureCode: null,
      })
      expect(snapshot).toEqual({ runId: storedRun.id, sourceId, custodyUnitId: sourceId })
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("fails an interrupted calculation when its factual revision changed", () =>
    Effect.gen(function* () {
      const { client, started, storedRun } = yield* makePartialCalculationFixture()
      yield* replaceCalculationWithRunning({
        storedRun,
        inputLedgerRevision: `${storedRun.inputLedgerRevision}:stale`,
      })

      const executor = yield* SourceSyncJobExecutor
      const staleRedelivery = yield* executor.execute({ jobId: storedRun.id })
      const staleRun = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(staleRedelivery.status).toBe("completed")
      expect(staleRun.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "failed",
        failureCode: "calculation_input_revision_changed",
      })
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("reports changed calculation metadata separately from factual revisions", () =>
    Effect.gen(function* () {
      const { client, started, storedRun } = yield* makePartialCalculationFixture()
      yield* replaceCalculationWithRunning({
        storedRun,
        taxYear: storedRun.taxYear + 1,
        engineVersion: `${storedRun.engineVersion}:new`,
      })

      const executor = yield* SourceSyncJobExecutor
      yield* executor.execute({ jobId: storedRun.id })
      const staleRun = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(staleRun.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "failed",
        failureCode: "calculation_run_metadata_changed",
      })
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )

  it.effect("reports combined factual and calculation metadata changes", () =>
    Effect.gen(function* () {
      const { client, started, storedRun } = yield* makePartialCalculationFixture()
      yield* replaceCalculationWithRunning({
        storedRun,
        inputLedgerRevision: `${storedRun.inputLedgerRevision}:stale`,
        engineVersion: `${storedRun.engineVersion}:new`,
      })

      const executor = yield* SourceSyncJobExecutor
      yield* executor.execute({ jobId: storedRun.id })
      const staleRun = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(staleRun.items[0]?.calculationRun).toEqual({
        runId: storedRun.id,
        status: "failed",
        failureCode: "calculation_input_and_run_metadata_changed",
      })
    }).pipe(Effect.provide(HttpInlineLive), Effect.scoped)
  )
})
