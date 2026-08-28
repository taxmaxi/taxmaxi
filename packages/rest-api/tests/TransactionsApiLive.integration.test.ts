import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
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
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import type { TransactionListResponse } from "../src/definitions/TransactionsApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_transactions",
})
const TestPgClientLive = context.TestPgClientLive
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

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
  getEnabledProviders: Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
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

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const getAuthenticatedStatus = ({
  path,
  userId,
}: {
  readonly path: string
  readonly userId: string
}) =>
  HttpClientRequest.get(path).pipe(
    HttpClientRequest.bearerToken(`user_${userId}_admin`),
    HttpClient.execute,
    Effect.map((response) => response.status)
  )

const fixtureIds = {
  userId: "00000000-0000-4000-8000-000000000181",
  principalId: "00000000-0000-4000-8000-000000000183",
  sourceId: "00000000-0000-4000-8000-000000000281",
  buyTransactionId: "00000000-0000-4000-8000-000000046101",
  sellTransactionId: "00000000-0000-4000-8000-000000046102",
  partialTransactionId: "00000000-0000-4000-8000-000000046103",
  unresolvedTransactionId: "00000000-0000-4000-8000-000000046104",
  excludedTransactionId: "00000000-0000-4000-8000-000000046105",
  internalTransferTransactionId: "00000000-0000-4000-8000-000000046106",
  pendingBasisTransactionId: "00000000-0000-4000-8000-000000046107",
  mixedCurrencyTransactionId: "00000000-0000-4000-8000-000000046108",
  missingProceedsTransactionId: "00000000-0000-4000-8000-000000046109",
  partialMatchTransactionId: "00000000-0000-4000-8000-000000046110",
  tieTransactionIds: [
    "00000000-0000-4000-8000-000000046111",
    "00000000-0000-4000-8000-000000046112",
    "00000000-0000-4000-8000-000000046113",
  ],
  buyLegId: "00000000-0000-4000-8000-000000046201",
  sellLegId: "00000000-0000-4000-8000-000000046202",
  partialLegId: "00000000-0000-4000-8000-000000046203",
  internalTransferLegId: "00000000-0000-4000-8000-000000046204",
  pendingBasisAcquisitionLegId: "00000000-0000-4000-8000-000000046205",
  pendingBasisDisposalLegId: "00000000-0000-4000-8000-000000046206",
  internalTransferOutLegId: "00000000-0000-4000-8000-000000046207",
  mixedCurrencyUsdLegId: "00000000-0000-4000-8000-000000046208",
  missingProceedsLegId: "00000000-0000-4000-8000-000000046209",
  partialMatchLegId: "00000000-0000-4000-8000-000000046210",
  tieLegIds: [
    "00000000-0000-4000-8000-000000046211",
    "00000000-0000-4000-8000-000000046212",
    "00000000-0000-4000-8000-000000046213",
  ],
  buyLotId: "00000000-0000-4000-8000-000000046301",
  pendingBasisLotId: "00000000-0000-4000-8000-000000046302",
  hiddenTransactionId: "00000000-0000-4000-8000-000000046901",
} as const

const seedTransactions = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture(fixtureIds)
  yield* seedSyncEngineAssets({
    baseBlockchainId: fixture.baseBlockchainId,
    bitcoinBlockchainId: fixture.bitcoinBlockchainId,
  })
  const otherFixture = yield* seedSyncEngineRepositoryFixture({
    userId: "00000000-0000-4000-8000-000000000191",
    principalId: "00000000-0000-4000-8000-000000000193",
    sourceId: "00000000-0000-4000-8000-000000000291",
  })
  const db = yield* drizzle

  yield* db.insert(schema.transactions).values([
    {
      id: fixtureIds.buyTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-buy",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
      transactionType: "buy_fiat",
      providerDescription: "Buy BTC",
    },
    {
      id: fixtureIds.sellTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-sell",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
      transactionType: "sell_fiat",
      providerDescription: "Sell BTC",
    },
    {
      id: fixtureIds.partialTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-partial-valuation",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T12:00:00.000Z")),
      transactionType: "buy_fiat",
      providerDescription: "Buy BTC with valuation pending",
    },
    {
      id: fixtureIds.unresolvedTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "coinbase-unresolved-asset",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
      transactionType: null,
      providerDescription: "Unresolved Coinbase activity",
      metadata: { provider: "coinbase", assetIdentity: "unresolved" },
    },
    {
      id: fixtureIds.excludedTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "coinbase-excluded-asset",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-09T12:00:00.000Z")),
      transactionType: null,
      providerDescription: "Excluded Coinbase activity",
      metadata: { provider: "coinbase", inclusion: "excluded" },
    },
    {
      id: fixtureIds.hiddenTransactionId,
      sourceId: otherFixture.sourceId,
      principalId: otherFixture.principalId,
      externalId: "other-principal-transaction",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
      transactionType: "buy_fiat",
    },
  ])
  yield* db.insert(schema.transactionLegs).values([
    {
      id: fixtureIds.buyLegId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-buy:acquisition",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
      assetId: TEST_BTC_ASSET_ID,
      amount: "0.5",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: fixtureIds.buyTransactionId,
      fiatAmount: "10000",
      fiatCurrency: "EUR",
    },
    {
      id: fixtureIds.sellLegId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-sell:disposal",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
      assetId: TEST_BTC_ASSET_ID,
      amount: "0.4",
      kind: "disposal",
      provenance: "deterministic",
      transactionId: fixtureIds.sellTransactionId,
      fiatAmount: "6000",
      fiatCurrency: "EUR",
    },
    {
      id: fixtureIds.partialLegId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-partial-valuation:acquisition",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T12:00:00.000Z")),
      assetId: TEST_BTC_ASSET_ID,
      amount: "0.1",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: fixtureIds.partialTransactionId,
      fiatAmount: null,
      fiatCurrency: null,
    },
  ])
  yield* db.insert(schema.fifoLots).values({
    id: fixtureIds.buyLotId,
    sourceId: fixture.sourceId,
    principalId: fixture.principalId,
    assetId: TEST_BTC_ASSET_ID,
    acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
    originalAmount: "0.5",
    remainingAmount: "0.1",
    costBasisPerToken: "10000",
    costBasisCurrency: "EUR",
    sourceLegId: fixtureIds.buyLegId,
  })
  yield* db.insert(schema.disposalMatches).values({
    disposalLegId: fixtureIds.sellLegId,
    fifoLotId: fixtureIds.buyLotId,
    matchedAmount: "0.4",
    costBasis: "4000",
    proceeds: "6000",
    gainLoss: "2000",
  })

  return fixture
})

await Effect.runPromise(context.recreateTestDatabase())

describe("TransactionsApiLive", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(context.recreateTestDatabase())))

  it.effect(
    "lists compact principal-owned transactions with an exact total and stable cursor",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          const fixture = yield* seedTransactions
          const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
          const first = yield* client.transactions.listTransactions({ query: { limit: 1 } })

          expect(first.totalCount).toBe(3)
          expect(first.transactions).toMatchObject([
            {
              transactionId: fixtureIds.sellTransactionId,
              timestamp: "2025-03-10T12:00:00.000Z",
              source: {
                sourceId: fixture.sourceId,
                name: `Coinbase Source ${fixture.sourceId}`,
                kind: "cex",
              },
              transactionType: "sell_fiat",
              description: "Sell BTC",
              externalId: "transaction-sell",
              movements: [{ amount: "0.4", assetSymbol: "BTC", kind: "disposal" }],
              realizedGainLoss: "2000",
              fiatCurrency: "EUR",
              calculationState: "complete",
              needsReview: false,
            },
          ])
          expect(first.page.hasMore).toBe(true)
          expect(first.page.nextCursor).not.toBeNull()

          const cursor = first.page.nextCursor
          if (cursor === null) {
            return yield* Effect.die("Expected a transaction cursor")
          }

          const second = yield* client.transactions.listTransactions({
            query: { cursor, limit: 1 },
          })
          expect(second.totalCount).toBe(3)
          expect(second.transactions.map((transaction) => transaction.transactionId)).toEqual([
            fixtureIds.partialTransactionId,
          ])
          expect(second.transactions[0]).toMatchObject({
            movements: [{ amount: "0.1", assetSymbol: "BTC", kind: "acquisition" }],
            realizedGainLoss: null,
            fiatCurrency: null,
            calculationState: "partial",
          })
          expect(second.page.hasMore).toBe(true)

          const secondCursor = second.page.nextCursor
          if (secondCursor === null) {
            return yield* Effect.die("Expected a second transaction cursor")
          }

          const third = yield* client.transactions.listTransactions({
            query: { cursor: secondCursor, limit: 1 },
          })
          expect(third.totalCount).toBe(3)
          expect(third.transactions.map((transaction) => transaction.transactionId)).toEqual([
            fixtureIds.buyTransactionId,
          ])
          expect(third.transactions[0]?.calculationState).toBe("complete")
          expect(third.page).toEqual({ hasMore: false, nextCursor: null })

          const listedIds = [
            ...first.transactions,
            ...second.transactions,
            ...third.transactions,
          ].map((transaction) => transaction.transactionId)
          expect(listedIds).not.toContain(fixtureIds.unresolvedTransactionId)
          expect(listedIds).not.toContain(fixtureIds.excludedTransactionId)
          expect(listedIds).not.toContain(fixtureIds.hiddenTransactionId)
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
      )
  )

  it.effect("uses the transaction ID as the cursor tie-breaker for equal timestamps", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z"))

        yield* db.insert(schema.transactions).values(
          fixtureIds.tieTransactionIds.map((id, index) => ({
            id,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: `transaction-tie-${index + 1}`,
            timestamp,
            transactionType: "buy_fiat",
          }))
        )
        yield* db.insert(schema.transactionLegs).values(
          fixtureIds.tieLegIds.map((id, index) => ({
            id,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: `transaction-tie-${index + 1}:acquisition`,
            timestamp,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "acquisition" as const,
            provenance: "deterministic" as const,
            transactionId: fixtureIds.tieTransactionIds[index],
            fiatAmount: "1000",
            fiatCurrency: "EUR",
          }))
        )

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const listedIds: Array<string> = []
        let cursor: string | null = null

        for (let page = 0; page < 3; page += 1) {
          const response: TransactionListResponse = yield* client.transactions.listTransactions({
            query: { ...(cursor === null ? {} : { cursor }), limit: 1 },
          })
          listedIds.push(...response.transactions.map((transaction) => transaction.transactionId))
          cursor = response.page.nextCursor
        }

        expect(listedIds).toEqual(
          [...fixtureIds.tieTransactionIds].sort((left, right) => right.localeCompare(left))
        )
        expect(new Set(listedIds).size).toBe(3)
        expect(cursor).not.toBeNull()
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("returns 400 for a malformed transaction cursor", () =>
    Effect.gen(function* () {
      const status = yield* Effect.gen(function* () {
        const fixture = yield* seedTransactions
        return yield* getAuthenticatedStatus({
          path: "/v1/transactions?cursor=not-a-cursor",
          userId: fixture.userId,
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(status).toBe(400)
    })
  )

  it.effect("keeps non-taxable transfers complete and marks unfinished calculations partial", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle

        yield* db.insert(schema.transactions).values([
          {
            id: fixtureIds.internalTransferTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-internal-transfer",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
            transactionType: "internal_transfer",
          },
          {
            id: fixtureIds.pendingBasisTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-pending-basis",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-21T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.mixedCurrencyTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-mixed-currency",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-22T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.missingProceedsTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-missing-proceeds",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-23T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.partialMatchTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-partial-match",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-24T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
        ])
        yield* db.insert(schema.transactionLegs).values([
          {
            id: fixtureIds.internalTransferLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-internal-transfer:in",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: fixtureIds.internalTransferTransactionId,
            derivationRule: "internal_transfer_in",
            fiatAmount: null,
            fiatCurrency: null,
          },
          {
            id: fixtureIds.pendingBasisAcquisitionLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-buy:pending-basis-acquisition",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-02T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: fixtureIds.buyTransactionId,
            fiatAmount: "1000",
            fiatCurrency: "EUR",
          },
          {
            id: fixtureIds.pendingBasisDisposalLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-pending-basis:disposal",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-21T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: fixtureIds.pendingBasisTransactionId,
            fiatAmount: "1500",
            fiatCurrency: "EUR",
          },
          {
            id: fixtureIds.internalTransferOutLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-internal-transfer:out",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: fixtureIds.internalTransferTransactionId,
            derivationRule: "internal_transfer_out",
            fiatAmount: "1000",
            fiatCurrency: "EUR",
          },
          {
            id: fixtureIds.mixedCurrencyUsdLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-mixed-currency:usd",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-22T12:00:01.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: fixtureIds.mixedCurrencyTransactionId,
            fiatAmount: "1600",
            fiatCurrency: "USD",
          },
          {
            id: fixtureIds.missingProceedsLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-missing-proceeds:disposal",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-23T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: fixtureIds.missingProceedsTransactionId,
            fiatAmount: null,
            fiatCurrency: null,
          },
          {
            id: fixtureIds.partialMatchLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-partial-match:disposal",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-24T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: fixtureIds.partialMatchTransactionId,
            fiatAmount: "1500",
            fiatCurrency: "EUR",
          },
        ])
        yield* db.insert(schema.fifoLots).values({
          id: fixtureIds.pendingBasisLotId,
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-02T12:00:00.000Z")),
          originalAmount: "0.1",
          remainingAmount: "0",
          costBasisPerToken: "0",
          costBasisCurrency: "EUR",
          costBasisStatus: "pending_review",
          sourceLegId: fixtureIds.pendingBasisAcquisitionLegId,
        })
        yield* db.insert(schema.disposalMatches).values([
          {
            disposalLegId: fixtureIds.pendingBasisDisposalLegId,
            fifoLotId: fixtureIds.pendingBasisLotId,
            matchedAmount: "0.1",
            costBasis: "0",
            proceeds: "1500",
            gainLoss: "1500",
          },
          {
            disposalLegId: fixtureIds.internalTransferOutLegId,
            fifoLotId: fixtureIds.buyLotId,
            matchedAmount: "0.1",
            costBasis: "1000",
            proceeds: "1000",
            gainLoss: "0",
          },
          {
            disposalLegId: fixtureIds.mixedCurrencyUsdLegId,
            fifoLotId: fixtureIds.buyLotId,
            matchedAmount: "0.1",
            costBasis: "1000",
            proceeds: "1600",
            gainLoss: "600",
          },
          {
            disposalLegId: fixtureIds.missingProceedsLegId,
            fifoLotId: fixtureIds.buyLotId,
            matchedAmount: "0.1",
            costBasis: "1000",
            proceeds: "0",
            gainLoss: "-1000",
          },
          {
            disposalLegId: fixtureIds.partialMatchLegId,
            fifoLotId: fixtureIds.buyLotId,
            matchedAmount: "0.05",
            costBasis: "500",
            proceeds: "750",
            gainLoss: "250",
          },
        ])

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 20 } })
        const internalTransfer = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.internalTransferTransactionId
        )
        const pendingBasis = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.pendingBasisTransactionId
        )
        const mixedCurrency = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.mixedCurrencyTransactionId
        )
        const missingProceeds = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.missingProceedsTransactionId
        )
        const partialMatch = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.partialMatchTransactionId
        )
        if (
          internalTransfer === undefined ||
          pendingBasis === undefined ||
          mixedCurrency === undefined ||
          missingProceeds === undefined ||
          partialMatch === undefined
        ) {
          return yield* Effect.die("Expected calculation-state fixtures in the transaction list")
        }

        expect(internalTransfer).toMatchObject({
          calculationState: "complete",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(pendingBasis).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(mixedCurrency).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(missingProceeds).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(partialMatch).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )
})
