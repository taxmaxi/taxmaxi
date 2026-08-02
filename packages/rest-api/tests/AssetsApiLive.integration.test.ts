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
} from "../src/definitions/AssetsApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
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

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: getSourceSyncJob not implemented"),
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
  Layer.provide(Layer.setConfigProvider(TestConfigProvider))
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
  })

const getStatus = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    return response.status
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetsApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  it("lists canonical assets from the asset table without authentication", async () => {
    const response = await Effect.runPromise(
      getJson({
        path: "/v1/assets",
        responseSchema: AssetCatalogListResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    const symbols = response.body.assets.map((asset) => asset.symbol)
    const usdc = response.body.assets.find((asset) => asset.symbol === "USDC")

    expect(response.status).toBe(200)
    expect(symbols).toEqual(expect.arrayContaining(["SOL", "USDC", "USDT"]))
    expect(usdc).toMatchObject({
      name: "USD Coin",
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

  it("keeps provider asset review endpoints admin protected", async () => {
    const status = await Effect.runPromise(
      getStatus("/v1/assets/provider-assets").pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(status).toBe(401)
  })
})
