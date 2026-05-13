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
  SourceSyncRunService,
  TransferReconciliationService,
  type SourceSyncQueuePayload,
  type SourceSyncRunServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { SourceSyncServiceLive } from "@my/sync-engine/layers"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { TaxCalculationService } from "../../persistence/src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sources",
})
const TestPgClientLive = context.TestPgClientLive

const queuedAt = new Date("2026-01-01T00:00:00.000Z")
const queueEvents: Array<SourceSyncQueuePayload> = []

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

const SourceSyncQueueFailureTestLive = Layer.succeed(SourceSyncQueue, {
  enqueueSourceSyncJob: () =>
    Effect.fail(
      new SourceSyncQueueError({
        operation: "test.enqueueSourceSyncJob",
        cause: "queue unavailable",
      })
    ),
})

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () =>
    Effect.dieMessage("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.dieMessage("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

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

const makeSourceSyncServiceWithDepsTestLive = (
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>
) =>
  SourceSyncServiceLive.pipe(Layer.provide(sourceSyncQueueLayer), Layer.provide(RepositoriesLive))

const makePersistenceLayer = (
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>
) =>
  Layer.mergeAll(
    RepositoriesLive,
    makeSourceSyncServiceWithDepsTestLive(sourceSyncQueueLayer),
    SourceSyncRunServiceTestLive,
    TaxCalculationServiceTestLive,
    TransferReconciliationServiceTestLive,
    AuthServiceTestLive,
    PasswordHasherTestLive
  ).pipe(Layer.provideMerge(TestPgClientLive))

const makeHttpLive = (
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>
) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(TaxMaxiApiLive),
    Layer.provide(SimpleTokenValidatorLive),
    Layer.provideMerge(makePersistenceLayer(sourceSyncQueueLayer)),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )

const HttpLive = makeHttpLive(SourceSyncQueueTestLive)
const QueueFailureHttpLive = makeHttpLive(SourceSyncQueueFailureTestLive)

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const seedCoinbaseSource = ({
  userId,
  principalId,
  sourceId,
}: {
  readonly userId: string
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `${sourceId}@taxmaxi.test`,
      name: "Sources API Queue Test User",
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
      name: "Coinbase",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      principalId,
    })
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
      name: "Sources API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("SourcesApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(async () => {
    queueEvents.length = 0
    await Effect.runPromise(context.recreateTestDatabase())
  })

  it.effect("creates an authenticated Solana source without starting sync", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const walletAddress = "So11111111111111111111111111111111111111112"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Demo Solana wallet",
        },
      })

      expect(response.created).toBe(true)
      expect(response.syncJob).toBeNull()
      expect(response.source).toMatchObject({
        principalId,
        name: "Demo Solana wallet",
        providerKey: "solana",
      })
      expect(response.source.sourceRef._tag).toBe("onchain")

      const db = yield* drizzle
      const storedAddresses = yield* db
        .select({
          address: schema.addresses.address,
          type: schema.addresses.type,
          principalId: schema.addresses.principalId,
        })
        .from(schema.addresses)

      expect(storedAddresses).toEqual([
        {
          address: walletAddress,
          type: "solana",
          principalId,
        },
      ])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reuses an authenticated Solana source for the same wallet", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const walletAddress = "So11111111111111111111111111111111111111112"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const first = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Reusable wallet",
        },
      })
      const second = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Reusable wallet renamed",
        },
      })

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.source.id).toBe(first.source.id)
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("infers chain type when creating an authenticated source", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const walletAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
        },
      })

      expect(response.created).toBe(true)
      expect(response.source.providerKey).toBe("evm")

      const db = yield* drizzle
      const [storedAddress] = yield* db
        .select({
          address: schema.addresses.address,
          type: schema.addresses.type,
        })
        .from(schema.addresses)

      expect(storedAddress).toEqual({
        address: walletAddress,
        type: "evm",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when wallet address chain type cannot be inferred", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "not-an-address",
          },
        })
        .pipe(Effect.either)

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("SourceBadRequestError")
        expect(result.left.message).toBe("Invalid crypto address.")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("starts a source sync by creating a queued job without provider execution", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceId = crypto.randomUUID()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const job = yield* client.sources.startSourceSyncJob({
        path: { sourceId },
      })

      expect(job).toMatchObject({
        sourceId,
        status: "queued",
        message: null,
      })
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        jobId: job.jobId,
        sourceId,
        principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reads queued status from Postgres after start", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceId = crypto.randomUUID()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.sources.startSourceSyncJob({
        path: { sourceId },
      })
      const status = yield* client.sources.getSourceSyncJobStatus({
        path: { sourceId, jobId: started.jobId },
      })

      expect(status).toEqual({
        sourceId,
        jobId: started.jobId,
        status: "queued",
        importedRecords: null,
        normalizedRecords: null,
        failedRecords: null,
        message: null,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the same queued job for duplicate start requests", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceId = crypto.randomUUID()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const firstJob = yield* client.sources.startSourceSyncJob({
        path: { sourceId },
      })
      const secondJob = yield* client.sources.startSourceSyncJob({
        path: { sourceId },
      })

      expect(secondJob.jobId).toBe(firstJob.jobId)
      expect(secondJob.status).toBe("queued")
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("replay enqueues a replay-mode job", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceId = crypto.randomUUID()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const replay = yield* client.sources.replaySourceSyncJob({
        path: { sourceId },
      })

      expect(replay.status).toBe("queued")
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        jobId: replay.jobId,
        mode: "replay",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns an internal server error when queue enqueue fails", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      const sourceId = crypto.randomUUID()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .startSourceSyncJob({
          path: { sourceId },
        })
        .pipe(Effect.either)

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("InternalServerError")
        expect(result.left.message).toBe("Failed to enqueue source sync job.")
      }
    }).pipe(Effect.provide(QueueFailureHttpLive), Effect.scoped)
  )
})
