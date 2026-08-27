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
  AssetExceptionDetailResponse,
  AssetExceptionListResponse,
  AssetExceptionPreviewResponse,
  PendingAssetListResponse,
  ProviderAssetReviewRow,
  ProviderAssetReviewListResponse,
  UnresolvedTransferReconciliationListResponse,
} from "../src/definitions/AssetsApi.ts"
import {
  AssetOverrideConflictError,
  AssetOverrideHistoryResponse,
  AssetOverrideNotFoundError,
  AssetOverrideProjectionResponse,
  AssetOverrideValidationResponse,
} from "../src/definitions/AssetOverridesApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { eq, sql } from "../../persistence/src/query/index.ts"
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
const USER_BEARER_TOKEN = "user_00000000-0000-4000-8000-000000000098_user"

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

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

const getUserStatus = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(
      HttpClientRequest.bearerToken(USER_BEARER_TOKEN),
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
      version: Schema.Literal(2),
      providerAssetRowId: Schema.String.check(Schema.isUUID()),
    })
  )
)

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetsApiLive", () => {
  it("runs the authenticated asset override flow through validation, CAS, history, replacement, and withdrawal", async () => {
    const userId = crypto.randomUUID()
    const unownedUserId = crypto.randomUUID()
    const principalId = crypto.randomUUID()
    const sourceId = crypto.randomUUID()
    const fixture = await Effect.runPromise(
      Effect.gen(function* () {
        const syncFixture = yield* seedSyncEngineRepositoryFixture({
          userId,
          principalId,
          sourceId,
        })
        const db = yield* drizzle
        yield* db.insert(schema.users).values({
          id: unownedUserId,
          email: `asset-override-unowned-${unownedUserId}@taxmaxi.test`,
          name: "Unowned asset override user",
        })
        yield* db.insert(schema.principals).values({
          kind: "user",
          userId: unownedUserId,
        })
        const [firstAsset, secondAsset] = yield* db
          .insert(schema.assets)
          .values([
            { name: "Override API Asset One", symbol: "OA1", type: "fungible" },
            { name: "Override API Asset Two", symbol: "OA2", type: "fungible" },
          ])
          .returning({ id: schema.assets.id })
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: `override-api-${crypto.randomUUID()}`,
            currencyCode: "OAPI",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-26T12:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (firstAsset === undefined || secondAsset === undefined || providerAsset === undefined) {
          return yield* Effect.die("Failed to seed asset override API fixture")
        }
        const [resolvedProviderAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: `override-api-resolved-${crypto.randomUUID()}`,
            currencyCode: "OAR",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-26T12:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (resolvedProviderAsset === undefined) {
          return yield* Effect.die("Failed to seed resolved asset override API fixture")
        }
        const representationContract = "0x0000000000000000000000000000000000000172"
        yield* db.insert(schema.assetRepresentations).values({
          assetId: firstAsset.id,
          blockchainId: syncFixture.baseBlockchainId,
          type: "token",
          contractAddress: representationContract,
          decimals: 8,
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId,
          blockchainId: syncFixture.baseBlockchainId,
          representationType: "token",
          contractAddress: representationContract,
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: providerAsset.id,
          sourceId,
          hasChainlessObservation: true,
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: resolvedProviderAsset.id,
          mappingKind: "asset",
          mappingStatus: "approved",
          canonicalAssetId: firstAsset.id,
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: resolvedProviderAsset.id,
          sourceId,
          hasChainlessObservation: true,
        })
        return {
          firstAssetId: firstAsset.id,
          secondAssetId: secondAsset.id,
          providerAssetRowId: providerAsset.id,
          resolvedProviderAssetRowId: resolvedProviderAsset.id,
          representationTarget: {
            _tag: "representation" as const,
            blockchainId: syncFixture.baseBlockchainId,
            representationType: "token" as const,
            contractAddress: representationContract,
            mintAddress: null,
          },
        }
      }).pipe(Effect.provide(TestPgClientLive))
    )
    const token = `user_${userId}_user`
    const target = {
      _tag: "provider_asset" as const,
      providerAssetRowId: fixture.providerAssetRowId,
    }
    const query = `kind=identity&targetKind=provider_asset&providerAssetRowId=${fixture.providerAssetRowId}`
    const runRequest = <Response, Requirements>({
      bearerToken = token,
      request,
      responseSchema,
    }: {
      readonly bearerToken?: string
      readonly request: HttpClientRequest.HttpClientRequest
      readonly responseSchema: Schema.ConstraintDecoder<Response, Requirements>
    }) =>
      Effect.gen(function* () {
        const response = yield* request.pipe(
          HttpClientRequest.bearerToken(bearerToken),
          HttpClient.execute
        )
        const body = yield* response.json
        return {
          status: response.status,
          body: yield* Schema.decodeUnknownEffect(responseSchema)(body),
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

    const initial = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.get(`/v1/asset-overrides/current?${query}`),
        responseSchema: AssetOverrideProjectionResponse,
      })
    )
    expect(initial.status).toBe(200)
    expect(initial.body.systemConclusion).toMatchObject({ state: "unresolved" })

    const representationQuery = new URLSearchParams({
      kind: "identity",
      targetKind: "representation",
      blockchainId: fixture.representationTarget.blockchainId,
      representationType: fixture.representationTarget.representationType,
      contractAddress: fixture.representationTarget.contractAddress,
    }).toString()
    const representationCurrent = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.get(`/v1/asset-overrides/current?${representationQuery}`),
        responseSchema: AssetOverrideProjectionResponse,
      })
    )
    const representationHistory = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.get(`/v1/asset-overrides/history?${representationQuery}`),
        responseSchema: Schema.Array(AssetOverrideHistoryResponse),
      })
    )
    expect(representationCurrent).toMatchObject({
      status: 200,
      body: { target: fixture.representationTarget },
    })
    expect(representationHistory).toEqual({ status: 200, body: [] })

    const resolvedTarget = {
      _tag: "provider_asset" as const,
      providerAssetRowId: fixture.resolvedProviderAssetRowId,
    }
    const identityDifference = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post("/v1/asset-overrides/validate").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            kind: "identity",
            target: resolvedTarget,
            replacement: { _tag: "identity", assetId: fixture.secondAssetId },
          })
        ),
        responseSchema: AssetOverrideValidationResponse,
      })
    )
    const inclusionDifference = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post("/v1/asset-overrides/validate").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            kind: "inclusion",
            target: resolvedTarget,
            replacement: { _tag: "inclusion", state: "excluded" },
          })
        ),
        responseSchema: AssetOverrideValidationResponse,
      })
    )
    expect(identityDifference.body.warnings).toEqual(["identity_differs_from_system"])
    expect(inclusionDifference.body.warnings).toEqual(["inclusion_differs_from_system"])

    const absentProviderAssetId = crypto.randomUUID()
    const absent = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.get(
          `/v1/asset-overrides/current?kind=identity&targetKind=provider_asset&providerAssetRowId=${absentProviderAssetId}`
        ),
        responseSchema: AssetOverrideNotFoundError,
      })
    )
    const unowned = await Effect.runPromise(
      runRequest({
        bearerToken: `user_${unownedUserId}_user`,
        request: HttpClientRequest.get(`/v1/asset-overrides/current?${query}`),
        responseSchema: AssetOverrideNotFoundError,
      })
    )
    expect(absent).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "asset_override_target_not_found" }),
    })
    expect(unowned).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "asset_override_target_not_found" }),
    })

    const validation = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post("/v1/asset-overrides/validate").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            kind: "identity",
            target,
            replacement: { _tag: "identity", assetId: fixture.firstAssetId },
          })
        ),
        responseSchema: AssetOverrideValidationResponse,
      })
    )
    expect(validation.body.warnings).toEqual(["identity_not_system_verified"])

    const createPayload = {
      kind: "identity",
      target,
      expectedSystemRevision: initial.body.systemRevision,
      replacement: { _tag: "identity", assetId: fixture.firstAssetId },
      reason: "The account statement confirms the first asset.",
    }
    const created = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post("/v1/asset-overrides").pipe(
          HttpClientRequest.bodyJsonUnsafe(createPayload)
        ),
        responseSchema: AssetOverrideProjectionResponse,
      })
    )
    expect(created.status).toBe(200)
    expect(created.body.activeOverride?.actorId).toBe(userId)
    expect(created.body.effectiveConclusion).toMatchObject({ assetId: fixture.firstAssetId })

    const conflict = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post("/v1/asset-overrides").pipe(
          HttpClientRequest.bodyJsonUnsafe(createPayload)
        ),
        responseSchema: AssetOverrideConflictError,
      })
    )
    expect(conflict.status).toBe(409)
    expect(conflict.body.current.activeOverride?.id).toBe(created.body.activeOverride?.id)
    expect(conflict.body.current.systemRevision).toBe(created.body.systemRevision)

    const activeOverrideId = created.body.activeOverride?.id
    if (activeOverrideId === undefined) expect.unreachable("Expected an active override")
    const replaced = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post(
          `/v1/asset-overrides/${activeOverrideId}/replacements`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            ...createPayload,
            expectedSystemRevision: created.body.systemRevision,
            replacement: { _tag: "identity", assetId: fixture.secondAssetId },
            reason: "The audited statement confirms the second asset.",
          })
        ),
        responseSchema: AssetOverrideProjectionResponse,
      })
    )
    expect(replaced.body.history).toHaveLength(2)
    expect(replaced.body.effectiveConclusion).toMatchObject({ assetId: fixture.secondAssetId })

    const history = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.get(`/v1/asset-overrides/history?${query}`),
        responseSchema: Schema.Array(AssetOverrideHistoryResponse),
      })
    )
    expect(history.body).toHaveLength(2)

    const replacementOverrideId = replaced.body.activeOverride?.id
    if (replacementOverrideId === undefined) expect.unreachable("Expected replacement override")
    const withdrawn = await Effect.runPromise(
      runRequest({
        request: HttpClientRequest.post(
          `/v1/asset-overrides/${replacementOverrideId}/withdrawals`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            kind: "identity",
            target,
            expectedSystemRevision: replaced.body.systemRevision,
            reason: "Return to the current TaxMaxi conclusion.",
          })
        ),
        responseSchema: AssetOverrideProjectionResponse,
      })
    )
    expect(withdrawn.body.activeOverride).toBeNull()
    expect(withdrawn.body.history).toHaveLength(3)
  }, 10_000)

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
    {
      endpoint: "admin asset exceptions with a non-numeric transaction value",
      path: `/v1/assets/exceptions?cursor=${encodeTestCursor({
        version: 1,
        blockedReports: 1,
        affectedPrincipals: 1,
        affectedTransactions: 1,
        affectedSources: 1,
        affectedTransactionValueEur: "not-a-number",
        severity: "high",
        oldestAt: "2026-08-21T12:00:00.000Z",
        providerAssetRowId: crypto.randomUUID(),
      })}`,
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
    ).toEqual({
      version: 2,
      providerAssetRowId: firstProviderAsset.id,
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

  it("approves an exact provider asset target through the admin route", async () => {
    const routeUserId = "00000000-0000-4000-8000-000000000141"
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

    const response = await Effect.runPromise(
      postAdminJson({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/approve`,
        payload: {
          canonicalAssetId: seeded.canonicalAssetId,
          assetRepresentationId: seeded.assetRepresentationId,
          reviewerNotes: "Exact identity checked.",
        },
        responseSchema: ProviderAssetReviewRow,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: seeded.providerAssetId,
      mappingStatus: "approved",
      canonicalAssetId: seeded.canonicalAssetId,
      assetRepresentationId: seeded.assetRepresentationId,
      reviewerNotes: "Exact identity checked.",
    })

    const repeated = await Effect.runPromise(
      postAdminJson({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/approve`,
        payload: {
          canonicalAssetId: seeded.canonicalAssetId,
          assetRepresentationId: seeded.assetRepresentationId,
          reviewerNotes: "Exact identity checked again.",
        },
        responseSchema: ProviderAssetReviewRow,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const conflictingStatus = await Effect.runPromise(
      postAdminStatus({
        path: `/v1/assets/provider-assets/${seeded.providerAssetId}/approve`,
        payload: {
          canonicalAssetId: "00000000-0000-4000-8000-000000000199",
          assetRepresentationId: null,
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

    expect(repeated.status).toBe(200)
    expect(conflictingStatus).toBe(400)
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

  it("keeps provider asset approval protected", async () => {
    const status = await Effect.runPromise(
      HttpClientRequest.post(
        "/v1/assets/provider-assets/00000000-0000-4000-8000-000000000199/approve"
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          canonicalAssetId: "00000000-0000-4000-8000-000000000198",
          assetRepresentationId: null,
        }),
        HttpClient.execute,
        Effect.map((response) => response.status),
        Effect.provide(HttpLive),
        Effect.scoped
      )
    )

    expect(status).toBe(401)
  })

  it("paginates exception rows without duplicating sub-millisecond timestamps", async () => {
    const firstId = "00000000-0000-4000-8000-000000000711"
    const secondId = "00000000-0000-4000-8000-000000000712"

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.providerAssets).values([
          {
            id: firstId,
            provider: "cursor-precision-provider",
            providerAssetId: "cursor-precision-first",
            currencyCode: "CURSOR1",
            evidenceRevision: 1,
            retrievedAt: new Date("2026-08-21T12:00:00.000Z"),
          },
          {
            id: secondId,
            provider: "cursor-precision-provider",
            providerAssetId: "cursor-precision-second",
            currencyCode: "CURSOR2",
            evidenceRevision: 1,
            retrievedAt: new Date("2026-08-21T12:00:00.000Z"),
          },
        ])
        yield* db.insert(schema.assetResolutionJobs).values([
          { providerAssetRowId: firstId, evidenceRevision: 1, status: "completed" },
          { providerAssetRowId: secondId, evidenceRevision: 1, status: "completed" },
        ])
        yield* db.insert(schema.assetResolutionDecisions).values([
          {
            providerAssetRowId: firstId,
            evidenceRevision: 1,
            policyRevision: "cursor-precision.1",
            outcome: "fail_closed",
            reason: "ownership_conflict",
            actor: "policy:cursor-precision.1",
          },
          {
            providerAssetRowId: secondId,
            evidenceRevision: 1,
            policyRevision: "cursor-precision.1",
            outcome: "fail_closed",
            reason: "ownership_conflict",
            actor: "policy:cursor-precision.1",
          },
        ])
        yield* db.execute(sql`
          update ${schema.assetResolutionDecisions}
          set created_at = case
            when provider_asset_row_id = ${firstId}::uuid then ${"2026-08-21T12:00:00.000900Z"}::timestamptz
            else ${"2026-08-21T12:00:00.000100Z"}::timestamptz
          end
          where provider_asset_row_id in (${firstId}::uuid, ${secondId}::uuid)
        `)
      }).pipe(Effect.provide(TestPgClientLive))
    )

    const firstPage = await Effect.runPromise(
      getAdminJson({
        path: "/v1/assets/exceptions?limit=1",
        responseSchema: AssetExceptionListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const cursor = firstPage.body.page.nextCursor
    if (cursor === null) {
      expect.unreachable("Expected a cursor for the second exception")
    }
    const secondPage = await Effect.runPromise(
      getAdminJson({
        path: `/v1/assets/exceptions?limit=1&cursor=${cursor}`,
        responseSchema: AssetExceptionListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(firstPage.body.exceptions.map(({ providerAssetRowId }) => providerAssetRowId)).toEqual([
      firstId,
    ])
    expect(secondPage.body.exceptions.map(({ providerAssetRowId }) => providerAssetRowId)).toEqual([
      secondId,
    ])
    expect(secondPage.body.page).toEqual({ hasMore: false, nextCursor: null })
  })

  it("supports the complete admin asset-exception review flow without exposing it publicly", async () => {
    const suffix = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const principalId = crypto.randomUUID()
    const sourceId = crypto.randomUUID()
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSyncEngineRepositoryFixture({ userId, principalId, sourceId })
        const db = yield* drizzle
        const observedAt = new Date("2026-08-21T12:00:00.000Z")
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: `exception-api-${suffix}`,
            providerAssetId: `provider-observation-${suffix}`,
            naturalKey: `currency_code:EXC-${suffix}`,
            currencyCode: "EXC",
            name: "Exception API Asset",
            exponent: 6,
            providerType: "crypto",
            rawProviderPayload: { id: `provider-observation-${suffix}` },
            evidenceRevision: 3,
            discoveredAt: observedAt,
            retrievedAt: observedAt,
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to seed API exception")
        }
        yield* db.insert(schema.assetResolutionJobs).values({
          providerAssetRowId: providerAsset.id,
          evidenceRevision: 3,
          status: "completed",
        })
        const [decision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 3,
            policyRevision: "api-test-policy.1",
            outcome: "fail_closed",
            reason: "ownership_conflict",
            actor: "policy:api-test-policy.1",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (decision === undefined) {
          return yield* Effect.die("Failed to seed API decision")
        }
        const [evidence] = yield* db
          .insert(schema.assetResolutionEvidence)
          .values({
            decisionId: decision.id,
            authority: "coingecko",
            claimKind: "representation_owner",
            sourceLocator: `coingecko:${suffix}`,
            retrievedAt: observedAt,
            evidenceRevision: 3,
            decodedClaim: { coinId: `exception-${suffix}` },
            rawPayload: { id: `exception-${suffix}` },
          })
          .returning({ id: schema.assetResolutionEvidence.id })
        if (evidence === undefined) {
          return yield* Effect.die("Failed to seed API evidence")
        }
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: providerAsset.id,
          sourceId,
        })
        return {
          provider: `exception-api-${suffix}`,
          providerAssetId: `provider-observation-${suffix}`,
          rowId: providerAsset.id,
          decisionId: decision.id,
          evidenceId: evidence.id,
        }
      }).pipe(Effect.provide(TestPgClientLive))
    )

    const publicStatus = await Effect.runPromise(
      getStatus("/v1/assets/exceptions").pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const userStatus = await Effect.runPromise(
      getUserStatus("/v1/assets/exceptions").pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const list = await Effect.runPromise(
      getAdminJson({
        path: "/v1/assets/exceptions?limit=10",
        responseSchema: AssetExceptionListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const lookup = await Effect.runPromise(
      getAdminJson({
        path: `/v1/assets/exceptions/lookup?provider=${encodeURIComponent(seeded.provider)}&providerAssetId=${encodeURIComponent(seeded.providerAssetId)}`,
        responseSchema: AssetExceptionDetailResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const payload = {
      claim: { _tag: "exclusion", reason: "provider_artifact" },
      evidenceRevision: 3,
      activeDecisionRevision: seeded.decisionId,
      evidenceSnapshotIds: [seeded.evidenceId],
      rationale: "The immutable provider evidence shows an internal provider artifact.",
    }
    const preview = await Effect.runPromise(
      postAdminJson({
        path: `/v1/assets/exceptions/${seeded.rowId}/preview`,
        payload,
        responseSchema: AssetExceptionPreviewResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const confirmationPayload = {
      ...payload,
      expectedResultingAssetId: preview.body.resultingAssetId,
      expectedAssetOutcome: preview.body.assetOutcome,
      expectedRepresentationOutcome: preview.body.representationOutcome,
    }
    const accepted = await Effect.runPromise(
      postAdminJson({
        path: `/v1/assets/exceptions/${seeded.rowId}/decisions`,
        payload: confirmationPayload,
        responseSchema: AssetExceptionDetailResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
    const staleStatus = await Effect.runPromise(
      postAdminStatus({
        path: `/v1/assets/exceptions/${seeded.rowId}/decisions`,
        payload: confirmationPayload,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(publicStatus).toBe(401)
    expect(userStatus).toBe(403)
    expect(list.body.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerAssetRowId: seeded.rowId,
          reason: "ownership_conflict",
          severity: "critical",
        }),
      ])
    )
    expect(lookup.body).toMatchObject({
      providerAssetRowId: seeded.rowId,
      policyOutput: { outcome: "fail_closed", reason: "ownership_conflict" },
    })
    expect(preview.body).toMatchObject({
      assetOutcome: "none",
      representationOutcome: "none",
      evidenceRevision: 3,
    })
    expect(accepted.body).toMatchObject({
      reviewStatus: "excluded",
      rematerialization: { status: "pending", affectedSourceCount: 1 },
    })
    expect(staleStatus).toBe(409)
  })
})
