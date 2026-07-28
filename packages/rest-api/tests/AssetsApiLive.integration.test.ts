import { HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { afterAll, describe, expect, it } from "vitest"
import {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  ProviderAssetDecisionResponse,
  ProviderAssetReviewListResponse,
} from "../src/definitions/AssetsApi.ts"
import { SourceSyncJobResponse, SourceSyncStartResponse } from "../src/definitions/SourcesApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_assets",
})
const TestPgClientLive = context.TestPgClientLive
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})
const TestConfigProvider = ConfigProvider.fromMap(
  new Map([["ANON_SESSION_SECRET", "test-anon-session-secret-32-bytes-long"]])
)

let nextReplayJobId: string | null = null

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: ({ sourceId }) =>
    nextReplayJobId === null
      ? Effect.dieMessage("SourceSyncService test stub: replay job is not configured")
      : Effect.succeed({
          sourceId,
          jobId: nextReplayJobId,
          status: "queued",
          message: null,
        }),
  getSourceSyncJob: ({ sourceId, jobId }) =>
    Effect.succeed({
      sourceId,
      jobId,
      status: "failed",
      message: "Replay failed",
      phase: null,
      processedRecords: null,
      totalRecords: null,
      progressPercent: null,
      importedRecords: null,
      normalizedRecords: null,
      failedRecords: null,
    }),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () =>
    Effect.dieMessage("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.dieMessage("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

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

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceTestLive,
  SourceSyncRunServiceTestLive,
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
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(Layer.setConfigProvider(TestConfigProvider))
)

const getJson = <Response, Encoded, Requirements>({
  path,
  responseSchema,
}: {
  readonly path: string
  readonly responseSchema: Schema.Schema<Response, Encoded, Requirements>
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    const body = yield* response.json
    const decodedBody = yield* Schema.decodeUnknown(responseSchema)(body)

    return {
      status: response.status,
      body: decodedBody,
    }
  }).pipe(Effect.withConfigProvider(TestConfigProvider))

const getStatus = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    return response.status
  }).pipe(Effect.withConfigProvider(TestConfigProvider))

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetsApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  it("lists canonical assets from the asset table without authentication", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets",
        responseSchema: AssetCatalogListResponse,
      }).pipe(
        Effect.withConfigProvider(TestConfigProvider),
        Effect.provide(HttpLive),
        Effect.scoped
      )
    )

    const symbols = response.body.assets.map((asset) => asset.symbol)
    const usdc = response.body.assets.find((asset) => asset.symbol === "USDC")

    expect(response.status).toBe(200)
    expect(symbols).toEqual(expect.arrayContaining(["SOL", "USDC", "USDT"]))
    expect(usdc).toMatchObject({
      blockchainName: "solana",
      contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      isSpam: false,
      name: "USD Coin",
      type: "token",
    })
  })

  it("filters canonical assets by search query", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=usdc",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body.assets.map((asset) => asset.symbol)).toEqual(["USDC"])
  })

  it("returns asset details by asset id", async () => {
    const listResponse = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=usdc",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const usdc = listResponse.body.assets[0]

    expect(usdc).toBeDefined()
    if (usdc === undefined) {
      return
    }

    const detailResponse = await Effect.runPromise(
      getJson({
        path: `/v1/assets/${usdc.id}`,
        responseSchema: AssetCatalogAssetResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(detailResponse.status).toBe(200)
    expect(detailResponse.body).toMatchObject({
      id: usdc.id,
      blockchainId: usdc.blockchainId,
      blockchainExplorerUrl: "https://explorer.solana.com",
      contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
    })
  })

  it("keeps provider asset review endpoints admin protected", async () => {
    const status = await Effect.runPromise(
      getStatus("/v1/assets/provider-assets").pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(status).toBe(401)
  })

  it("returns provider API provenance with review evidence", async () => {
    const userId = crypto.randomUUID()
    const providerAssetId = crypto.randomUUID()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.users).values({
          id: userId,
          email: `${userId}@asset-review.test`,
          role: "admin",
        })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetId,
          provider: "coinbase",
          providerAssetId: "1d3c2625-a8d9-5458-84d0-437d75540421",
          currencyCode: "ZEC",
          name: "Zcash",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { code: "ZEC", name: "Zcash", type: "crypto" },
          retrievedAt: new Date("2026-07-20T09:00:00.000Z"),
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAssetId,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
      })
    )

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const request = HttpClientRequest.get("/v1/assets/provider-assets?q=ZEC").pipe(
          HttpClientRequest.bearerToken(`user_${userId}_admin`)
        )
        const result = yield* HttpClient.execute(request)
        const body = yield* result.json
        return {
          status: result.status,
          body: yield* Schema.decodeUnknown(ProviderAssetReviewListResponse)(body),
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body.providerAssets[0]).toMatchObject({
      id: providerAssetId,
      evidenceSource: {
        providerName: "Coinbase",
        apiName: "Coinbase App API",
        endpoint: "GET /v2/currencies/crypto",
        payloadKind: "direct_response",
        typeSource: "provider",
      },
    })
  })

  it("does not allow an admin to map a fiat provider row to a crypto asset", async () => {
    const userId = crypto.randomUUID()
    const providerAssetId = crypto.randomUUID()
    const canonicalAssetId = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.users).values({
          id: userId,
          email: `${userId}@asset-review.test`,
          role: "admin",
        })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetId,
          provider: "coinbase",
          providerAssetId: "fiat-eur",
          currencyCode: "EUR",
          name: "Euro",
          providerType: "fiat",
          rawProviderPayload: { code: "EUR" },
          retrievedAt: new Date("2026-07-20T09:00:00.000Z"),
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAssetId,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        const assets = yield* db
          .select({ id: schema.assets.id, symbol: schema.assets.symbol })
          .from(schema.assets)
        const asset = assets[0]
        if (asset === undefined) return yield* Effect.dieMessage("Asset fixture is missing")
        return asset.id
      })
    )

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `/v1/assets/provider-assets/${providerAssetId}/map`
        ).pipe(
          HttpClientRequest.bearerToken(`user_${userId}_admin`),
          HttpClientRequest.bodyUnsafeJson({ canonicalAssetId })
        )
        return yield* HttpClient.execute(request)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(400)
  })

  it("allows an admin to approve a fiat provider row as its canonical currency", async () => {
    const userId = crypto.randomUUID()
    const providerAssetId = crypto.randomUUID()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.users).values({
          id: userId,
          email: `${userId}@asset-review.test`,
          role: "admin",
        })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetId,
          provider: "coinbase",
          providerAssetId: "fiat-usd",
          currencyCode: "usd",
          name: "US Dollar",
          providerType: "fiat",
          rawProviderPayload: { code: "USD" },
          retrievedAt: new Date("2026-07-20T09:00:00.000Z"),
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAssetId,
          mappingKind: "fiat",
          mappingStatus: "pending_review",
        })
      })
    )

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `/v1/assets/provider-assets/${providerAssetId}/approve-fiat`
        ).pipe(HttpClientRequest.bearerToken(`user_${userId}_admin`))
        const result = yield* HttpClient.execute(request)
        const body = yield* result.json
        return {
          status: result.status,
          body: yield* Schema.decodeUnknown(ProviderAssetDecisionResponse)(body),
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body.providerAsset).toMatchObject({
      id: providerAssetId,
      mappingKind: "fiat",
      canonicalAssetId: null,
      canonicalAssetSymbol: null,
      canonicalFiatCurrency: "USD",
      mappingStatus: "approved",
      reviewedBy: userId,
    })
  })

  it("binds replay status and retry to the exact review job", async () => {
    const userId = crypto.randomUUID()
    const principalId = crypto.randomUUID()
    const sourceId = crypto.randomUUID()
    const providerAssetId = crypto.randomUUID()
    const reviewedJobId = crypto.randomUUID()
    const unrelatedJobId = crypto.randomUUID()
    const retriedJobId = crypto.randomUUID()

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* seedSyncEngineRepositoryFixture({ userId, principalId, sourceId })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetId,
          provider: "coinbase",
          providerAssetId: "review-replay-binding",
          currencyCode: "RRB",
          name: "Replay Review Binding",
          providerType: "crypto",
          rawProviderPayload: { code: "RRB" },
          retrievedAt: new Date("2026-07-20T09:00:00.000Z"),
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAssetId,
          mappingKind: "asset",
          canonicalAssetSymbol: "RRB",
          mappingStatus: "approved",
          reviewedBy: userId,
          reviewedAt: new Date("2026-07-20T10:00:00.000Z"),
        })
        yield* db.insert(schema.processingJobs).values([
          {
            id: reviewedJobId,
            sourceId,
            principalId,
            mode: "replay",
            status: "failed",
          },
          {
            id: unrelatedJobId,
            sourceId,
            principalId,
            mode: "replay",
            status: "completed",
          },
          {
            id: retriedJobId,
            sourceId,
            principalId,
            mode: "replay",
            status: "pending",
          },
        ])
        yield* db.insert(schema.providerAssetReviewReplays).values({
          providerAssetRowId: providerAssetId,
          sourceId,
          principalId,
          jobId: reviewedJobId,
        })
      })
    )

    const getReplay = (jobId: string) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(
          `/v1/assets/provider-assets/${providerAssetId}/replays/${sourceId}/jobs/${jobId}`
        ).pipe(HttpClientRequest.bearerToken(`user_${userId}_admin`))
        const response = yield* HttpClient.execute(request)
        const body = yield* response.json
        return {
          status: response.status,
          body:
            response.status === 200
              ? yield* Schema.decodeUnknown(SourceSyncJobResponse)(body)
              : body,
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

    const reviewed = await Effect.runPromise(getReplay(reviewedJobId))
    const unrelated = await Effect.runPromise(getReplay(unrelatedJobId))

    expect(reviewed.status).toBe(200)
    expect(reviewed.body).toMatchObject({ jobId: reviewedJobId, sourceId })
    expect(unrelated.status).toBe(404)

    nextReplayJobId = retriedJobId
    try {
      const retried = await Effect.runPromise(
        Effect.gen(function* () {
          const request = HttpClientRequest.post(
            `/v1/assets/provider-assets/${providerAssetId}/replays/${sourceId}/jobs/${reviewedJobId}/retry`
          ).pipe(HttpClientRequest.bearerToken(`user_${userId}_admin`))
          const response = yield* HttpClient.execute(request)
          const body = yield* response.json
          return {
            status: response.status,
            body: yield* Schema.decodeUnknown(SourceSyncStartResponse)(body),
          }
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
      )

      expect(retried.status).toBe(200)
      expect(retried.body).toMatchObject({ jobId: retriedJobId, sourceId })
      expect((await Effect.runPromise(getReplay(reviewedJobId))).status).toBe(404)
      expect((await Effect.runPromise(getReplay(retriedJobId))).status).toBe(200)
    } finally {
      nextReplayJobId = null
    }
  })

  it("records an admin rejection once and returns a conflict for a stale decision", async () => {
    const userId = crypto.randomUUID()
    const providerAssetId = crypto.randomUUID()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.users).values({
          id: userId,
          email: `${userId}@asset-review.test`,
          role: "admin",
        })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetId,
          provider: "coinbase",
          providerAssetId: "spam-observation",
          currencyCode: "SCAM",
          name: "Misleading token",
          providerType: "crypto",
          rawProviderPayload: { warning: "spam" },
          retrievedAt: new Date("2026-07-20T09:00:00.000Z"),
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAssetId,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
      })
    )

    const reject = () =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `/v1/assets/provider-assets/${providerAssetId}/reject`
        ).pipe(
          HttpClientRequest.bearerToken(`user_${userId}_admin`),
          HttpClientRequest.bodyUnsafeJson({ rejectionReason: "Confirmed spam" })
        )
        const response = yield* HttpClient.execute(request)
        const body = yield* response.json
        return {
          status: response.status,
          body:
            response.status === 200
              ? yield* Schema.decodeUnknown(ProviderAssetDecisionResponse)(body)
              : body,
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

    const first = await Effect.runPromise(reject())
    const second = await Effect.runPromise(reject())

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      providerAsset: {
        mappingStatus: "rejected",
        reviewerNotes: "Confirmed spam",
        reviewedBy: userId,
      },
    })
    expect(second.status).toBe(409)
  })
})
