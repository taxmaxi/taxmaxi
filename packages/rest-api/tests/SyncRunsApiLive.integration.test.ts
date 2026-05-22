import { HttpApiBuilder, HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  TransferReconciliationService,
  type SourceSyncQueuePayload,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { SourceSyncRunServiceLive, SourceSyncServiceLive } from "@my/sync-engine/layers"
import * as Chunk from "effect/Chunk"
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
})
const TestPgClientLive = context.TestPgClientLive

const queuedAt = new Date("2026-01-01T00:00:00.000Z")
const queueEvents: Array<SourceSyncQueuePayload> = []
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

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
  login: () => Effect.dieMessage("AuthService test stub: login not implemented"),
  register: () => Effect.dieMessage("AuthService test stub: register not implemented"),
  startEmailVerification: () =>
    Effect.dieMessage("AuthService test stub: startEmailVerification not implemented"),
  resendEmailVerification: () =>
    Effect.dieMessage("AuthService test stub: resendEmailVerification not implemented"),
  verifyEmail: () => Effect.dieMessage("AuthService test stub: verifyEmail not implemented"),
  startOAuthLogin: () =>
    Effect.dieMessage("AuthService test stub: startOAuthLogin not implemented"),
  completeOAuthLogin: () =>
    Effect.dieMessage("AuthService test stub: completeOAuthLogin not implemented"),
  startLink: () => Effect.dieMessage("AuthService test stub: startLink not implemented"),
  completeLink: () => Effect.dieMessage("AuthService test stub: completeLink not implemented"),
  logout: () => Effect.dieMessage("AuthService test stub: logout not implemented"),
  validateSession: () =>
    Effect.dieMessage("AuthService test stub: validateSession not implemented"),
  linkIdentity: () => Effect.dieMessage("AuthService test stub: linkIdentity not implemented"),
  getEnabledProviders: () => Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
} satisfies AuthServiceShape)

const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
  hash: () => Effect.succeed(HashedPassword.make("test-password-hash")),
  verify: () => Effect.succeed(true),
})

const TaxCalculationServiceTestLive = Layer.succeed(TaxCalculationService, {
  calculateTax: () => Effect.dieMessage("TaxCalculationService test stub: calculateTax"),
})

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.dieMessage(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.dieMessage(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

const SourceSyncServiceWithDepsTestLive = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncRunServiceWithDepsTestLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SourceSyncServiceWithDepsTestLive),
  Layer.provide(RepositoriesLive)
)

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceWithDepsTestLive,
  SourceSyncRunServiceWithDepsTestLive,
  TaxCalculationServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(TaxMaxiApiLive),
  Layer.provide(AnonSessionServiceLive),
  Layer.provide(SIWXProofVerifierTestLive),
  Layer.provide(X402PaymentValidatorTestLive),
  Layer.provide(SimpleTokenValidatorLive),
  Layer.provideMerge(PersistenceLayer),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

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
      return yield* Effect.dieMessage("Missing seeded coinbase CEX fixture")
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
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            scopes: "wallet:accounts:read wallet:transactions:read",
          })
          .returning({ id: schema.cexAccount.id })

        if (createdAccount === undefined) {
          return yield* Effect.dieMessage("Failed to create cex account fixture")
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
      new Date("2026-01-01T00:05:00.000Z"),
      status === "failed" ? "Provider failed" : null,
      JSON.stringify({
        importedRecords: status === "completed" ? 4 : 0,
        normalizedRecords: status === "completed" ? 3 : 0,
        failedRecords: status === "failed" ? 1 : 0,
      }),
      jobId,
    ],
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("SyncRunsApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(async () => {
    queueEvents.length = 0
    await Effect.runPromise(context.recreateTestDatabase())
  })

  it.effect("starts a user-wide run with one queued child item per source", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceIds = [crypto.randomUUID(), crypto.randomUUID()]
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
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceIds = [crypto.randomUUID()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const loaded = yield* client.syncRuns.getSyncRun({
        path: { runId: started.runId },
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
      const userId = crypto.randomUUID()
      const otherUserId = crypto.randomUUID()
      yield* seedCoinbaseSources({
        userId,
        principalId: crypto.randomUUID(),
        sourceIds: [crypto.randomUUID()],
      })
      yield* seedPrincipalUser({ userId: otherUserId, principalId: crypto.randomUUID() })

      const ownerClient = yield* makeAuthenticatedClient({ userId })
      const started = yield* ownerClient.syncRuns.startSyncRun(undefined)
      const otherClient = yield* makeAuthenticatedClient({ userId: otherUserId })
      const result = yield* otherClient.syncRuns
        .getSyncRun({
          path: { runId: started.runId },
        })
        .pipe(Effect.either)

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("SyncRunNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("refreshes child completion into aggregate API status", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceIds = [crypto.randomUUID(), crypto.randomUUID()]
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
        return yield* Effect.dieMessage("Expected two sync run items")
      }

      yield* markJobTerminal({ jobId: firstItem.jobId, status: "completed" })
      yield* markJobTerminal({ jobId: secondItem.jobId, status: "failed" })

      const loaded = yield* client.syncRuns.getSyncRun({
        path: { runId: started.runId },
      })

      expect(loaded.status).toBe("partially_failed")
      expect(loaded.completedSourceCount).toBe(1)
      expect(loaded.failedSourceCount).toBe(1)
      expect(loaded.items.map((item) => item.status).sort()).toEqual(["completed", "failed"])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
