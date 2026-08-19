import { HttpApiClient } from "effect/unstable/httpapi"
import { Cookies, Headers, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import { and, eq } from "@my/persistence/query"
import * as ConfigProvider from "effect/ConfigProvider"
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
import * as Option from "effect/Option"
import * as EffectSchema from "effect/Schema"
import { SourceSyncServiceLive } from "@my/sync-engine/layers"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { TaxCalculationServiceLive } from "../../persistence/src/layers/TaxCalculationServiceLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { TaxCalculationService } from "../../persistence/src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import {
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { ANON_CHALLENGE_COOKIE_NAME, ANON_SESSION_COOKIE_NAME } from "../src/layers/AnonApiLive.ts"
import { SourceCreateResponse, SourcePaymentRequiredError } from "../src/definitions/SourcesApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { X402PaymentValidator } from "../src/services/X402PaymentValidator.ts"
import {
  makeX402PaymentValidatorTestLive,
  TEST_PAYER_WALLET,
} from "./support/X402PaymentValidatorTestLive.ts"
import {
  makeTestSiwxProof,
  SIWXProofVerifierTestLive,
} from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sources",
})
const TestPgClientLive = context.TestPgClientLive

const queuedAt = new Date("2026-01-01T00:00:00.000Z")
const queueEvents: Array<SourceSyncQueuePayload> = []
const settlementEvents: Array<string> = []
const validX402PaymentHeader = "valid-test-x402-payment"
const REPORT_TEST_USER_ID = "00000000-0000-4000-8000-000000000181"
const REPORT_TEST_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000183"
const REPORT_TEST_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const REPORT_TEST_FIXTURE = {
  userId: REPORT_TEST_USER_ID,
  principalId: REPORT_TEST_PRINCIPAL_ID,
  sourceId: REPORT_TEST_SOURCE_ID,
}
const ClaimTokenConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
  CLAIM_TOKEN_PEPPER: "test-claim-token-pepper",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(ClaimTokenConfigProvider))
)
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorSettlementFailureTestLive = makeX402PaymentValidatorTestLive({
  failSettlement: true,
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorTrackingTestLive = makeX402PaymentValidatorTestLive({
  onSettle: (paymentHeader) => settlementEvents.push(paymentHeader),
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorWithoutPayerIdentityTestLive = makeX402PaymentValidatorTestLive({
  includePayerIdentity: false,
  validPaymentHeader: validX402PaymentHeader,
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
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

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

const TaxCalculationServiceTestLive = Layer.succeed(TaxCalculationService, {
  calculateTax: () => Effect.die("TaxCalculationService test stub: calculateTax"),
})

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

const makeSourceSyncServiceWithDepsTestLive = (
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>
) =>
  SourceSyncServiceLive.pipe(Layer.provide(sourceSyncQueueLayer), Layer.provide(RepositoriesLive))

const makePersistenceLayer = <R = never>(
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>,
  taxCalculationServiceLayer: Layer.Layer<
    TaxCalculationService,
    never,
    R
  > = TaxCalculationServiceTestLive
) =>
  Layer.mergeAll(
    RepositoriesLive,
    makeSourceSyncServiceWithDepsTestLive(sourceSyncQueueLayer),
    SourceSyncRunServiceTestLive,
    taxCalculationServiceLayer,
    TransferReconciliationServiceTestLive,
    AuthServiceTestLive,
    PasswordHasherTestLive
  ).pipe(Layer.provideMerge(TestPgClientLive))

const makeHttpLive = <R = never>(
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>,
  x402PaymentValidatorLayer: Layer.Layer<X402PaymentValidator> = X402PaymentValidatorTestLive,
  taxCalculationServiceLayer: Layer.Layer<
    TaxCalculationService,
    never,
    R
  > = TaxCalculationServiceTestLive
) =>
  HttpRouter.serve(
    TaxMaxiApiLive.pipe(
      Layer.provide(AnonSessionServiceTestLive),
      Layer.provide(SIWXProofVerifierTestLive),
      Layer.provide(x402PaymentValidatorLayer),
      Layer.provide(SimpleTokenValidatorLive)
    )
  ).pipe(
    Layer.provideMerge(makePersistenceLayer(sourceSyncQueueLayer, taxCalculationServiceLayer)),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(ConfigProvider.layer(ClaimTokenConfigProvider))
  )

const HttpLive = makeHttpLive(SourceSyncQueueTestLive)
const QueueFailureHttpLive = makeHttpLive(SourceSyncQueueFailureTestLive)
const SettlementFailureHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorSettlementFailureTestLive
)
const NoPayerIdentityHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorWithoutPayerIdentityTestLive
)
const PaidQueueFailureHttpLive = makeHttpLive(
  SourceSyncQueueFailureTestLive,
  X402PaymentValidatorTrackingTestLive
)
const TaxCalculationHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorTestLive,
  TaxCalculationServiceLive
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

const makeUnauthenticatedClientWithPayment = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("x-payment", validX402PaymentHeader))
      ),
    })
  })

const makeUnauthenticatedClient = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient,
    })
  })

const makeUnauthenticatedClientWithInvalidPayment = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("x-payment", "invalid-test-x402-payment"))
      ),
    })
  })

const makeClientWithBearerToken = (token: string) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))),
    })
  })

const makeClientWithCookie = (cookieHeader: string) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("cookie", cookieHeader))
      ),
    })
  })

const makeClientWithBearerTokenAndCookie = ({
  cookieHeader,
  token,
}: {
  readonly cookieHeader: string
  readonly token: string
}) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.bearerToken(token)(
            HttpClientRequest.setHeader("cookie", cookieHeader)(request)
          )
        )
      ),
    })
  })

const extractCookieValue = (headers: Headers.Headers, name: string): string => {
  const setCookie = Headers.get(headers, "set-cookie")
  if (Option.isNone(setCookie)) {
    throw new Error(`Missing ${name} cookie`)
  }

  const cookie = setCookie.value
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))

  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`)
  }

  return cookie.slice(name.length + 1).split(";", 1)[0] ?? ""
}

const AnonSessionChallengeBody = EffectSchema.Struct({
  nonce: EffectSchema.String,
  expiresAt: EffectSchema.String,
})

const createAnonSessionCookie = ({
  walletAddress = TEST_PAYER_WALLET,
}: {
  readonly walletAddress?: string
} = {}) =>
  Effect.gen(function* () {
    const challengeResponse = yield* HttpClient.execute(
      HttpClientRequest.post("/v1/anon/session/challenge")
    )
    const challengeCookie = extractCookieValue(
      challengeResponse.headers,
      ANON_CHALLENGE_COOKIE_NAME
    )
    const challengeJson = yield* challengeResponse.json
    const challenge =
      yield* EffectSchema.decodeUnknownEffect(AnonSessionChallengeBody)(challengeJson)
    const siwxProof = makeTestSiwxProof({
      chainType: "solana",
      walletAddress,
      nonce: challenge.nonce,
    })

    const sessionResponse = yield* HttpClient.execute(
      HttpClientRequest.post("/v1/anon/session").pipe(
        HttpClientRequest.setHeader("cookie", `${ANON_CHALLENGE_COOKIE_NAME}=${challengeCookie}`),
        HttpClientRequest.bodyJsonUnsafe({ siwxProof })
      )
    )
    const sessionCookie = Cookies.getValue(sessionResponse.cookies, ANON_SESSION_COOKIE_NAME)
    if (Option.isNone(sessionCookie)) {
      const body = yield* sessionResponse.text
      return yield* Effect.die(
        `Missing anon session cookie from status ${sessionResponse.status}: ${body}`
      )
    }
    return sessionCookie.value
  })

const postRawSourceCreate = ({
  payload,
  paymentHeader,
  paymentSignatureHeader,
}: {
  readonly payload: unknown
  readonly paymentHeader?: string | undefined
  readonly paymentSignatureHeader?: string | undefined
}) =>
  Effect.gen(function* () {
    const baseRequest = HttpClientRequest.post("/v1/sources").pipe(
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const xPaymentRequest =
      paymentHeader === undefined
        ? baseRequest
        : baseRequest.pipe(HttpClientRequest.setHeader("x-payment", paymentHeader))
    const request =
      paymentSignatureHeader === undefined
        ? xPaymentRequest
        : xPaymentRequest.pipe(
            HttpClientRequest.setHeader("payment-signature", paymentSignatureHeader)
          )

    return yield* HttpClient.execute(request)
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
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
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
      return yield* Effect.die("Failed to create cex account fixture")
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

const reportFixtureIds = {
  buyTransactionId: "00000000-0000-4000-8000-000000046101",
  sellTransactionId: "00000000-0000-4000-8000-000000046102",
  acquisitionLegId: "00000000-0000-4000-8000-000000046201",
  disposalLegId: "00000000-0000-4000-8000-000000046202",
  feeTransactionId: "00000000-0000-4000-8000-000000046203",
  feeLegId: "00000000-0000-4000-8000-000000046204",
  internalTransferTransactionId: "00000000-0000-4000-8000-000000046205",
  internalTransferLegId: "00000000-0000-4000-8000-000000046206",
  internalTransferInTransactionId: "00000000-0000-4000-8000-000000046207",
  internalTransferInLegId: "00000000-0000-4000-8000-000000046208",
  taxFreeFifoLotId: "00000000-0000-4000-8000-000000046301",
  taxableFifoLotId: "00000000-0000-4000-8000-000000046302",
  internalTransferFifoLotId: "00000000-0000-4000-8000-000000046303",
  custodyProviderTransferId: "00000000-0000-4000-8000-000000046401",
  custodyMovementId: "00000000-0000-4000-8000-000000046402",
} as const

const seedSourceReportRows = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.transactions).values([
      {
        id: reportFixtureIds.buyTransactionId,
        sourceId,
        principalId,
        externalId: "report-buy-1",
        timestamp: new Date("2025-01-10T12:00:00.000Z"),
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerDescription: "Buy BTC",
      },
      {
        id: reportFixtureIds.sellTransactionId,
        sourceId,
        principalId,
        externalId: "report-sell-1",
        timestamp: new Date("2025-03-10T12:00:00.000Z"),
        transactionType: "sell_fiat",
        providerTransactionType: "sell",
        providerStatus: "completed",
        providerDescription: "Sell BTC",
      },
    ])

    yield* db.insert(schema.transactionLegs).values([
      {
        id: reportFixtureIds.acquisitionLegId,
        sourceId,
        principalId,
        externalId: "report-buy-1:btc",
        timestamp: new Date("2025-01-10T12:00:00.000Z"),
        assetId: TEST_BTC_ASSET_ID,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        derivationRule: "test_fixture_buy",
        transactionId: reportFixtureIds.buyTransactionId,
        fiatAmount: "10000",
        fiatCurrency: "EUR",
      },
      {
        id: reportFixtureIds.disposalLegId,
        sourceId,
        principalId,
        externalId: "report-sell-1:btc",
        timestamp: new Date("2025-03-10T12:00:00.000Z"),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.4",
        kind: "disposal",
        provenance: "deterministic",
        derivationRule: "test_fixture_sell",
        transactionId: reportFixtureIds.sellTransactionId,
        fiatAmount: "6000",
        fiatCurrency: "EUR",
      },
    ])

    yield* db.insert(schema.fifoLots).values([
      {
        id: reportFixtureIds.taxFreeFifoLotId,
        sourceId,
        principalId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2023-01-10T12:00:00.000Z"),
        originalAmount: "0.2",
        remainingAmount: "0",
        costBasisPerToken: "5000",
        costBasisCurrency: "EUR",
        sourceLegId: reportFixtureIds.acquisitionLegId,
        sourceLegSequence: 0,
      },
      {
        id: reportFixtureIds.taxableFifoLotId,
        sourceId,
        principalId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-10T12:00:00.000Z"),
        originalAmount: "0.8",
        remainingAmount: "0.6",
        costBasisPerToken: "15000",
        costBasisCurrency: "EUR",
        sourceLegId: reportFixtureIds.acquisitionLegId,
        sourceLegSequence: 1,
      },
    ])

    yield* db.insert(schema.disposalMatches).values([
      {
        disposalLegId: reportFixtureIds.disposalLegId,
        fifoLotId: reportFixtureIds.taxFreeFifoLotId,
        matchedAmount: "0.2",
        costBasis: "1000",
        proceeds: "3000",
        gainLoss: "2000",
      },
      {
        disposalLegId: reportFixtureIds.disposalLegId,
        fifoLotId: reportFixtureIds.taxableFifoLotId,
        matchedAmount: "0.2",
        costBasis: "3000",
        proceeds: "3000",
        gainLoss: "0",
      },
    ])
  })

const seedSourceReportTaxTreatmentRows = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.transactions).values([
      {
        id: reportFixtureIds.feeTransactionId,
        sourceId,
        principalId,
        externalId: "report-fee-1",
        timestamp: new Date("2025-04-10T12:00:00.000Z"),
        transactionType: "gas_fee",
        providerTransactionType: "fee",
        providerStatus: "completed",
        providerDescription: "Network fee",
      },
      {
        id: reportFixtureIds.internalTransferTransactionId,
        sourceId,
        principalId,
        externalId: "report-transfer-1",
        timestamp: new Date("2025-04-11T12:00:00.000Z"),
        transactionType: "sell_fiat",
        providerTransactionType: "send",
        providerStatus: "completed",
        providerDescription: "Internal transfer out",
      },
      {
        id: reportFixtureIds.internalTransferInTransactionId,
        sourceId,
        principalId,
        externalId: "report-transfer-2",
        timestamp: new Date("2025-04-12T12:00:00.000Z"),
        transactionType: "buy_fiat",
        providerTransactionType: "receive",
        providerStatus: "completed",
        providerDescription: "Internal transfer in",
      },
    ])

    yield* db.insert(schema.transactionLegs).values([
      {
        id: reportFixtureIds.feeLegId,
        sourceId,
        principalId,
        externalId: "report-fee-1:fee",
        timestamp: new Date("2025-04-10T12:00:00.000Z"),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.01",
        kind: "fee",
        provenance: "deterministic",
        derivationRule: "gas_fee",
        transactionId: reportFixtureIds.feeTransactionId,
        fiatAmount: "2",
        fiatCurrency: "EUR",
      },
      {
        id: reportFixtureIds.internalTransferLegId,
        sourceId,
        principalId,
        externalId: "report-transfer-1:internal_transfer_out",
        timestamp: new Date("2025-04-11T12:00:00.000Z"),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.1",
        kind: "disposal",
        provenance: "deterministic",
        derivationRule: "internal_transfer_out",
        transactionId: reportFixtureIds.internalTransferTransactionId,
        fiatAmount: "500",
        fiatCurrency: "EUR",
      },
      {
        id: reportFixtureIds.internalTransferInLegId,
        sourceId,
        principalId,
        externalId: "report-transfer-2:internal_transfer_in",
        timestamp: new Date("2025-04-12T12:00:00.000Z"),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.1",
        kind: "acquisition",
        provenance: "deterministic",
        derivationRule: "internal_transfer_in",
        transactionId: reportFixtureIds.internalTransferInTransactionId,
        fiatAmount: "500",
        fiatCurrency: "EUR",
      },
    ])

    yield* db.insert(schema.fifoLots).values({
      id: reportFixtureIds.internalTransferFifoLotId,
      sourceId,
      principalId,
      assetId: TEST_BTC_ASSET_ID,
      acquiredAt: new Date("2025-04-01T12:00:00.000Z"),
      originalAmount: "0.1",
      remainingAmount: "0",
      costBasisPerToken: "5000",
      costBasisCurrency: "EUR",
      sourceLegId: reportFixtureIds.acquisitionLegId,
      sourceLegSequence: 2,
    })

    yield* db.insert(schema.disposalMatches).values({
      disposalLegId: reportFixtureIds.internalTransferLegId,
      fifoLotId: reportFixtureIds.internalTransferFifoLotId,
      matchedAmount: "0.1",
      costBasis: "500",
      proceeds: "500",
      gainLoss: "0",
    })
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("SourcesApiLive", () => {
  beforeEach(async () => {
    queueEvents.length = 0
    settlementEvents.length = 0
    await Effect.runPromise(context.recreateTestDatabase())
  })

  it.effect("returns source-generic report read projections for a populated source", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      const db = yield* drizzle
      yield* db.insert(schema.providerTransfers).values({
        id: reportFixtureIds.custodyProviderTransferId,
        sourceId: fixture.sourceId,
        transactionId: reportFixtureIds.sellTransactionId,
        externalId: "report-custody-outflow-1",
        timestamp: new Date("2025-03-10T12:00:00.000Z"),
        direction: "outbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAddress: "bc1qreportcustodydestination",
        amount: "0.1",
      })
      yield* db.insert(schema.inventoryMovements).values({
        id: reportFixtureIds.custodyMovementId,
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
        transactionId: reportFixtureIds.sellTransactionId,
        providerTransferId: reportFixtureIds.custodyProviderTransferId,
        assetId: TEST_BTC_ASSET_ID,
        timestamp: new Date("2025-03-10T12:00:00.000Z"),
        direction: "outbound",
        purpose: "fee",
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
        amount: "0.1",
      })
      yield* db.insert(schema.inventoryMovementAllocations).values({
        inventoryMovementId: reportFixtureIds.custodyMovementId,
        fifoLotId: reportFixtureIds.taxableFifoLotId,
        matchedAmount: "0.1",
      })
      yield* db
        .update(schema.fifoLots)
        .set({ remainingAmount: "0.5" })
        .where(eq(schema.fifoLots.id, reportFixtureIds.taxableFifoLotId))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      expect(overview.source.id).toBe(fixture.sourceId)
      expect(overview.source.providerKey).toBe("coinbase")
      expect(overview.totals.transactionCount).toBe(2)
      expect(overview.totals.disposalCount).toBe(1)
      expect(overview.totals.realizedGainLoss).toBe("2000")

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.assets).toHaveLength(1)
      expect(assetPnl.assets[0]).toMatchObject({
        acquiredAmount: "1",
        disposedAmount: "0.5",
        openAmount: "0.5",
        costBasis: "7500",
        proceeds: "6000",
        realizedGainLoss: "2000",
        currency: "EUR",
      })

      const transactions = yield* client.sources.listSourceTransactions({
        params: { sourceId: fixture.sourceId },
        query: { limit: 1 },
      })
      expect(transactions.transactions).toHaveLength(1)
      expect(transactions.transactions[0]?.transactionId).toBe(reportFixtureIds.sellTransactionId)
      expect(transactions.transactions[0]?.movements[0]?.kind).toBe("disposal")
      expect(transactions.page.hasMore).toBe(true)
      expect(transactions.page.nextCursor).not.toBeNull()

      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(taxEvents.taxEvents.map((event) => event.kind)).toEqual(["disposal", "acquisition"])
      expect(taxEvents.taxEvents[0]).toMatchObject({
        legId: reportFixtureIds.disposalLegId,
        costBasis: "4000",
        proceeds: "6000",
        gainLoss: "2000",
        taxableTreatment: "mixed",
      })

      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(fifoLots.fifoLots).toHaveLength(2)
      expect(fifoLots.fifoLots[0]).toMatchObject({
        lotId: reportFixtureIds.taxFreeFifoLotId,
        originalAmount: "0.2",
        remainingAmount: "0",
        costBasisStatus: "known",
      })
      expect(fifoLots.fifoLots[0]?.disposalMatches[0]).toMatchObject({
        disposalLegId: reportFixtureIds.disposalLegId,
        matchedAmount: "0.2",
      })

      const explanation = yield* client.sources.explainSourceDisposal({
        params: { sourceId: fixture.sourceId, legId: reportFixtureIds.disposalLegId },
      })
      expect(explanation).toMatchObject({
        disposalLegId: reportFixtureIds.disposalLegId,
        amount: "0.4",
        proceeds: "6000",
        costBasis: "4000",
        gainLoss: "2000",
        taxableTreatment: "mixed",
      })
      expect(explanation.matchedLots).toHaveLength(2)
      expect(explanation.matchedLots.map((lot) => lot.taxableTreatment)).toEqual([
        "tax_free",
        "taxable",
      ])
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("surfaces FIFO inventory review state for unmatched source disposals", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)

      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })

      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle

      yield* db
        .delete(schema.disposalMatches)
        .where(eq(schema.disposalMatches.disposalLegId, reportFixtureIds.disposalLegId))

      yield* db.insert(schema.transactionReviews).values({
        transactionId: reportFixtureIds.sellTransactionId,
        principalId: fixture.principalId,
        reviewStatus: "changed",
        originalTypeKey: "sell_fiat",
        currentTypeKey: "sell_fiat",
        categorizationReason:
          "provider_asset_mapping: Keep the approved provider mapping.\nfifo_inventory: Review required because source inventory is incomplete.",
        matchedLayer: "provider_asset_mapping,fifo_inventory",
        needsReview: true,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })

      expect(overview.totals.disposalCount).toBe(1)
      expect(overview.totals.realizedGainLoss).toBe("0")
      expect(overview.review).toMatchObject({
        status: "needs_review",
        needsReviewCount: 1,
        blockingIssueCount: 1,
        issues: [
          {
            code: "fifo_inventory_shortfall",
            count: 1,
            blocking: true,
            summary: "1 disposal cannot be matched to available FIFO inventory.",
          },
        ],
      })

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.assets[0]).toMatchObject({
        disposedAmount: "0.4",
        proceeds: "0",
        realizedGainLoss: "0",
        review: {
          status: "needs_review",
          needsReviewCount: 1,
          blockingIssueCount: 1,
          issues: [
            {
              code: "fifo_inventory_shortfall",
              count: 1,
              blocking: true,
            },
          ],
        },
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("returns empty source report lists for a source with no canonical rows", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      expect(overview.totals.transactionCount).toBe(0)
      expect(overview.totals.assetCount).toBe(0)

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.assets).toEqual([])

      const transactions = yield* client.sources.listSourceTransactions({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(transactions.transactions).toEqual([])
      expect(transactions.page).toMatchObject({ hasMore: false, nextCursor: null })

      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(taxEvents.taxEvents).toEqual([])

      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(fifoLots.fifoLots).toEqual([])
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("counts provider-origin FIFO lot assets in the source overview", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })

      const transactionId = "00000000-0000-4000-8000-000000046501"
      const providerTransferId = "00000000-0000-4000-8000-000000046502"
      const db = yield* drizzle

      yield* db.insert(schema.transactions).values({
        id: transactionId,
        sourceId: fixture.sourceId,
        externalId: "provider-only-receive",
        timestamp: new Date("2025-03-11T12:00:00.000Z"),
        principalId: fixture.principalId,
      })
      yield* db.insert(schema.providerTransfers).values({
        id: providerTransferId,
        sourceId: fixture.sourceId,
        transactionId,
        externalId: "provider-only-receive:principal",
        timestamp: new Date("2025-03-11T12:00:00.000Z"),
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAddress: "bc1qprovideronlysource",
        toAccountRef: "coinbase-account-1",
        amount: "0.25",
      })
      yield* db.insert(schema.fifoLots).values({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-03-11T12:00:00.000Z"),
        originalAmount: "0.25",
        remainingAmount: "0.25",
        costBasisPerToken: "0",
        costBasisCurrency: "EUR",
        costBasisStatus: "pending_review",
        sourceProviderTransferId: providerTransferId,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })

      expect(overview.totals).toMatchObject({
        transactionCount: 1,
        legCount: 0,
        assetCount: 1,
        fifoLotCount: 1,
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect(
    "labels deductible fees and internal transfer disposals without taxable treatment",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
        yield* seedSyncEngineAssets({
          baseBlockchainId: fixture.baseBlockchainId,
          bitcoinBlockchainId: fixture.bitcoinBlockchainId,
        })
        yield* seedSourceReportRows({
          principalId: fixture.principalId,
          sourceId: fixture.sourceId,
        })
        yield* seedSourceReportTaxTreatmentRows({
          principalId: fixture.principalId,
          sourceId: fixture.sourceId,
        })

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const overview = yield* client.sources.getSourceOverview({
          params: { sourceId: fixture.sourceId },
        })
        const taxEvents = yield* client.sources.listSourceTaxEvents({
          params: { sourceId: fixture.sourceId },
          query: { limit: 10 },
        })
        const feeEvent = taxEvents.taxEvents.find(
          (event) => event.legId === reportFixtureIds.feeLegId
        )
        const internalTransferEvent = taxEvents.taxEvents.find(
          (event) => event.legId === reportFixtureIds.internalTransferLegId
        )
        const internalTransferInEvent = taxEvents.taxEvents.find(
          (event) => event.legId === reportFixtureIds.internalTransferInLegId
        )

        expect(feeEvent).toMatchObject({
          kind: "fee",
          taxableTreatment: "deductible",
        })
        expect(internalTransferEvent).toMatchObject({
          kind: "disposal",
          derivationRule: "internal_transfer_out",
          taxableTreatment: "non_taxable",
        })
        expect(internalTransferInEvent).toMatchObject({
          kind: "acquisition",
          derivationRule: "internal_transfer_in",
          taxableTreatment: "non_taxable",
        })
        expect(overview.totals.disposalCount).toBe(1)
        const assetPnl = yield* client.sources.listSourceAssetPnl({
          params: { sourceId: fixture.sourceId },
        })
        expect(assetPnl.assets[0]).toMatchObject({
          acquiredAmount: "1",
          disposedAmount: "0.4",
          openAmount: "0.6",
          costBasis: "9000",
          proceeds: "6000",
          realizedGainLoss: "2000",
        })

        const explanation = yield* client.sources.explainSourceDisposal({
          params: {
            sourceId: fixture.sourceId,
            legId: reportFixtureIds.internalTransferLegId,
          },
        })
        expect(explanation).toMatchObject({
          disposalLegId: reportFixtureIds.internalTransferLegId,
          taxableTreatment: "non_taxable",
        })
        expect(explanation.matchedLots.map((lot) => lot.taxableTreatment)).toEqual(["non_taxable"])
      }).pipe(Effect.provide(HttpLive))
  )

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
      expect(response.claim).toBeNull()
      expect(response.source).toMatchObject({
        principalId,
        name: "Demo Solana wallet",
        providerKey: "helius-solana",
      })
      expect(response.source.sourceRef._tag).toBe("onchain")

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          providerKey: schema.sources.providerKey,
          providerMetadata: schema.sources.providerMetadata,
        })
        .from(schema.sources)

      expect(storedSource).toEqual({
        providerKey: "helius-solana",
        providerMetadata: { chainType: "solana", walletAddress },
      })

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
      const claims = yield* db
        .select({ claimType: schema.principalClaims.claimType })
        .from(schema.principalClaims)
      expect(claims).toEqual([])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("creates an anonymous Solana source and starts sync without auth", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"

      const client = yield* makeUnauthenticatedClientWithPayment()
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      expect(response.created).toBe(true)
      expect(response.syncJob).not.toBeNull()
      expect(response.claim).not.toBeNull()
      expect(response.source).toMatchObject({
        name: "Anonymous Solana wallet",
        providerKey: "helius-solana",
      })
      if (response.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }
      expect(response.claim.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      )
      expect(response.claim.claimToken.length).toBeGreaterThan(40)
      expect(new Date(response.claim.expiresAt).getTime()).toBeGreaterThan(Date.now())

      const db = yield* drizzle
      const [principal] = yield* db
        .select({
          id: schema.principals.id,
          kind: schema.principals.kind,
          userId: schema.principals.userId,
        })
        .from(schema.principals)

      expect(principal).toEqual({
        id: response.source.principalId,
        kind: "anonymous_wallet",
        userId: null,
      })
      const claims = yield* db
        .select({
          requestId: schema.principalClaims.requestId,
          principalId: schema.principalClaims.principalId,
          sourceId: schema.principalClaims.sourceId,
          claimType: schema.principalClaims.claimType,
          claimValueHash: schema.principalClaims.claimValueHash,
          chainType: schema.principalClaims.chainType,
          walletAddress: schema.principalClaims.walletAddress,
          payerChainType: schema.principalClaims.payerChainType,
          payerWalletAddress: schema.principalClaims.payerWalletAddress,
          year: schema.principalClaims.year,
          jurisdiction: schema.principalClaims.jurisdiction,
          expiresAt: schema.principalClaims.expiresAt,
          consumedAt: schema.principalClaims.consumedAt,
        })
        .from(schema.principalClaims)

      expect(claims).toHaveLength(2)
      const cliClaim = claims.find((claim) => claim.claimType === "cli_claim_token")
      const receiptClaim = claims.find((claim) => claim.claimType === "x402_receipt")

      expect(cliClaim).toMatchObject({
        requestId: response.claim.requestId,
        principalId: response.source.principalId,
        sourceId: response.source.id,
        claimType: "cli_claim_token",
        chainType: "solana",
        walletAddress,
        payerChainType: null,
        payerWalletAddress: null,
        year: 2025,
        jurisdiction: "germany",
        consumedAt: null,
      })
      expect(cliClaim?.claimValueHash).not.toBe(response.claim.claimToken)
      expect(cliClaim?.claimValueHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(cliClaim?.expiresAt?.toISOString()).toBe(response.claim.expiresAt)
      expect(receiptClaim).toMatchObject({
        requestId: response.claim.requestId,
        principalId: response.source.principalId,
        sourceId: response.source.id,
        claimType: "x402_receipt",
        chainType: "solana",
        walletAddress,
        payerChainType: "solana",
        payerWalletAddress: TEST_PAYER_WALLET,
        year: 2025,
        jurisdiction: "germany",
        expiresAt: null,
        consumedAt: null,
      })
      expect(receiptClaim?.claimValueHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(receiptClaim?.claimValueHash).not.toBe(validX402PaymentHeader)
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        sourceId: response.source.id,
        principalId: response.source.principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "creates an anonymous paid source without anon session when payer identity is unavailable",
    () =>
      Effect.gen(function* () {
        const walletAddress = "So11111111111111111111111111111111111111112"

        const response = yield* postRawSourceCreate({
          paymentHeader: validX402PaymentHeader,
          payload: {
            type: "onchain",
            walletAddress,
            name: "Anonymous source without payer identity",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        const body = yield* response.json
        const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourceCreateResponse)(body)

        expect(response.status).toBe(200)
        expect(Headers.get(response.headers, "payment-response")).toEqual(
          Option.some("encoded-test-payment-response")
        )
        expect(Headers.get(response.headers, "set-cookie")).toEqual(Option.none())
        expect(decodedBody.created).toBe(true)
        expect(decodedBody.syncJob).not.toBeNull()
        expect(decodedBody.claim).not.toBeNull()

        if (decodedBody.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const db = yield* drizzle
        const claims = yield* db
          .select({
            requestId: schema.principalClaims.requestId,
            claimType: schema.principalClaims.claimType,
            payerChainType: schema.principalClaims.payerChainType,
            payerWalletAddress: schema.principalClaims.payerWalletAddress,
          })
          .from(schema.principalClaims)
          .where(eq(schema.principalClaims.requestId, decodedBody.claim.requestId))

        expect(claims).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              claimType: "cli_claim_token",
              payerChainType: null,
              payerWalletAddress: null,
            }),
            expect.objectContaining({
              claimType: "x402_receipt",
              payerChainType: null,
              payerWalletAddress: null,
            }),
          ])
        )
        expect(queueEvents).toHaveLength(1)
      }).pipe(Effect.provide(NoPayerIdentityHttpLive), Effect.scoped)
  )

  it.effect("finds an anonymous source claim by authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Claimable anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })

      expect(claimResponse.sourceId).toBe(created.source.id)

      const sources = yield* authenticatedClient.sources.listSources()
      expect(sources.sources.map((source) => source.id)).toContain(created.source.id)

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })

      const jobs = yield* db
        .select({ principalId: schema.processingJobs.principalId })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, created.source.id))
      expect(jobs).toEqual([{ principalId }])

      const claims = yield* db
        .select({
          claimType: schema.principalClaims.claimType,
          consumedAt: schema.principalClaims.consumedAt,
        })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt instanceof Date)).toBe(true)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("lists anonymous paid source handles by payer-wallet SIWX", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const first = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "First payer entitlement",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const second = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
          name: "Second payer entitlement",
          year: 2024,
          jurisdiction: "germany",
        },
      })

      if (first.claim === null || second.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const response = yield* anonSessionClient.anon.listAnonSources()

      expect(response.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: first.source.id,
            requestId: first.claim.requestId,
            chainType: "solana",
            walletAddress: "So11111111111111111111111111111111111111112",
            year: 2025,
            jurisdiction: "germany",
          }),
          expect.objectContaining({
            sourceId: second.source.id,
            requestId: second.claim.requestId,
            chainType: "solana",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            year: 2024,
            jurisdiction: "germany",
          }),
        ])
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("lists and reads anonymous paid source sync jobs by payer-wallet SIWX", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Anon sync status wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null || created.syncJob === null) {
        return yield* Effect.die(
          "Anonymous source creation did not return claim metadata and sync job"
        )
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )

      const listed = yield* anonSessionClient.anon.listAnonSourceJobs({
        params: { sourceId: created.source.id },
      })
      expect(listed.jobs).toEqual([
        expect.objectContaining({
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
          status: "queued",
          importedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
      ])

      const job = yield* anonSessionClient.anon.getAnonSourceJob({
        params: {
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
        },
      })
      expect(job).toEqual(
        expect.objectContaining({
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
          status: "queued",
        })
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns one anonymous paid source only for the matching payer wallet", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Payer-scoped anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null || created.syncJob === null) {
        return yield* Effect.die(
          "Anonymous source creation did not return claim metadata and sync job"
        )
      }

      const matchingSessionCookie = yield* createAnonSessionCookie()
      const matchingPayerClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${matchingSessionCookie}`
      )
      const source = yield* matchingPayerClient.anon.getAnonSource({
        params: { sourceId: created.source.id },
      })
      expect(source).toMatchObject({
        sourceId: created.source.id,
        requestId: created.claim.requestId,
        walletAddress: "So11111111111111111111111111111111111111112",
      })

      const otherSessionCookie = yield* createAnonSessionCookie({
        walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
      })
      const otherPayerClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${otherSessionCookie}`
      )
      const otherList = yield* otherPayerClient.anon.listAnonSources()
      expect(otherList.sources.map((visibleSource) => visibleSource.sourceId)).not.toContain(
        created.source.id
      )

      const otherSourceResult = yield* otherPayerClient.anon
        .getAnonSource({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      const otherJobsResult = yield* otherPayerClient.anon
        .listAnonSourceJobs({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      const otherJobResult = yield* otherPayerClient.anon
        .getAnonSourceJob({
          params: { sourceId: created.source.id, jobId: created.syncJob.jobId },
        })
        .pipe(Effect.result)

      for (const result of [otherSourceResult, otherJobsResult, otherJobResult]) {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("AnonNotFoundError")
        }
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "keeps authenticated and anonymous source collections separate when both cookies exist",
    () =>
      Effect.gen(function* () {
        const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
        const anonymousCreated = yield* anonymousClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Separated anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })

        if (anonymousCreated.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const userId = crypto.randomUUID()
        const principalId = crypto.randomUUID()
        yield* seedPrincipalUser({ userId, principalId })

        const authenticatedClient = yield* makeAuthenticatedClient({ userId })
        const authenticatedCreated = yield* authenticatedClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            name: "Separated authenticated Solana wallet",
          },
        })

        const sessionCookie = yield* createAnonSessionCookie()
        const combinedClient = yield* makeClientWithBearerTokenAndCookie({
          cookieHeader: `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`,
          token: `user_${userId}_admin`,
        })

        const authenticatedSources = yield* combinedClient.sources.listSources()
        expect(authenticatedSources.sources.map((source) => source.id)).toContain(
          authenticatedCreated.source.id
        )
        expect(authenticatedSources.sources.map((source) => source.id)).not.toContain(
          anonymousCreated.source.id
        )

        const anonymousSources = yield* combinedClient.anon.listAnonSources()
        expect(anonymousSources.sources.map((source) => source.sourceId)).toContain(
          anonymousCreated.source.id
        )
        expect(anonymousSources.sources.map((source) => source.sourceId)).not.toContain(
          authenticatedCreated.source.id
        )

        const anonOnlyClient = yield* makeClientWithCookie(
          `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
        )
        const authenticatedApiResult = yield* anonOnlyClient.sources
          .listSources()
          .pipe(Effect.result)
        expect(authenticatedApiResult._tag).toBe("Failure")
        if (authenticatedApiResult._tag === "Failure") {
          expect(authenticatedApiResult.failure._tag).toBe("UnauthorizedError")
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("removes claimed sources from anonymous payer-session access", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Claim transfer removes anon access",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const beforeClaim = yield* anonSessionClient.anon.listAnonSources()
      expect(beforeClaim.sources.map((source) => source.sourceId)).toContain(created.source.id)

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })
      expect(claimResponse.sourceId).toBe(created.source.id)

      const authenticatedSources = yield* authenticatedClient.sources.listSources()
      expect(authenticatedSources.sources.map((source) => source.id)).toContain(created.source.id)

      const afterClaim = yield* anonSessionClient.anon.listAnonSources()
      expect(afterClaim.sources.map((source) => source.sourceId)).not.toContain(created.source.id)

      const sourceResult = yield* anonSessionClient.anon
        .getAnonSource({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      expect(sourceResult._tag).toBe("Failure")
      if (sourceResult._tag === "Failure") {
        expect(sourceResult.failure._tag).toBe("AnonNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reuses an existing anonymous paid source when the payer session is active", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Idempotent anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const reused = yield* anonSessionClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Idempotent anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      expect(reused.source.id).toBe(created.source.id)
      expect(reused.created).toBe(false)
      expect(reused.claim).toBeNull()
      expect(reused.syncJob).toBeNull()
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("claims an anonymous paid source by payer-wallet SIWX without a claim token", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "SIWX claimable anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: null,
          siwxProof: makeTestSiwxProof({
            chainType: "solana",
            walletAddress: TEST_PAYER_WALLET,
            nonce: created.claim.requestId,
          }),
        },
      })

      expect(claimResponse.sourceId).toBe(created.source.id)

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects SIWX for the synced source wallet when it is not the payer wallet", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Source wallet SIWX mismatch",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: null,
            siwxProof: makeTestSiwxProof({
              chainType: "solana",
              walletAddress,
              nonce: created.claim.requestId,
            }),
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects payer-wallet SIWX with invalid domain, nonce, expiry, or chain", () =>
    Effect.gen(function* () {
      const requestId = crypto.randomUUID()
      const badProofs = [
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          domain: "evil.example",
          nonce: requestId,
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          nonce: "",
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          nonce: crypto.randomUUID(),
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          expirationTime: "2020-01-01T00:00:00.000Z",
          nonce: requestId,
        }),
        makeTestSiwxProof({
          chainType: "evm",
          walletAddress: TEST_PAYER_WALLET,
          nonce: requestId,
        }),
      ]

      const challengeResponse = yield* HttpClient.execute(
        HttpClientRequest.post("/v1/anon/session/challenge")
      )
      const challengeCookie = extractCookieValue(
        challengeResponse.headers,
        ANON_CHALLENGE_COOKIE_NAME
      )
      const anonChallengeClient = yield* makeClientWithCookie(
        `${ANON_CHALLENGE_COOKIE_NAME}=${challengeCookie}`
      )

      for (const siwxProof of badProofs) {
        const result = yield* anonChallengeClient.anon
          .createAnonSession({ payload: { siwxProof } })
          .pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("AnonBadRequestError")
        }
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects replaying a CLI claim token after a successful ownership move", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Replay protected anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimPayload = {
        requestId: created.claim.requestId,
        claimToken: created.claim.claimToken,
        siwxProof: null,
      }

      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: claimPayload,
      })
      expect(claimResponse.sourceId).toBe(created.source.id)

      const replayResult = yield* authenticatedClient.principals
        .claimPrincipal({ payload: claimPayload })
        .pipe(Effect.result)

      expect(replayResult._tag).toBe("Failure")
      if (replayResult._tag === "Failure") {
        expect(replayResult.failure._tag).toBe("PrincipalClaimNotFoundError")
      }

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({ principalId: schema.sources.principalId })
        .from(schema.sources)
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({ principalId })

      const claims = yield* db
        .select({ consumedAt: schema.principalClaims.consumedAt })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt instanceof Date)).toBe(true)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "prevents another user from claiming or reading an already-claimed anonymous source",
    () =>
      Effect.gen(function* () {
        const walletAddress = "So11111111111111111111111111111111111111112"
        const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
        const created = yield* anonymousClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress,
            name: "Cross-user claimed anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })

        if (created.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const claimingUserId = crypto.randomUUID()
        const claimingPrincipalId = crypto.randomUUID()
        yield* seedPrincipalUser({ userId: claimingUserId, principalId: claimingPrincipalId })

        const claimingClient = yield* makeAuthenticatedClient({ userId: claimingUserId })
        const claimPayload = {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        }

        const claimResponse = yield* claimingClient.principals.claimPrincipal({
          payload: claimPayload,
        })
        expect(claimResponse.sourceId).toBe(created.source.id)

        const otherUserId = crypto.randomUUID()
        const otherPrincipalId = crypto.randomUUID()
        yield* seedPrincipalUser({ userId: otherUserId, principalId: otherPrincipalId })

        const otherClient = yield* makeAuthenticatedClient({ userId: otherUserId })
        const otherClaimResult = yield* otherClient.principals
          .claimPrincipal({ payload: claimPayload })
          .pipe(Effect.result)

        expect(otherClaimResult._tag).toBe("Failure")
        if (otherClaimResult._tag === "Failure") {
          expect(otherClaimResult.failure._tag).toBe("PrincipalClaimNotFoundError")
        }

        const claimingSources = yield* claimingClient.sources.listSources()
        const otherSources = yield* otherClient.sources.listSources()
        expect(claimingSources.sources.map((source) => source.id)).toContain(created.source.id)
        expect(otherSources.sources.map((source) => source.id)).not.toContain(created.source.id)

        const db = yield* drizzle
        const [storedSource] = yield* db
          .select({ principalId: schema.sources.principalId })
          .from(schema.sources)
          .where(eq(schema.sources.id, created.source.id))
          .limit(1)
        expect(storedSource).toEqual({ principalId: claimingPrincipalId })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects an expired authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Expired claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.principalClaims)
        .set({ expiresAt: new Date("2025-01-01T00:00:00.000Z") })

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects an already consumed authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Consumed claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.principalClaims)
        .set({ consumedAt: new Date("2026-01-01T00:00:00.000Z") })
        .where(
          and(
            eq(schema.principalClaims.requestId, created.claim.requestId),
            eq(schema.principalClaims.claimType, "cli_claim_token")
          )
        )

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects a CLI claim token that is no longer owned by an anonymous principal", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "User principal claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const claimedUserId = crypto.randomUUID()
      const db = yield* drizzle
      yield* db.insert(schema.users).values({
        id: claimedUserId,
        email: `${claimedUserId}@taxmaxi.test`,
        name: "Already Claimed Test User",
      })
      yield* db.update(schema.principals).set({ kind: "user", userId: claimedUserId })

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects a CLI claim token whose wallet context no longer matches its source", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Mismatched wallet claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.addresses)
        .set({ address: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E" })

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns conflict when claiming a wallet the user already owns", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Conflicting anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const existing = yield* authenticatedClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Existing user Solana wallet",
        },
      })

      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimConflictError")
      }

      const db = yield* drizzle
      const visibleSources = yield* authenticatedClient.sources.listSources()
      expect(visibleSources.sources.map((source) => source.id)).toContain(existing.source.id)
      expect(visibleSources.sources.map((source) => source.id)).not.toContain(created.source.id)

      const [anonymousOwnership] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(anonymousOwnership).toEqual({
        sourcePrincipalId: created.source.principalId,
        addressPrincipalId: created.source.principalId,
      })

      const [existingOwnership] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, existing.source.id))
        .limit(1)
      expect(existingOwnership).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })

      const claims = yield* db
        .select({ consumedAt: schema.principalClaims.consumedAt })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt === null)).toBe(true)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns not found for an unknown authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const userId = crypto.randomUUID()
      const principalId = crypto.randomUUID()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: crypto.randomUUID(),
            claimToken: "unknown-claim-token",
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("requires authentication for CLI claim token lookup", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClient()
      const result = yield* client.principals
        .claimPrincipal({
          payload: {
            requestId: crypto.randomUUID(),
            claimToken: "unknown-claim-token",
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects anonymous source creation without x402 payment before side effects", () =>
    Effect.gen(function* () {
      const response = yield* postRawSourceCreate({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Unpaid anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourcePaymentRequiredError)(body)
      const bodyRecord = yield* EffectSchema.decodeUnknownEffect(
        EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)
      )(body)

      expect(response.status).toBe(402)
      expect(Headers.get(response.headers, "payment-required")).toEqual(
        Option.some("encoded-test-payment-requirements")
      )
      expect(decodedBody._tag).toBe("SourcePaymentRequiredError")
      expect(Object.hasOwn(bodyRecord, "paymentRequiredHeader")).toBe(false)

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      const sources = yield* db.select({ id: schema.sources.id }).from(schema.sources)
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(principals).toEqual([])
      expect(sources).toEqual([])
      expect(claims).toEqual([])
      expect(jobs).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns x402 settlement response header for paid anonymous source creation", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const response = yield* postRawSourceCreate({
        paymentSignatureHeader: validX402PaymentHeader,
        payload: {
          type: "onchain",
          walletAddress,
          name: "Anonymous paid Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourceCreateResponse)(body)

      expect(response.status).toBe(200)
      expect(Headers.get(response.headers, "payment-response")).toEqual(
        Option.some("encoded-test-payment-response")
      )
      const anonSessionCookie = extractCookieValue(response.headers, ANON_SESSION_COOKIE_NAME)
      expect(anonSessionCookie).not.toBe("")
      expect(decodedBody.created).toBe(true)
      expect(decodedBody.claim).not.toBeNull()
      expect(decodedBody.syncJob).not.toBeNull()
      expect(decodedBody.source).toMatchObject({
        name: "Anonymous paid Solana wallet",
        providerKey: "helius-solana",
      })
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        sourceId: decodedBody.source.id,
        principalId: decodedBody.source.principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects anonymous source creation with invalid x402 payment before side effects", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClientWithInvalidPayment()
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Invalid paid anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourcePaymentRequiredError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      const sources = yield* db.select({ id: schema.sources.id }).from(schema.sources)
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(principals).toEqual([])
      expect(sources).toEqual([])
      expect(claims).toEqual([])
      expect(jobs).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("does not persist anonymous source claims when x402 settlement fails", () =>
    Effect.gen(function* () {
      const response = yield* postRawSourceCreate({
        paymentHeader: validX402PaymentHeader,
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Unsettled anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourcePaymentRequiredError)(body)
      const bodyRecord = yield* EffectSchema.decodeUnknownEffect(
        EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)
      )(body)

      expect(response.status).toBe(402)
      expect(decodedBody._tag).toBe("SourcePaymentRequiredError")
      expect(decodedBody.message).toBe("x402 payment settlement failed.")
      expect(Object.hasOwn(bodyRecord, "paymentRequiredHeader")).toBe(false)

      const db = yield* drizzle
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(claims).toEqual([])
      expect(jobs).toHaveLength(1)
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(SettlementFailureHttpLive), Effect.scoped)
  )

  it.effect("does not settle x402 payment when paid anonymous sync enqueue fails", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClientWithPayment()
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Queue failure anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InternalServerError")
        expect(result.failure.message).toBe("Failed to enqueue source sync job.")
      }

      const db = yield* drizzle
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)

      expect(claims).toEqual([])
      expect(queueEvents).toHaveLength(0)
      expect(settlementEvents).toEqual([])
    }).pipe(Effect.provide(PaidQueueFailureHttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when invalid auth credentials are present", () =>
    Effect.gen(function* () {
      const client = yield* makeClientWithBearerToken("not-a-valid-token")
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      expect(principals).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when an invalid session cookie is present", () =>
    Effect.gen(function* () {
      const client = yield* makeClientWithCookie("taxmaxi_session=not-a-valid-session")
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            name: "First",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      expect(principals).toEqual([])
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
      expect(first.source.providerKey).toBe("helius-solana")
      expect(second.source.providerKey).toBe("helius-solana")
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
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourceBadRequestError")
        expect(result.failure.message).toBe("Invalid crypto address.")
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
        params: { sourceId },
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
        params: { sourceId },
      })
      const status = yield* client.sources.getSourceSyncJobStatus({
        params: { sourceId, jobId: started.jobId },
      })

      expect(status).toEqual({
        sourceId,
        jobId: started.jobId,
        status: "queued",
        phase: null,
        processedRecords: null,
        totalRecords: null,
        progressPercent: null,
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
        params: { sourceId },
      })
      const secondJob = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
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
        params: { sourceId },
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
          params: { sourceId },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InternalServerError")
        expect(result.failure.message).toBe("Failed to enqueue source sync job.")
      }
    }).pipe(Effect.provide(QueueFailureHttpLive), Effect.scoped)
  )

  it.effect(
    "returns a 422 naming blocking observations when a source has unresolved provider asset observations",
    () =>
      Effect.gen(function* () {
        const userId = crypto.randomUUID()
        const principalId = crypto.randomUUID()
        const sourceId = crypto.randomUUID()
        yield* seedCoinbaseSource({ userId, principalId, sourceId })

        const db = yield* drizzle
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            naturalKey: `unresolved-${sourceId}`,
            currencyCode: "XYZ",
            retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })

        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to create unresolved provider asset fixture")
        }

        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: providerAsset.id,
          sourceId,
        })

        const client = yield* makeAuthenticatedClient({ userId })
        const result = yield* client.sources
          .calculateTaxForSource({
            params: { sourceId },
            payload: { year: 2025, jurisdiction: "germany" },
          })
          .pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          const failure = result.failure
          expect(failure._tag).toBe("SourceTaxCalculationPendingError")
          if (failure._tag === "SourceTaxCalculationPendingError") {
            expect(failure.blockingObservations).toEqual([
              { provider: "coinbase", currencyCode: "XYZ" },
            ])
          }
        }
      }).pipe(Effect.provide(TaxCalculationHttpLive), Effect.scoped)
  )
})
