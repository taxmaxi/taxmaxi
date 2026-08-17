import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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
import { describe, expect, it } from "vitest"
import {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  PendingAssetListResponse,
  ProviderAssetDecisionResponse,
  ProviderAssetResolutionProposalListResponse,
  ProviderAssetReviewDetailResponse,
  ProviderAssetReviewListResponse,
  UnresolvedTransferReconciliationListResponse,
} from "../src/definitions/AssetsApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { eq } from "../../persistence/src/query/index.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
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
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)
const ADMIN_BEARER_TOKEN = "user_00000000-0000-4000-8000-000000000099_admin"

const SourceSyncServiceTestLive = Layer.effect(
  SourceSyncService,
  Effect.map(drizzle, (db) =>
    SourceSyncService.of({
      startSourceSyncJob: () =>
        Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
      replaySourceSyncJob: ({ sourceId }) =>
        Effect.gen(function* () {
          const jobs = yield* db
            .select({ id: schema.processingJobs.id, status: schema.processingJobs.status })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, sourceId))
            .pipe(Effect.orDie)
          const job = jobs.find(({ status }) => status === "pending" || status === "processing")
          if (job === undefined) {
            return yield* Effect.die("Expected a durable replay job before queue dispatch.")
          }
          return { sourceId, jobId: job.id, status: "queued", message: null }
        }),
      getSourceSyncJob: ({ sourceId, jobId }) =>
        Effect.succeed({
          sourceId,
          jobId,
          status: "queued",
          message: null,
          phase: null,
          processedRecords: null,
          totalRecords: null,
          progressPercent: null,
          importedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
    } satisfies SourceSyncServiceShape)
  )
)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.die(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.die(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

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

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const getJson = <Response, Requirements>({
  path,
  responseSchema,
}: {
  readonly path: string
  readonly responseSchema: Schema.ConstraintDecoder<Response, Requirements>
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    const body = yield* response.json
    const decodedBody = yield* Schema.decodeUnknownEffect(responseSchema)(body)

    return {
      status: response.status,
      body: decodedBody,
    }
  })

const getStatus = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    return response.status
  })

const getAdminJson = <Response, Requirements>({
  path,
  responseSchema,
}: {
  readonly path: string
  readonly responseSchema: Schema.ConstraintDecoder<Response, Requirements>
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(
      HttpClientRequest.bearerToken(ADMIN_BEARER_TOKEN),
      HttpClient.execute
    )
    const body = yield* response.json
    const decodedBody = yield* Schema.decodeUnknownEffect(responseSchema)(body)

    return {
      status: response.status,
      body: decodedBody,
    }
  })

const getAdminStatus = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(
      HttpClientRequest.bearerToken(ADMIN_BEARER_TOKEN),
      HttpClient.execute
    )
    return response.status
  })

const postAdminJson = <Response, Requirements>({
  path,
  payload,
  responseSchema,
}: {
  readonly path: string
  readonly payload: unknown
  readonly responseSchema: Schema.ConstraintDecoder<Response, Requirements>
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyJsonUnsafe(payload),
      HttpClientRequest.bearerToken(ADMIN_BEARER_TOKEN),
      HttpClient.execute
    )
    const body = yield* response.json
    const decodedBody = yield* Schema.decodeUnknownEffect(responseSchema)(body)

    return { status: response.status, body: decodedBody }
  })

const postAdminStatus = ({ path, payload }: { readonly path: string; readonly payload: unknown }) =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.bodyJsonUnsafe(payload),
    HttpClientRequest.bearerToken(ADMIN_BEARER_TOKEN),
    HttpClient.execute,
    Effect.map((response) => response.status)
  )

const encodeTestCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url")

const decodeTestProviderAssetCursor = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      discoveredAt: Schema.DateFromString,
      providerAssetRowId: Schema.String.check(Schema.isUUID()),
    })
  )
)

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetsApiLive", () => {
  it("lists canonical assets from the asset table without authentication", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    const symbols = response.body.assets.map((asset) => asset.symbol)
    const bitcoin = response.body.assets.find((asset) => asset.symbol === "BTC")
    const usdc = response.body.assets.find((asset) => asset.symbol === "USDC")

    expect(response.status).toBe(200)
    expect(response.body.page).toMatchObject({ hasMore: false, nextCursor: null })
    expect(symbols).toEqual(expect.arrayContaining(["SOL", "USDC", "USDT"]))
    expect(bitcoin).toMatchObject({
      name: "Bitcoin",
      logoUrl: expect.stringMatching(/^https:\/\//),
    })
    expect(usdc).toMatchObject({
      name: "USD Coin",
      coingeckoCoinId: "usd-coin",
      type: "fungible",
      representations: expect.arrayContaining([
        expect.objectContaining({
          blockchainName: "solana",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          decimals: 6,
          type: "token",
        }),
        expect.objectContaining({
          blockchainName: "ethereum",
          contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          decimals: 6,
          type: "token",
        }),
        expect.objectContaining({
          blockchainName: "base",
          contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          decimals: 6,
          type: "token",
        }),
      ]),
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

  it.each(["/v1/assets", "/v1/assets/pending"])(
    "bounds public asset searches at the API boundary for %s",
    async (path) => {
      const acceptedQuery = "a".repeat(128)
      const rejectedQuery = "a".repeat(129)
      const acceptedStatus = await Effect.runPromise(
        getStatus(`${path}?q=${acceptedQuery}`).pipe(Effect.provide(HttpLive), Effect.scoped)
      )
      const rejectedStatus = await Effect.runPromise(
        getStatus(`${path}?q=${rejectedQuery}`).pipe(Effect.provide(HttpLive), Effect.scoped)
      )

      expect(acceptedStatus).toBe(200)
      expect(rejectedStatus).toBe(400)
    }
  )

  it.each([
    { endpoint: "canonical assets", max: 500, path: "/v1/assets", requiresAdmin: false },
    { endpoint: "pending assets", max: 100, path: "/v1/assets/pending", requiresAdmin: false },
    {
      endpoint: "admin provider assets",
      max: 100,
      path: "/v1/assets/provider-assets",
      requiresAdmin: true,
    },
    {
      endpoint: "admin unresolved transfer reconciliations",
      max: 100,
      path: "/v1/assets/transfer-reconciliations/unresolved",
      requiresAdmin: true,
    },
  ] as const)(
    "enforces list limit boundaries for $endpoint",
    async ({ max, path, requiresAdmin }) => {
      for (const { expectedStatus, limit } of [
        { expectedStatus: 400, limit: 0 },
        { expectedStatus: 200, limit: 1 },
        { expectedStatus: 200, limit: max },
        { expectedStatus: 400, limit: max + 1 },
      ]) {
        const requestPath = `${path}?limit=${limit}`
        const status = await Effect.runPromise(
          (requiresAdmin ? getAdminStatus(requestPath) : getStatus(requestPath)).pipe(
            Effect.provide(HttpLive),
            Effect.scoped
          )
        )

        expect(status).toBe(expectedStatus)
      }
    }
  )

  it("preserves canonical asset search by CoinGecko id", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=usd-coin",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.body.assets.map((asset) => asset.symbol)).toEqual(["USDC"])
  })

  it("preserves canonical asset search by public UUID", async () => {
    const assetResponse = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=usd-coin",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const assetId = assetResponse.body.assets[0]?.id

    expect(assetId).toBeDefined()
    if (assetId === undefined) {
      return
    }

    const response = await Effect.runPromise(
      getJson({
        path: `/v1/assets?q=${assetId}`,
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.body.assets.map((asset) => asset.id)).toEqual([assetId])
  })

  it("matches search tokens across different representations of one asset", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=ethereum%20EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.body.assets.map((asset) => asset.symbol)).toEqual(["USDC"])
  })

  it("paginates canonical assets without skipping or repeating the boundary asset", async () => {
    const firstPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets?limit=1",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const firstAsset = firstPage.body.assets[0]

    expect(firstAsset).toBeDefined()
    expect(firstPage.body.page).toMatchObject({
      hasMore: true,
    })
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String))
    expect(firstPage.body.page.nextCursor).not.toBe(firstAsset?.id)

    if (firstAsset === undefined || firstPage.body.page.nextCursor === null) {
      return
    }

    const secondPage = await Effect.runPromise(
      getJson({
        path: `/v1/assets?limit=1&cursor=${firstPage.body.page.nextCursor}`,
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(secondPage.body.assets).toHaveLength(1)
    expect(secondPage.body.assets[0]?.id).not.toBe(firstAsset.id)
  })

  it("paginates assets with duplicate names and symbols by stable identity", async () => {
    const duplicateAssetIds = [crypto.randomUUID(), crypto.randomUUID()]

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.assets).values(
          duplicateAssetIds.map((id) => ({
            id,
            name: "Cursor Duplicate",
            symbol: "CURSOR_DUPLICATE",
            type: "fungible" as const,
          }))
        )
      })
    )

    const firstPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=%20cursor%20%20CURSOR_DUPLICATE%20&limit=1",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const cursor = firstPage.body.page.nextCursor

    expect(cursor).toEqual(expect.any(String))
    if (cursor === null) {
      return
    }

    const secondPage = await Effect.runPromise(
      getJson({
        path: `/v1/assets?q=%20cursor%20%20CURSOR_DUPLICATE%20&limit=1&cursor=${cursor}`,
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const pagedIds = [firstPage.body.assets[0]?.id, secondPage.body.assets[0]?.id]

    expect(new Set(pagedIds)).toEqual(new Set(duplicateAssetIds))
    expect(secondPage.body.page).toEqual({ hasMore: false, nextCursor: null })

    const nonMatch = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=cursor%20missing",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(nonMatch.body.assets).toEqual([])
  })

  it("does not repeat an approved asset when its display fields change between pages", async () => {
    const assetIds = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
      "00000000-0000-4000-8000-000000000103",
    ] as const

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.assets).values(
          assetIds.map((id, index) => ({
            id,
            name: `Mutable cursor asset ${index + 1}`,
            symbol: `MUTABLE_${index + 1}`,
            coingeckoCoinId: `mutable-cursor-${index + 1}`,
            type: "fungible" as const,
          }))
        )
      })
    )

    const firstPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=mutable-cursor&limit=1",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const seenIds = firstPage.body.assets.map((asset) => asset.id)

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db
          .update(schema.assets)
          .set({ name: "Z moved cursor asset", symbol: "ZZZ_MOVED" })
          .where(eq(schema.assets.id, assetIds[0]))
      })
    )

    let cursor = firstPage.body.page.nextCursor
    while (cursor !== null) {
      const page = await Effect.runPromise(
        getJson({
          path: `/v1/assets?q=mutable-cursor&limit=1&cursor=${cursor}`,
          responseSchema: AssetCatalogListResponse,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
      )
      seenIds.push(...page.body.assets.map((asset) => asset.id))
      cursor = page.body.page.nextCursor
    }

    expect(seenIds).toEqual(assetIds)
  })

  it("treats SQL wildcard characters as literal asset search text", async () => {
    const literalAssetId = crypto.randomUUID()

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.assets).values({
          id: literalAssetId,
          name: "100%_literal asset",
          symbol: "LITERAL_SEARCH",
          type: "fungible",
        })
      })
    )

    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets?q=%25_literal",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.body.assets.map((asset) => asset.id)).toEqual([literalAssetId])
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
      symbol: "USDC",
      representations: expect.arrayContaining([
        expect.objectContaining({
          blockchainExplorerUrl: "https://explorer.solana.com",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        }),
      ]),
    })
  })

  it("lists pending assets without authentication or internal review fields", async () => {
    const providerAssetId = "10000000-0000-4000-8000-000000000001"
    const secondProviderAssetId = "20000000-0000-4000-8000-000000000002"
    const pendingFiatId = "30000000-0000-4000-8000-000000000003"
    const rejectedAssetId = "40000000-0000-4000-8000-000000000004"

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.providerAssets).values([
          {
            id: providerAssetId,
            provider: "public-test-provider",
            providerAssetId: "public-pending-asset",
            currencyCode: "PENDING",
            name: "Pending Asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
          {
            id: secondProviderAssetId,
            provider: "public-test-provider",
            providerAssetId: "public-pending-asset-2",
            currencyCode: "PENDING_TWO",
            name: "Second Pending Asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
          {
            id: pendingFiatId,
            provider: "public-test-provider",
            providerAssetId: "public-pending-fiat",
            currencyCode: "PENDING_FIAT",
            name: "Pending Fiat",
            providerType: "fiat",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
          {
            id: rejectedAssetId,
            provider: "public-test-provider",
            providerAssetId: "public-rejected-asset",
            currencyCode: "REJECTED",
            name: "Rejected Asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
        ])
        yield* db.insert(schema.providerAssetMappings).values([
          {
            providerAssetRowId: providerAssetId,
            mappingKind: "asset",
            mappingStatus: "pending_review",
            reviewerNotes: "This must remain private.",
            sourceNotes: "This must also remain private.",
          },
          {
            providerAssetRowId: secondProviderAssetId,
            mappingKind: "asset",
            mappingStatus: "pending_review",
          },
          {
            providerAssetRowId: pendingFiatId,
            mappingKind: "fiat",
            mappingStatus: "pending_review",
          },
          {
            providerAssetRowId: rejectedAssetId,
            mappingKind: "asset",
            mappingStatus: "rejected",
          },
        ])
      })
    )

    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets/pending?provider=public-test-provider&limit=1",
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body.pendingAssets).toEqual([
      {
        id: providerAssetId,
        provider: "public-test-provider",
        providerAssetId: "public-pending-asset",
        symbol: "PENDING",
        name: "Pending Asset",
        providerType: "crypto",
      },
    ])
    expect(response.body.page).toEqual({
      hasMore: true,
      nextCursor: expect.any(String),
    })
    expect(JSON.stringify(response.body)).not.toContain("private")

    const secondPage = await Effect.runPromise(
      getJson({
        path: `/v1/assets/pending?provider=public-test-provider&limit=1&cursor=${response.body.page.nextCursor}`,
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(secondPage.body).toEqual({
      pendingAssets: [
        {
          id: secondProviderAssetId,
          provider: "public-test-provider",
          providerAssetId: "public-pending-asset-2",
          symbol: "PENDING_TWO",
          name: "Second Pending Asset",
          providerType: "crypto",
        },
      ],
      page: {
        nextCursor: null,
        hasMore: false,
      },
    })

    const searchedPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets/pending?provider=public-test-provider&q=Second%20PENDING_TWO&limit=1",
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(searchedPage.body.pendingAssets.map((asset) => asset.id)).toEqual([
      secondProviderAssetId,
    ])
    expect(searchedPage.body.page).toEqual({ hasMore: false, nextCursor: null })
  })

  it("paginates duplicate pending symbols by provider asset identity", async () => {
    const duplicateIds = [crypto.randomUUID(), crypto.randomUUID()]

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.providerAssets).values(
          duplicateIds.map((id, index) => ({
            id,
            provider: "public-duplicate-provider",
            providerAssetId: `duplicate-${index + 1}`,
            currencyCode: "DUPLICATE",
            name: "Duplicate pending asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          }))
        )
        yield* db.insert(schema.providerAssetMappings).values(
          duplicateIds.map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
          }))
        )
      })
    )

    const firstPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets/pending?provider=public-duplicate-provider&limit=1",
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const cursor = firstPage.body.page.nextCursor

    expect(cursor).toEqual(expect.any(String))
    if (cursor === null) {
      return
    }

    const secondPage = await Effect.runPromise(
      getJson({
        path: `/v1/assets/pending?provider=public-duplicate-provider&limit=1&cursor=${cursor}`,
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const pagedIds = [firstPage.body.pendingAssets[0]?.id, secondPage.body.pendingAssets[0]?.id]

    expect(new Set(pagedIds)).toEqual(new Set(duplicateIds))
    expect(secondPage.body.page).toEqual({ hasMore: false, nextCursor: null })
  })

  it("does not repeat a pending asset when its currency code changes between pages", async () => {
    const providerAssetIds = [
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
      "00000000-0000-4000-8000-000000000203",
    ] as const

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.providerAssets).values(
          providerAssetIds.map((id, index) => ({
            id,
            provider: "public-mutable-cursor-provider",
            providerAssetId: `mutable-${index + 1}`,
            currencyCode: `MUTABLE_${index + 1}`,
            name: `Mutable pending asset ${index + 1}`,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          }))
        )
        yield* db.insert(schema.providerAssetMappings).values(
          providerAssetIds.map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
          }))
        )
      })
    )

    const firstPage = await Effect.runPromise(
      getJson({
        path: "/v1/assets/pending?provider=public-mutable-cursor-provider&limit=1",
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const seenIds = firstPage.body.pendingAssets.map((asset) => asset.id)

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db
          .update(schema.providerAssets)
          .set({ currencyCode: "ZZZ_MOVED" })
          .where(eq(schema.providerAssets.id, providerAssetIds[0]))
      })
    )

    let cursor = firstPage.body.page.nextCursor
    while (cursor !== null) {
      const page = await Effect.runPromise(
        getJson({
          path: `/v1/assets/pending?provider=public-mutable-cursor-provider&limit=1&cursor=${cursor}`,
          responseSchema: PendingAssetListResponse,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
      )
      seenIds.push(...page.body.pendingAssets.map((asset) => asset.id))
      cursor = page.body.page.nextCursor
    }

    expect(seenIds).toEqual(providerAssetIds)
  })

  it("treats SQL wildcard characters as literal pending-asset search text", async () => {
    const literalPendingId = crypto.randomUUID()
    const unrelatedPendingId = crypto.randomUUID()

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.providerAssets).values([
          {
            id: literalPendingId,
            provider: "public-literal-provider",
            providerAssetId: "literal",
            currencyCode: "LITERAL_PENDING",
            name: "Pending 100%_literal asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
          {
            id: unrelatedPendingId,
            provider: "public-literal-provider",
            providerAssetId: "unrelated",
            currencyCode: "UNRELATED_PENDING",
            name: "Unrelated pending asset",
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          },
        ])
        yield* db.insert(schema.providerAssetMappings).values(
          [literalPendingId, unrelatedPendingId].map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
          }))
        )
      })
    )

    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets/pending?provider=public-literal-provider&q=%25_literal",
        responseSchema: PendingAssetListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.body.pendingAssets.map((asset) => asset.id)).toEqual([literalPendingId])
  })

  it.each([
    {
      endpoint: "canonical assets",
      path: `/v1/assets?cursor=${Buffer.from("not-json").toString("base64url")}`,
      requiresAdmin: false,
    },
    {
      endpoint: "pending assets",
      path: `/v1/assets/pending?cursor=${encodeTestCursor({ version: 1, providerAssetRowId: crypto.randomUUID() })}`,
      requiresAdmin: false,
    },
    {
      endpoint: "canonical assets with a provider cursor",
      path: `/v1/assets?cursor=${encodeTestCursor({ version: 2, providerAssetRowId: crypto.randomUUID() })}`,
      requiresAdmin: false,
    },
    {
      endpoint: "pending assets with a canonical cursor",
      path: `/v1/assets/pending?cursor=${encodeTestCursor({ version: 2, assetId: crypto.randomUUID() })}`,
      requiresAdmin: false,
    },
    {
      endpoint: "admin provider assets",
      path: `/v1/assets/provider-assets?cursor=${Buffer.from("not-json").toString("base64url")}`,
      requiresAdmin: true,
    },
    {
      endpoint: "admin provider assets with a legacy raw UUID cursor",
      path: `/v1/assets/provider-assets?cursor=${crypto.randomUUID()}`,
      requiresAdmin: true,
    },
    {
      endpoint: "admin provider assets with a canonical cursor",
      path: `/v1/assets/provider-assets?cursor=${encodeTestCursor({ version: 2, assetId: crypto.randomUUID() })}`,
      requiresAdmin: true,
    },
    {
      endpoint: "admin unresolved transfer reconciliations",
      path: `/v1/assets/transfer-reconciliations/unresolved?cursor=${Buffer.from("not-json").toString("base64url")}`,
      requiresAdmin: true,
    },
  ] as const)("rejects an invalid cursor for $endpoint", async ({ path, requiresAdmin }) => {
    const status = await Effect.runPromise(
      (requiresAdmin ? getAdminStatus(path) : getStatus(path)).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )
    )

    expect(status).toBe(400)
  })

  it("paginates authenticated provider asset reviews with the opaque cursor", async () => {
    const providerAssetIds = [crypto.randomUUID(), crypto.randomUUID()]

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.providerAssets).values(
          providerAssetIds.map((id, index) => ({
            id,
            provider: "admin-cursor-provider",
            providerAssetId: `admin-cursor-${index + 1}`,
            currencyCode: `ADMIN_CURSOR_${index + 1}`,
            name: `Admin cursor asset ${index + 1}`,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-08T10:00:00.000Z"),
          }))
        )
        yield* db.insert(schema.providerAssetMappings).values(
          providerAssetIds.map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
          }))
        )
      })
    )

    const firstPage = await Effect.runPromise(
      getAdminJson({
        path: "/v1/assets/provider-assets?provider=admin-cursor-provider&limit=1",
        responseSchema: ProviderAssetReviewListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const cursor = firstPage.body.page.nextCursor
    const firstProviderAsset = firstPage.body.providerAssets[0]

    expect(firstPage.status).toBe(200)
    expect(cursor).toEqual(expect.any(String))
    if (cursor === null || firstProviderAsset === undefined) {
      return
    }
    expect(
      decodeTestProviderAssetCursor(Buffer.from(cursor, "base64url").toString("utf8"))
    ).toMatchObject({
      version: 1,
      providerAssetRowId: firstProviderAsset.id,
      discoveredAt: expect.any(Date),
    })

    const secondPage = await Effect.runPromise(
      getAdminJson({
        path: `/v1/assets/provider-assets?provider=admin-cursor-provider&limit=1&cursor=${cursor}`,
        responseSchema: ProviderAssetReviewListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const pagedIds = [firstPage.body.providerAssets[0]?.id, secondPage.body.providerAssets[0]?.id]

    expect(new Set(pagedIds)).toEqual(new Set(providerAssetIds))
    expect(secondPage.body.page).toEqual({ hasMore: false, nextCursor: null })
  })

  it("lists only unresolved reconciliation evidence for admins", async () => {
    const timestamp = new Date("2026-08-13T10:00:00.000Z")
    const principalId = "00000000-0000-4000-8000-000000000181"
    const sourceId = "00000000-0000-4000-8000-000000000182"
    const providerAssetRowId = crypto.randomUUID()
    const providerTransferId = crypto.randomUUID()

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* seedSyncEngineRepositoryFixture({ principalId, sourceId })
        yield* db.insert(schema.providerAssets).values({
          id: providerAssetRowId,
          provider: "admin-reconciliation-test",
          providerAssetId: "admin-reconciliation-asset",
          currencyCode: "ADMIN_RECONCILIATION",
          providerType: "crypto",
          retrievedAt: timestamp,
        })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId,
            externalId: "admin-reconciliation-transaction",
            timestamp,
            providerTransactionType: "send",
            providerStatus: "completed",
            principalId,
          })
          .returning({ id: schema.transactions.id })

        if (transaction === undefined) {
          return yield* Effect.die("Failed to seed admin reconciliation transaction")
        }

        yield* db.insert(schema.providerTransfers).values({
          id: providerTransferId,
          sourceId,
          transactionId: transaction.id,
          externalId: "admin-reconciliation-transfer",
          providerAssetId: providerAssetRowId,
          timestamp,
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account",
          toAddress: "owned-destination",
          networkName: "solana",
          networkHash: "admin-reconciliation-hash",
          amount: "12.5",
        })
        yield* db.insert(schema.transferReconciliations).values({
          principalId,
          providerTransferId,
          status: "needs_review",
          matchReason: "multiple_candidate_onchain_receipts",
          confidence: "0.5",
          deterministic: false,
          reviewMetadata: { candidateTransferIds: [crypto.randomUUID(), crypto.randomUUID()] },
        })
      })
    )

    const response = await Effect.runPromise(
      getAdminJson({
        path: "/v1/assets/transfer-reconciliations/unresolved",
        responseSchema: UnresolvedTransferReconciliationListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body.reconciliations).toEqual([
      expect.objectContaining({
        providerTransferId,
        status: "needs_review",
        matchReason: "multiple_candidate_onchain_receipts",
      }),
    ])
  })

  it("applies one revision-checked provider asset decision through the admin route", async () => {
    const routeUserId = "00000000-0000-4000-8000-000000000099"
    const routePrincipalId = "00000000-0000-4000-8000-000000000142"
    const routeSourceId = "00000000-0000-4000-8000-000000000143"
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const fixture = yield* seedSyncEngineRepositoryFixture({
          userId: routeUserId,
          principalId: routePrincipalId,
          sourceId: routeSourceId,
        })
        const [bitcoinAsset] = yield* db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.symbol, "BTC"))
          .limit(1)
        const [bitcoinRepresentation] = yield* db
          .select({ id: schema.assetRepresentations.id })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.blockchainId, fixture.bitcoinBlockchainId))
          .limit(1)

        if (bitcoinAsset === undefined || bitcoinRepresentation === undefined) {
          return yield* Effect.die("Missing Bitcoin approval fixture")
        }

        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "approval-route-test",
            providerAssetId: "btc-approval-route",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-15T10:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to seed approval provider asset")
        }

        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
          sourceNotes: "Exact Bitcoin representation observed.",
        })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: routeSourceId,
            externalId: "approval-route-transaction",
            timestamp: new Date("2026-08-15T10:01:00.000Z"),
            principalId: routePrincipalId,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) {
          return yield* Effect.die("Failed to seed approval route transaction")
        }

        yield* db.insert(schema.providerTransfers).values({
          sourceId: routeSourceId,
          transactionId: transaction.id,
          externalId: "approval-route-transfer",
          providerAssetId: providerAsset.id,
          timestamp: new Date("2026-08-15T10:01:00.000Z"),
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "approval-route-account",
          toAddress: "bc1qapprovalroute000000000000000000000000",
          amount: "0.1",
          observedBlockchainId: fixture.bitcoinBlockchainId,
          observedRepresentationType: "native",
          observedDecimals: 8,
          metadata: {},
        })

        return {
          providerAssetId: providerAsset.id,
          canonicalAssetId: bitcoinAsset.id,
          assetRepresentationId: bitcoinRepresentation.id,
        }
      }).pipe(Effect.provide(TestPgClientLive))
    )

    const review = await Effect.runPromise(
      getAdminJson({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}`,
        responseSchema: ProviderAssetReviewDetailResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const proposalSearch = await Effect.runPromise(
      getAdminJson({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/proposals`,
        responseSchema: ProviderAssetResolutionProposalListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const proposal = proposalSearch.body.proposals.find(
      ({ effect }) =>
        effect._tag === "UseExistingRepresentation" &&
        effect.canonicalAssetId === seeded.canonicalAssetId &&
        effect.assetRepresentationId === seeded.assetRepresentationId
    )
    if (proposal === undefined) {
      throw new Error("Expected an exact existing representation proposal.")
    }
    const decisionPayload = {
      reviewRevision: review.body.reviewRevision,
      decision: {
        _tag: "Resolve" as const,
        proposalId: proposal.id,
        effect: proposal.effect,
      },
      reviewerNotes: "Exact identity checked.",
    }
    const response = await Effect.runPromise(
      postAdminJson({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/decision`,
        payload: decisionPayload,
        responseSchema: ProviderAssetDecisionResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      review: {
        id: seeded.providerAssetId,
        mapping: {
          mappingStatus: "approved",
          canonicalAssetId: seeded.canonicalAssetId,
          assetRepresentationId: seeded.assetRepresentationId,
          reviewerNotes: "Exact identity checked.",
          reviewedBy: routeUserId,
        },
      },
    })

    const repeatedStatus = await Effect.runPromise(
      postAdminStatus({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/decision`,
        payload: { ...decisionPayload, reviewerNotes: "Exact identity checked again." },
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const conflictingStatus = await Effect.runPromise(
      postAdminStatus({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/decision`,
        payload: {
          ...decisionPayload,
          decision: {
            _tag: "Resolve",
            proposalId: "stale-conflicting-target",
            effect: {
              _tag: "UseExistingAsset",
              canonicalAssetId: "00000000-0000-4000-8000-000000000199",
            },
          },
          reviewerNotes: "Conflicting target.",
        },
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const durableState = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({
            canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
          })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, seeded.providerAssetId))
        const jobs = yield* db
          .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, routeSourceId))
        return { jobs, mapping }
      }).pipe(Effect.provide(TestPgClientLive))
    )

    expect(repeatedStatus).toBe(409)
    expect(conflictingStatus).toBe(409)
    expect(durableState.mapping).toEqual({
      canonicalAssetId: seeded.canonicalAssetId,
      assetRepresentationId: seeded.assetRepresentationId,
    })
    expect(durableState.jobs).toEqual([{ mode: "replay", status: "pending" }])
  })

  it.each(["/v1/assets/provider-assets", "/v1/assets/transfer-reconciliations/unresolved"])(
    "keeps the admin review endpoint protected: %s",
    async (path) => {
      const status = await Effect.runPromise(
        getStatus(path).pipe(Effect.provide(HttpLive), Effect.scoped)
      )

      expect(status).toBe(401)
    }
  )

  it("keeps provider asset decisions protected", async () => {
    const status = await Effect.runPromise(
      HttpClientRequest.post(
        "/v1/assets/provider-assets/00000000-0000-4000-8000-000000000199/decision"
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          reviewRevision: "2026-08-17T08:00:00.000Z",
          decision: { _tag: "Reject" },
          reviewerNotes: "Unsupported.",
        }),
        HttpClient.execute,
        Effect.map((response) => response.status),
        Effect.provide(HttpLive),
        Effect.scoped
      )
    )

    expect(status).toBe(401)
  })
})
