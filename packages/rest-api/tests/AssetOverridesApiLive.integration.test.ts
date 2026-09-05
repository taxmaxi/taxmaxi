import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SourceNormalizationRepository,
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
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { eq, sql } from "../../persistence/src/query/index.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { AssetOverrideCurrentResponse } from "../src/definitions/AssetOverridesApi.ts"
import { TransactionListResponse } from "../src/definitions/TransactionsApi.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_asset_overrides",
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

const ids = {
  userId: "00000000-0000-4000-8000-000000000801",
  principalId: "00000000-0000-4000-8000-000000000802",
  sourceId: "00000000-0000-4000-8000-000000000803",
  otherUserId: "00000000-0000-4000-8000-000000000804",
  otherPrincipalId: "00000000-0000-4000-8000-000000000805",
  otherSourceId: "00000000-0000-4000-8000-000000000806",
  systemAssetId: "00000000-0000-4000-8000-000000000807",
  changedSystemAssetId: "00000000-0000-4000-8000-000000000808",
  representationId: "00000000-0000-4000-8000-000000000809",
  targetId: "00000000-0000-4000-8000-000000000810",
  overrideId: "00000000-0000-4000-8000-000000000811",
  providerAssetId: "00000000-0000-4000-8000-000000000812",
  inclusionOverrideId: "00000000-0000-4000-8000-000000000813",
  calculationRunId: "00000000-0000-4000-8000-000000000814",
  firstWalletAddressId: "00000000-0000-4000-8000-000000000815",
  firstWalletSourceId: "00000000-0000-4000-8000-000000000816",
  secondWalletAddressId: "00000000-0000-4000-8000-000000000817",
  secondWalletSourceId: "00000000-0000-4000-8000-000000000818",
  otherWalletAddressId: "00000000-0000-4000-8000-000000000819",
  otherWalletSourceId: "00000000-0000-4000-8000-000000000820",
  firstProviderAssetId: "00000000-0000-4000-8000-000000000821",
  secondProviderAssetId: "00000000-0000-4000-8000-000000000822",
  firstHistoricalRawId: "00000000-0000-4000-8000-000000000823",
  secondHistoricalRawId: "00000000-0000-4000-8000-000000000824",
  otherHistoricalRawId: "00000000-0000-4000-8000-000000000825",
  firstFutureRawId: "00000000-0000-4000-8000-000000000826",
  secondFutureRawId: "00000000-0000-4000-8000-000000000827",
  otherFutureRawId: "00000000-0000-4000-8000-000000000828",
} as const

const checksumAddress = "0xAbCd000000000000000000000000000000000096"
const canonicalAddress = checksumAddress.toLowerCase()
const absentAddress = "0xabcd000000000000000000000000000000000097"
const revisionHash = "0".repeat(64)
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const representationQuery = (address: string = checksumAddress) =>
  `targetKind=representation&blockchain=Base&representationType=token&contractAddress=${address}`

const get = ({ path, userId = ids.userId }: { readonly path: string; readonly userId?: string }) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(
      HttpClientRequest.bearerToken(`user_${userId}_admin`),
      HttpClient.execute
    )
    return { status: response.status, body: yield* response.json }
  })

const post = ({
  path,
  payload,
  role = "user",
  userId = ids.userId,
}: {
  readonly path: string
  readonly payload: unknown
  readonly role?: "admin" | "readonly" | "user"
  readonly userId?: string
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyJsonUnsafe(payload),
      HttpClientRequest.bearerToken(`user_${userId}_${role}`),
      HttpClient.execute
    )
    return { status: response.status, body: yield* response.json }
  })

const seedOwnedRepresentation = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture({
    userId: ids.userId,
    principalId: ids.principalId,
    sourceId: ids.sourceId,
  })
  yield* seedSyncEngineRepositoryFixture({
    userId: ids.otherUserId,
    principalId: ids.otherPrincipalId,
    sourceId: ids.otherSourceId,
  })
  yield* seedSyncEngineAssets(fixture)

  const db = yield* drizzle
  yield* db.insert(schema.assets).values([
    {
      id: ids.systemAssetId,
      name: "USD Coin",
      symbol: "USDC",
      coingeckoCoinId: "usd-coin",
      type: "fungible",
    },
    {
      id: ids.changedSystemAssetId,
      name: "Ether",
      symbol: "ETH",
      coingeckoCoinId: "ethereum",
      type: "fungible",
    },
  ])
  yield* db.insert(schema.assetRepresentations).values({
    id: ids.representationId,
    assetId: ids.systemAssetId,
    blockchainId: fixture.baseBlockchainId,
    type: "token",
    contractAddress: canonicalAddress,
    mintAddress: null,
    decimals: 6,
    isSpam: false,
  })
  yield* db.insert(schema.sourceRepresentationUses).values({
    sourceId: ids.sourceId,
    blockchainId: fixture.baseBlockchainId,
    representationType: "token",
    contractAddress: checksumAddress,
    mintAddress: null,
  })
  yield* db.insert(schema.providerAssets).values({
    id: ids.providerAssetId,
    provider: "coinbase",
    providerAssetId: "chainless-usdc",
    currencyCode: "USDC",
    name: "USD Coin",
    exponent: 6,
    providerType: "crypto",
    retrievedAt: date("2026-09-01T06:00:00.000Z"),
  })
  yield* db.insert(schema.providerAssetMappings).values({
    providerAssetRowId: ids.providerAssetId,
    mappingKind: "asset",
    mappingStatus: "approved",
    canonicalAssetId: ids.systemAssetId,
    canonicalFiatCurrency: null,
  })
  yield* db.insert(schema.providerAssetSourceUses).values({
    providerAssetRowId: ids.providerAssetId,
    sourceId: ids.sourceId,
  })

  return fixture
})

const insertIdentityOverride = ({
  changeSystem = false,
  identityRevision,
  recordedAt = "2026-09-01T07:00:00.000Z",
}: {
  readonly changeSystem?: boolean
  readonly identityRevision: string
  readonly recordedAt?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [base] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)
    if (base === undefined) return yield* Effect.die("Missing Base fixture")

    yield* db.insert(schema.principalAssetOverrideTargets).values({
      id: ids.targetId,
      principalId: ids.principalId,
      targetKind: "representation",
      blockchainId: base.id,
      representationType: "token",
      contractAddress: canonicalAddress,
      mintAddress: null,
      providerAssetRowId: null,
    })
    yield* db.insert(schema.principalAssetOverrides).values({
      id: ids.overrideId,
      principalId: ids.principalId,
      targetId: ids.targetId,
      kind: "identity",
      operation: "create",
      inspectedSystemRevision: identityRevision,
      inspectedSystemIdentity: "resolved",
      inspectedSystemAssetId: ids.systemAssetId,
      inspectedSystemInclusion: null,
      replacementAssetId: TEST_BTC_ASSET_ID,
      replacementInclusion: null,
      actorUserId: ids.userId,
      reason: "Use TaxMaxi's existing BTC economic asset for this representation.",
      supersedesOverrideId: null,
      recordedAt: date(recordedAt),
    })
    if (changeSystem) {
      yield* db
        .update(schema.assetRepresentations)
        .set({ assetId: ids.changedSystemAssetId })
        .where(eq(schema.assetRepresentations.id, ids.representationId))
    }
  })

const seedActiveIdentityOverride = Effect.gen(function* () {
  yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
  const initial = yield* get({
    path: `/v1/asset-overrides/current?${representationQuery()}`,
  }).pipe(Effect.provide(HttpLive), Effect.scoped)
  const projection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(initial.body)
  yield* insertIdentityOverride({
    identityRevision: projection.system.identityRevision,
    recordedAt: "2026-08-01T07:00:00.000Z",
  }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
  return projection
})

const seedActiveInclusionOverride = Effect.gen(function* () {
  const projection = yield* seedActiveIdentityOverride
  yield* Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.principalAssetOverrides).values({
      id: ids.inclusionOverrideId,
      principalId: ids.principalId,
      targetId: ids.targetId,
      kind: "inclusion",
      operation: "create",
      inspectedSystemRevision: projection.system.inclusionRevision,
      inspectedSystemIdentity: null,
      inspectedSystemAssetId: null,
      inspectedSystemInclusion: "included",
      replacementAssetId: null,
      replacementInclusion: "excluded",
      actorUserId: ids.userId,
      reason: "Exclude this asset from my calculation.",
      supersedesOverrideId: null,
      recordedAt: date("2026-08-01T07:01:00.000Z"),
    })
  }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
  return projection
})

const identityReplacementPayload = ({
  activeOverrideId = ids.overrideId,
  assetId = ids.systemAssetId,
  systemRevision,
}: {
  readonly activeOverrideId?: string
  readonly assetId?: string
  readonly systemRevision: string
}) => ({
  _tag: "identity",
  assetId,
  expectedActiveOverrideId: activeOverrideId,
  expectedSystemRevision: systemRevision,
  reason: "Use a different existing economic asset.",
})

const withdrawalPayload = ({
  activeOverrideId = ids.overrideId,
  kind = "identity",
  systemRevision,
}: {
  readonly activeOverrideId?: string
  readonly kind?: "identity" | "inclusion"
  readonly systemRevision: string
}) => ({
  kind,
  expectedActiveOverrideId: activeOverrideId,
  expectedSystemRevision: systemRevision,
  reason: "Return to TaxMaxi's current conclusion.",
})

const inclusionReplacementPayload = ({ systemRevision }: { readonly systemRevision: string }) => ({
  _tag: "inclusion",
  inclusion: "included",
  expectedActiveOverrideId: ids.inclusionOverrideId,
  expectedSystemRevision: systemRevision,
  reason: "Include this asset in my calculation.",
})

const identityCreatePayload = ({
  assetId = TEST_BTC_ASSET_ID,
  systemRevision,
}: {
  readonly assetId?: string
  readonly systemRevision: string
}) => ({
  _tag: "identity",
  assetId,
  expectedSystemRevision: systemRevision,
  reason: "Use TaxMaxi's existing BTC economic asset for this representation.",
})

const inclusionCreatePayload = ({ systemRevision }: { readonly systemRevision: string }) => ({
  _tag: "inclusion",
  inclusion: "excluded",
  expectedSystemRevision: systemRevision,
  reason: "Exclude this asset from my calculation.",
})

const approvedBuyMapping = {
  providerTransactionType: "buy",
  transactionType: "buy_fiat",
  inventoryEffect: "acquisition",
  taxTreatment: "non_taxable_by_default",
  resolutionStrategy: "static",
  pairedRecordRequired: false,
  mappingStatus: "approved",
} as const

const runSourceNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  context.runWithLayer({
    effect,
    layer: RepositoriesLive,
  })

interface ExactWalletFact {
  readonly externalId: string
  readonly occurredAt: Date
  readonly principalId: string
  readonly providerAssetRowId: string
  readonly rawRecordId: string
  readonly sourceId: string
}

const persistExactWalletFact = ({
  blockchainId,
  externalId,
  occurredAt,
  principalId,
  providerAssetRowId,
  rawRecordId,
  sourceId,
}: ExactWalletFact & { readonly blockchainId: string }) =>
  runSourceNormalization(
    Effect.flatMap(SourceNormalizationRepository, (repository) =>
      repository.persistNormalizedArtifacts({
        transaction: {
          sourceId,
          sourceRawRecordId: rawRecordId,
          externalId: `${externalId}-transaction`,
          externalGroupId: externalId,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: `/t17/${externalId}`,
          providerDescription: "T17 exact representation fixture",
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: { externalId },
          providerFiatAmount: "100",
          providerFiatCurrency: "EUR",
          principalId,
        },
        venueContext: {
          venueType: "dex",
          cexAccountId: null,
          externalAccountId: sourceId,
          externalOrderId: null,
          externalFillId: null,
          side: "buy",
          instrument: "USDC-EUR",
          fillPrice: "100",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: { externalId },
        },
        providerTransfers: [
          {
            sourceId,
            sourceRawRecordId: rawRecordId,
            externalId: `${externalId}-provider-transfer`,
            externalGroupId: externalId,
            providerAssetId: providerAssetRowId,
            timestamp: occurredAt,
            direction: "inbound",
            processingMode: "evidence_only",
            fromAccountRef: "external",
            toAccountRef: sourceId,
            fromAddress: "external",
            toAddress: sourceId,
            networkName: "base",
            networkHash: `${externalId}-hash`,
            observedBlockchainId: blockchainId,
            observedRepresentationType: "token",
            observedContractAddress: canonicalAddress,
            observedMintAddress: null,
            observedDecimals: 6,
            amount: "1",
            metadata: { externalId },
          },
        ],
        canonicalTransfers: [
          {
            sourceId,
            principalId,
            sourceRawRecordId: rawRecordId,
            externalId: `${externalId}-transfer`,
            externalGroupId: externalId,
            addressId: null,
            blockchainId,
            txHash: null,
            timestamp: occurredAt,
            type: "erc20",
            fromAddress: "external",
            toAddress: sourceId,
            fromAccountRef: "external",
            toAccountRef: sourceId,
            fromPartyType: null,
            fromPartyResourcePath: null,
            toPartyType: null,
            toPartyResourcePath: null,
            assetId: ids.systemAssetId,
            assetRepresentationId: ids.representationId,
            providerAssetRowId,
            amount: "1",
            tokenId: null,
            notes: null,
            metadata: { externalId },
          },
        ],
        providerAssetRowIds: [providerAssetRowId],
        deriveLegs: ({ transaction }) =>
          Effect.succeed([
            {
              sourceId,
              sourceRawRecordId: rawRecordId,
              externalId: `${externalId}-leg`,
              txHash: null,
              timestamp: occurredAt,
              principalId,
              addressId: null,
              assetId: ids.systemAssetId,
              assetRepresentationId: ids.representationId,
              amount: "1",
              kind: "acquisition" as const,
              provenance: "deterministic" as const,
              derivationRule: "t17_exact_representation",
              providerAssetRowId,
              metadata: { externalId },
              transactionId: transaction.id,
              originKind: "none" as const,
              providerTransferId: null,
              sourceTransferId: null,
              fiatAmount: "100",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ]),
        transactionReview: null,
        resolvedTransactionType: approvedBuyMapping,
      })
    )
  )

const persistExactWalletFacts = ({
  blockchainId,
  facts,
}: {
  readonly blockchainId: string
  readonly facts: ReadonlyArray<ExactWalletFact>
}) =>
  Effect.forEach(facts, (fact) => persistExactWalletFact({ ...fact, blockchainId }), {
    concurrency: 1,
    discard: true,
  })

const t17Assets = [
  {
    id: ids.systemAssetId,
    name: "USD Coin",
    symbol: "USDC",
    coingeckoCoinId: "usd-coin",
    type: "fungible" as const,
  },
  {
    id: ids.changedSystemAssetId,
    name: "Ether",
    symbol: "ETH",
    coingeckoCoinId: "ethereum",
    type: "fungible" as const,
  },
]

const t17WalletAddresses = [
  {
    id: ids.firstWalletAddressId,
    principalId: ids.principalId,
    address: "0x0000000000000000000000000000000000000815",
    type: "evm" as const,
    name: "First owned wallet",
  },
  {
    id: ids.secondWalletAddressId,
    principalId: ids.principalId,
    address: "0x0000000000000000000000000000000000000817",
    type: "evm" as const,
    name: "Second owned wallet",
  },
  {
    id: ids.otherWalletAddressId,
    principalId: ids.otherPrincipalId,
    address: "0x0000000000000000000000000000000000000819",
    type: "evm" as const,
    name: "Other principal wallet",
  },
]

const t17WalletSources = [
  {
    id: ids.firstWalletSourceId,
    principalId: ids.principalId,
    name: "Helius Base wallet",
    providerKey: "helius-base",
    sourceableType: "onchain" as const,
    addressId: ids.firstWalletAddressId,
  },
  {
    id: ids.secondWalletSourceId,
    principalId: ids.principalId,
    name: "Alchemy Base wallet",
    providerKey: "alchemy-base",
    sourceableType: "onchain" as const,
    addressId: ids.secondWalletAddressId,
  },
  {
    id: ids.otherWalletSourceId,
    principalId: ids.otherPrincipalId,
    name: "Other principal Base wallet",
    providerKey: "helius-base",
    sourceableType: "onchain" as const,
    addressId: ids.otherWalletAddressId,
  },
]

const t17ProviderAssets = [
  {
    id: ids.firstProviderAssetId,
    provider: "helius-base",
    providerAssetId: canonicalAddress,
    currencyCode: "USDC",
    name: "USD Coin",
    exponent: 6,
    providerType: "crypto" as const,
    rawProviderPayload: {
      provider: "helius-base",
      contractAddress: canonicalAddress,
      decimals: 6,
    },
    retrievedAt: date("2026-08-01T06:00:00.000Z"),
  },
  {
    id: ids.secondProviderAssetId,
    provider: "alchemy-base",
    providerAssetId: canonicalAddress,
    currencyCode: "USDC",
    name: "USD Coin",
    exponent: 6,
    providerType: "crypto" as const,
    rawProviderPayload: {
      provider: "alchemy-base",
      contractAddress: canonicalAddress,
      decimals: 6,
    },
    retrievedAt: date("2026-08-01T06:01:00.000Z"),
  },
]

const t17ProviderMappings = [ids.firstProviderAssetId, ids.secondProviderAssetId].map(
  (providerAssetRowId) => ({
    providerAssetRowId,
    mappingKind: "asset" as const,
    mappingStatus: "approved" as const,
    canonicalAssetId: ids.systemAssetId,
    assetRepresentationId: null,
    canonicalFiatCurrency: null,
  })
)

const t17ProviderSourceUses = [
  { providerAssetRowId: ids.firstProviderAssetId, sourceId: ids.firstWalletSourceId },
  { providerAssetRowId: ids.secondProviderAssetId, sourceId: ids.secondWalletSourceId },
  { providerAssetRowId: ids.firstProviderAssetId, sourceId: ids.otherWalletSourceId },
]

const t17HistoricalRawRecords = (occurredAt: Date) => [
  {
    id: ids.firstHistoricalRawId,
    sourceId: ids.firstWalletSourceId,
    provider: "helius-base",
    recordType: "transaction",
    externalRecordId: "t17-first-historical",
    occurredAt,
    payload: { provider: "helius-base", record: "historical", amount: "1" },
  },
  {
    id: ids.secondHistoricalRawId,
    sourceId: ids.secondWalletSourceId,
    provider: "alchemy-base",
    recordType: "transaction",
    externalRecordId: "t17-second-historical",
    occurredAt,
    payload: { provider: "alchemy-base", record: "historical", amount: "1" },
  },
  {
    id: ids.otherHistoricalRawId,
    sourceId: ids.otherWalletSourceId,
    provider: "helius-base",
    recordType: "transaction",
    externalRecordId: "t17-other-historical",
    occurredAt,
    payload: { provider: "helius-base", record: "other-historical", amount: "1" },
  },
]

const seedT17IsolationFixture = Effect.gen(function* () {
  const firstPrincipal = yield* seedSyncEngineRepositoryFixture({
    userId: ids.userId,
    principalId: ids.principalId,
    sourceId: ids.sourceId,
  })
  yield* seedSyncEngineRepositoryFixture({
    userId: ids.otherUserId,
    principalId: ids.otherPrincipalId,
    sourceId: ids.otherSourceId,
  })
  yield* seedSyncEngineAssets(firstPrincipal)

  const db = yield* drizzle
  yield* db.insert(schema.assets).values(t17Assets)
  yield* db.insert(schema.assetRepresentations).values({
    id: ids.representationId,
    assetId: ids.systemAssetId,
    blockchainId: firstPrincipal.baseBlockchainId,
    type: "token",
    contractAddress: canonicalAddress,
    mintAddress: null,
    decimals: 6,
    isSpam: false,
  })
  yield* db.insert(schema.addresses).values(t17WalletAddresses)
  yield* db.insert(schema.sources).values(t17WalletSources)
  yield* db.insert(schema.providerAssets).values(t17ProviderAssets)
  yield* db.insert(schema.providerAssetMappings).values(t17ProviderMappings)
  yield* db.insert(schema.providerAssetSourceUses).values(t17ProviderSourceUses)

  const historicalAt = date("2026-08-01T08:00:00.000Z")
  yield* db.insert(schema.sourceRecordsRaw).values(t17HistoricalRawRecords(historicalAt))

  return { blockchainId: firstPrincipal.baseBlockchainId, historicalAt }
})

const seedT17FutureRawRecords = Effect.gen(function* () {
  const db = yield* drizzle
  const futureAt = date("2026-08-02T08:00:00.000Z")
  yield* db.insert(schema.sourceRecordsRaw).values([
    {
      id: ids.firstFutureRawId,
      sourceId: ids.firstWalletSourceId,
      provider: "helius-base",
      recordType: "transaction",
      externalRecordId: "t17-first-future",
      occurredAt: futureAt,
      payload: { provider: "helius-base", record: "future", amount: "1" },
    },
    {
      id: ids.secondFutureRawId,
      sourceId: ids.secondWalletSourceId,
      provider: "alchemy-base",
      recordType: "transaction",
      externalRecordId: "t17-second-future",
      occurredAt: futureAt,
      payload: { provider: "alchemy-base", record: "future", amount: "1" },
    },
    {
      id: ids.otherFutureRawId,
      sourceId: ids.otherWalletSourceId,
      provider: "helius-base",
      recordType: "transaction",
      externalRecordId: "t17-other-future",
      occurredAt: futureAt,
      payload: { provider: "helius-base", record: "other-future", amount: "1" },
    },
  ])
  return futureAt
})

const loadT17ProtectedFacts = Effect.gen(function* () {
  const db = yield* drizzle
  const historicalRawIds = new Set<string>([
    ids.firstHistoricalRawId,
    ids.secondHistoricalRawId,
    ids.otherHistoricalRawId,
  ])
  const providerAssetIds = new Set<string>([ids.firstProviderAssetId, ids.secondProviderAssetId])
  const historicalRawRows = (yield* db
    .select({
      id: schema.sourceRecordsRaw.id,
      sourceId: schema.sourceRecordsRaw.sourceId,
      provider: schema.sourceRecordsRaw.provider,
      externalRecordId: schema.sourceRecordsRaw.externalRecordId,
      payload: schema.sourceRecordsRaw.payload,
    })
    .from(schema.sourceRecordsRaw)
    .orderBy(schema.sourceRecordsRaw.id)).filter(({ id }) => historicalRawIds.has(id))
  const providerRows = (yield* db
    .select({
      id: schema.providerAssets.id,
      provider: schema.providerAssets.provider,
      providerAssetId: schema.providerAssets.providerAssetId,
      currencyCode: schema.providerAssets.currencyCode,
      exponent: schema.providerAssets.exponent,
      rawProviderPayload: schema.providerAssets.rawProviderPayload,
    })
    .from(schema.providerAssets)
    .orderBy(schema.providerAssets.id)).filter(({ id }) => providerAssetIds.has(id))
  const mappingRows = (yield* db
    .select({
      providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
      mappingKind: schema.providerAssetMappings.mappingKind,
      mappingStatus: schema.providerAssetMappings.mappingStatus,
      canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
    })
    .from(schema.providerAssetMappings)
    .orderBy(schema.providerAssetMappings.providerAssetRowId)).filter(({ providerAssetRowId }) =>
    providerAssetIds.has(providerAssetRowId)
  )

  return { historicalRawRows, providerRows, mappingRows }
})

const expectT17TransactionProjection = ({
  overridden,
  unchanged,
}: {
  readonly overridden: TransactionListResponse
  readonly unchanged: TransactionListResponse
}) => {
  expect(
    overridden.transactions.map(({ externalId, movements, source }) => ({
      externalId,
      sourceId: source.sourceId,
      sourceName: source.name,
      assetSymbols: movements.map(({ assetSymbol }) => assetSymbol),
    }))
  ).toEqual(
    expect.arrayContaining([
      {
        externalId: "t17-first-historical-transaction",
        sourceId: ids.firstWalletSourceId,
        sourceName: "Helius Base wallet",
        assetSymbols: ["BTC"],
      },
      {
        externalId: "t17-second-historical-transaction",
        sourceId: ids.secondWalletSourceId,
        sourceName: "Alchemy Base wallet",
        assetSymbols: ["BTC"],
      },
      {
        externalId: "t17-first-future-transaction",
        sourceId: ids.firstWalletSourceId,
        sourceName: "Helius Base wallet",
        assetSymbols: ["BTC"],
      },
      {
        externalId: "t17-second-future-transaction",
        sourceId: ids.secondWalletSourceId,
        sourceName: "Alchemy Base wallet",
        assetSymbols: ["BTC"],
      },
    ])
  )
  expect(overridden.totalCount).toBe(4)
  expect(
    unchanged.transactions.map(({ externalId, movements }) => ({
      externalId,
      assetSymbols: movements.map(({ assetSymbol }) => assetSymbol),
    }))
  ).toEqual(
    expect.arrayContaining([
      {
        externalId: "t17-other-historical-transaction",
        assetSymbols: ["USDC"],
      },
      { externalId: "t17-other-future-transaction", assetSymbols: ["USDC"] },
    ])
  )
  expect(unchanged.totalCount).toBe(2)
}

const installCreateRacePause = Effect.gen(function* () {
  const db = yield* drizzle
  yield* db.execute(sql`
    create function pause_override_target_insert() returns trigger
    language plpgsql as $trigger$
    begin
      perform pg_sleep(0.5);
      return new;
    end
    $trigger$
  `)
  yield* db.execute(sql`
    create trigger pause_override_target_insert
    before insert on principal_asset_override_targets
    for each row execute function pause_override_target_insert()
  `)
})

const waitForCreateRacePause = Effect.gen(function* () {
  const db = yield* drizzle
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = yield* db
      .select({
        isPaused: sql<boolean>`exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event = 'PgSleep'
          and query like 'insert into "principal_asset_override_targets"%'
      )`,
      })
      .from(schema.principals)
      .limit(1)
    if (activity?.isPaused === true) return
    yield* db.execute(sql`select pg_sleep(0.01)`)
  }
  return yield* Effect.die("Timed out waiting for the REST create race pause.")
})

const removeCreateRacePause = Effect.gen(function* () {
  const db = yield* drizzle
  yield* db.execute(
    sql`drop trigger pause_override_target_insert on principal_asset_override_targets`
  )
  yield* db.execute(sql`drop function pause_override_target_insert()`)
})

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetOverridesApiLive", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

  it.effect(
    "keeps one exact representation principal-scoped across providers, wallets, and time",
    () =>
      Effect.gen(function* () {
        const { blockchainId, historicalAt } = yield* seedT17IsolationFixture.pipe(
          Effect.provide(TestPgClientLive),
          Effect.scoped
        )
        yield* persistExactWalletFacts({
          blockchainId,
          facts: [
            {
              externalId: "t17-first-historical",
              occurredAt: historicalAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.firstProviderAssetId,
              rawRecordId: ids.firstHistoricalRawId,
              sourceId: ids.firstWalletSourceId,
            },
            {
              externalId: "t17-second-historical",
              occurredAt: historicalAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.secondProviderAssetId,
              rawRecordId: ids.secondHistoricalRawId,
              sourceId: ids.secondWalletSourceId,
            },
            {
              externalId: "t17-other-historical",
              occurredAt: historicalAt,
              principalId: ids.otherPrincipalId,
              providerAssetRowId: ids.firstProviderAssetId,
              rawRecordId: ids.otherHistoricalRawId,
              sourceId: ids.otherWalletSourceId,
            },
          ],
        })

        const beforeProtectedFacts = yield* loadT17ProtectedFacts.pipe(
          Effect.provide(TestPgClientLive),
          Effect.scoped
        )
        const beforeCatalog = yield* get({ path: `/v1/assets/${ids.systemAssetId}` }).pipe(
          Effect.provide(HttpLive),
          Effect.scoped
        )
        const initial = yield* get({
          path: `/v1/asset-overrides/current?${representationQuery()}`,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        const otherInitial = yield* get({
          path: `/v1/asset-overrides/current?${representationQuery()}`,
          userId: ids.otherUserId,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        const initialProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
          initial.body
        )

        expect(initialProjection.effectiveDecision).toEqual({
          _tag: "included",
          assetId: ids.systemAssetId,
        })
        expect(otherInitial).toMatchObject({
          status: 200,
          body: {
            activeIdentityOverride: null,
            effectiveDecision: { _tag: "included", assetId: ids.systemAssetId },
          },
        })

        const created = yield* post({
          path: `/v1/asset-overrides/create?${representationQuery()}`,
          payload: identityCreatePayload({
            systemRevision: initialProjection.system.identityRevision,
          }),
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        const createdProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
          created.body
        )
        if (createdProjection.recomputation.status === "not_scheduled") {
          return yield* Effect.die("T17 identity override did not schedule owned source work")
        }

        expect(createdProjection.effectiveDecision).toEqual({
          _tag: "included",
          assetId: TEST_BTC_ASSET_ID,
        })
        expect(
          createdProjection.recomputation.sourceJobs.map(({ sourceId }) => sourceId).sort()
        ).toEqual([ids.firstWalletSourceId, ids.secondWalletSourceId].sort())

        yield* persistExactWalletFacts({
          blockchainId,
          facts: [
            {
              externalId: "t17-first-historical",
              occurredAt: historicalAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.firstProviderAssetId,
              rawRecordId: ids.firstHistoricalRawId,
              sourceId: ids.firstWalletSourceId,
            },
            {
              externalId: "t17-second-historical",
              occurredAt: historicalAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.secondProviderAssetId,
              rawRecordId: ids.secondHistoricalRawId,
              sourceId: ids.secondWalletSourceId,
            },
          ],
        })

        const futureAt = yield* seedT17FutureRawRecords.pipe(
          Effect.provide(TestPgClientLive),
          Effect.scoped
        )
        yield* persistExactWalletFacts({
          blockchainId,
          facts: [
            {
              externalId: "t17-first-future",
              occurredAt: futureAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.firstProviderAssetId,
              rawRecordId: ids.firstFutureRawId,
              sourceId: ids.firstWalletSourceId,
            },
            {
              externalId: "t17-second-future",
              occurredAt: futureAt,
              principalId: ids.principalId,
              providerAssetRowId: ids.secondProviderAssetId,
              rawRecordId: ids.secondFutureRawId,
              sourceId: ids.secondWalletSourceId,
            },
            {
              externalId: "t17-other-future",
              occurredAt: futureAt,
              principalId: ids.otherPrincipalId,
              providerAssetRowId: ids.firstProviderAssetId,
              rawRecordId: ids.otherFutureRawId,
              sourceId: ids.otherWalletSourceId,
            },
          ],
        })

        const firstTransactionsResponse = yield* get({ path: "/v1/transactions?limit=100" }).pipe(
          Effect.provide(HttpLive),
          Effect.scoped
        )
        const otherTransactionsResponse = yield* get({
          path: "/v1/transactions?limit=100",
          userId: ids.otherUserId,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        const firstTransactions = yield* Schema.decodeUnknownEffect(TransactionListResponse)(
          firstTransactionsResponse.body
        )
        const otherTransactions = yield* Schema.decodeUnknownEffect(TransactionListResponse)(
          otherTransactionsResponse.body
        )

        expectT17TransactionProjection({
          overridden: firstTransactions,
          unchanged: otherTransactions,
        })

        const afterProtectedFacts = yield* loadT17ProtectedFacts.pipe(
          Effect.provide(TestPgClientLive),
          Effect.scoped
        )
        const afterCatalog = yield* get({ path: `/v1/assets/${ids.systemAssetId}` }).pipe(
          Effect.provide(HttpLive),
          Effect.scoped
        )
        expect(afterProtectedFacts).toEqual(beforeProtectedFacts)
        expect(afterCatalog).toEqual(beforeCatalog)

        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.assetRepresentations)
            .set({ assetId: ids.changedSystemAssetId })
            .where(eq(schema.assetRepresentations.id, ids.representationId))
        }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

        const afterGlobalChange = yield* get({
          path: `/v1/asset-overrides/current?${representationQuery()}`,
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        expect(afterGlobalChange).toMatchObject({
          status: 200,
          body: {
            system: { identity: { _tag: "resolved", assetId: ids.changedSystemAssetId } },
            activeIdentityOverride: { kind: "identity", operation: "create" },
            effectiveDecision: { _tag: "included", assetId: TEST_BTC_ASSET_ID },
            identityOverrideUsesStaleSystemRevision: true,
          },
        })
      })
  )

  it.effect("creates identity and inclusion overrides with durable recomputation work", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const initialProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )

      const identity = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          systemRevision: initialProjection.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const inclusion = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: inclusionCreatePayload({
          systemRevision: initialProjection.system.inclusionRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(identity).toMatchObject({
        status: 200,
        body: {
          activeIdentityOverride: {
            kind: "identity",
            operation: "create",
            replacementIdentity: { _tag: "resolved", assetId: TEST_BTC_ASSET_ID },
            supersedesOverrideId: null,
          },
          recomputation: {
            status: "updating",
            sourceJobs: [
              {
                overrideId: expect.any(String),
                sourceId: ids.sourceId,
                status: "pending",
                failureCode: null,
              },
            ],
          },
        },
      })
      expect(inclusion).toMatchObject({
        status: 200,
        body: {
          activeInclusionOverride: {
            kind: "inclusion",
            operation: "create",
            replacementInclusion: "excluded",
            supersedesOverrideId: null,
          },
          effectiveDecision: { _tag: "excluded" },
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
    })
  )

  it.effect("maps durable replay pending, running, failed, and credit-required states", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const initialProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const created = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          systemRevision: initialProjection.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const createdProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        created.body
      )
      if (createdProjection.recomputation.status === "not_scheduled") {
        return yield* Effect.die("Create did not expose durable replay work.")
      }
      const [sourceJob] = createdProjection.recomputation.sourceJobs
      if (sourceJob === undefined || sourceJob.jobId === null) {
        return yield* Effect.die("Create did not expose the selected replay job.")
      }
      const jobId = sourceJob.jobId
      const rejectedValidation = yield* get({
        path: `/v1/asset-overrides/validation?assetId=00000000-0000-4000-8000-000000000899&${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      expect(rejectedValidation).toMatchObject({
        status: 200,
        body: {
          _tag: "asset_not_found",
          recomputation: {
            status: "updating",
            overrideIds: [sourceJob.overrideId],
            sourceJobs: [{ overrideId: sourceJob.overrideId, status: "pending" }],
          },
        },
      })

      const setJobStatus = (
        status: "credit_required" | "failed" | "processing",
        creditReasonCode: string | null = null
      ) =>
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ status, creditReasonCode })
            .where(eq(schema.processingJobs.id, jobId))
        }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const readCurrent = () =>
        get({ path: `/v1/asset-overrides/current?${representationQuery()}` }).pipe(
          Effect.provide(HttpLive),
          Effect.scoped
        )

      yield* setJobStatus("processing")
      expect(yield* readCurrent()).toMatchObject({
        status: 200,
        body: {
          recomputation: {
            status: "updating",
            overrideIds: [sourceJob.overrideId],
            sourceJobs: [
              {
                overrideId: sourceJob.overrideId,
                requestedJobId: sourceJob.requestedJobId,
                jobId: sourceJob.jobId,
                status: "running",
                failureCode: null,
              },
            ],
          },
        },
      })

      yield* setJobStatus("failed")
      expect(yield* readCurrent()).toMatchObject({
        status: 200,
        body: {
          recomputation: {
            status: "failed",
            sourceJobs: [{ status: "failed", failureCode: "source_replay_failed" }],
          },
        },
      })

      yield* setJobStatus("credit_required", "credits_exhausted")
      expect(yield* readCurrent()).toMatchObject({
        status: 200,
        body: {
          recomputation: {
            status: "failed",
            sourceJobs: [{ status: "credit_required", failureCode: "credits_exhausted" }],
          },
        },
      })
    })
  )

  it.effect("exposes a calculation run only after its snapshot covers completed replay", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const initialProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const created = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          systemRevision: initialProjection.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const createdProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        created.body
      )
      if (createdProjection.recomputation.status === "not_scheduled") {
        return yield* Effect.die("Create did not expose durable replay work")
      }
      const jobId = createdProjection.recomputation.sourceJobs[0]?.jobId
      if (jobId === null || jobId === undefined) {
        return yield* Effect.die("Create did not expose its replay job")
      }

      const inputLedgerRevision = yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "completed",
            completedAt: date("2026-09-05T09:00:00.000Z"),
            updatedAt: date("2026-09-05T09:00:00.000Z"),
          })
          .where(eq(schema.processingJobs.id, jobId))
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`set transaction isolation level repeatable read`)
            const [snapshot] = yield* tx
              .select({
                transactionId: sql<string>`pg_current_xact_id()::text`,
                visibility: sql<string>`replace(pg_current_snapshot()::text, ':', '.')`,
              })
              .from(schema.principals)
              .where(eq(schema.principals.id, ids.principalId))
              .limit(1)
            if (snapshot === undefined) return yield* Effect.die("Missing principal snapshot")
            return `v2:${snapshot.transactionId}:${snapshot.visibility}:${revisionHash}`
          })
        )
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.calculationRuns).values({
          id: ids.calculationRunId,
          principalId: ids.principalId,
          jurisdiction: "de",
          taxYear: 2026,
          reportingCurrency: "eur",
          engineVersion: "t13-rest-test-engine",
          ruleSetVersion: "t13-rest-test-rules",
          inputLedgerRevision,
          valuationRevision: `sha256:${revisionHash}`,
          status: "partial",
          accountingMethod: "fifo",
          inventoryScope: "per_custody_unit",
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          failureCode: null,
          failureMessage: null,
          startedAt: date("2026-09-05T09:01:00.000Z"),
          completedAt: date("2026-09-05T09:02:00.000Z"),
        })
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      expect(
        yield* get({ path: `/v1/asset-overrides/current?${representationQuery()}` }).pipe(
          Effect.provide(HttpLive),
          Effect.scoped
        )
      ).toMatchObject({
        status: 200,
        body: {
          recomputation: {
            status: "partial",
            sourceJobs: [{ status: "complete" }],
            calculationRun: {
              runId: ids.calculationRunId,
              status: "partial",
              failureCode: null,
            },
          },
        },
      })
    })
  )

  it.effect("returns canonical current and append-only history reads with stale state", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(initial.status).toBe(200)
      expect(initial.body).toMatchObject({
        target: {
          _tag: "representation",
          blockchain: "base",
          type: "token",
          contractAddress: canonicalAddress,
          mintAddress: null,
        },
        system: { identity: { _tag: "resolved", assetId: ids.systemAssetId } },
        effectiveDecision: { _tag: "included", assetId: ids.systemAssetId },
        checkedTechnicalBlockerKinds: [
          "malformed_movement",
          "missing_decimals",
          "unsupported_asset_type",
        ],
        technicalBlockers: [],
        history: [],
        recomputation: { status: "not_scheduled" },
      })

      const initialBody = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      yield* insertIdentityOverride({
        changeSystem: true,
        identityRevision: initialBody.system.identityRevision,
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const current = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const history = yield* get({
        path: `/v1/asset-overrides/history?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(current.status).toBe(200)
      expect(current.body).toMatchObject({
        activeIdentityOverride: { id: ids.overrideId, actorUserId: ids.userId },
        effectiveDecision: { _tag: "included", assetId: TEST_BTC_ASSET_ID },
        identityOverrideUsesStaleSystemRevision: true,
        recomputation: { status: "not_scheduled" },
      })
      expect(history).toMatchObject({
        status: 200,
        body: {
          target: { contractAddress: canonicalAddress },
          history: [
            {
              id: ids.overrideId,
              kind: "identity",
              operation: "create",
              reason: "Use TaxMaxi's existing BTC economic asset for this representation.",
              recordedAt: "2026-09-01T07:00:00.000Z",
            },
          ],
          recomputation: { status: "not_scheduled" },
        },
      })
    })
  )

  it.effect("returns typed validation blockers and non-vetoing warnings", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const validation = yield* get({
        path: `/v1/asset-overrides/validation?assetId=${TEST_BTC_ASSET_ID}&${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(validation.status).toBe(200)
      expect(validation.body).toMatchObject({
        _tag: "ready",
        asset: { id: TEST_BTC_ASSET_ID, type: "fungible" },
        checkedTechnicalBlockerKinds: [
          "malformed_movement",
          "missing_decimals",
          "unsupported_asset_type",
        ],
        technicalBlockers: [],
        warnings: [
          { code: "symbol_mismatch" },
          { code: "name_mismatch" },
          { code: "market_data_identity_mismatch" },
          { code: "system_identity_mismatch" },
        ],
        recomputation: { status: "not_scheduled" },
      })
    })
  )

  it.effect("reads a chainless provider-asset fallback target", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const current = yield* get({
        path: `/v1/asset-overrides/current?targetKind=provider_asset&providerAssetRowId=${ids.providerAssetId}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(current).toMatchObject({
        status: 200,
        body: {
          target: { _tag: "provider_asset", providerAssetRowId: ids.providerAssetId },
          system: { identity: { _tag: "resolved", assetId: ids.systemAssetId } },
          recomputation: { status: "not_scheduled" },
        },
      })
    })
  )

  it.effect("requires authentication", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/v1/asset-overrides/current?${representationQuery()}`
      ).pipe(HttpClient.execute)

      expect(response.status).toBe(401)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("makes absent and unowned targets indistinguishable", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const absent = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery(absentAddress)}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const unowned = yield* get({
        userId: ids.otherUserId,
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(absent).toEqual(unowned)
      expect(absent).toEqual({
        status: 404,
        body: { _tag: "AssetOverrideTargetNotFoundError", code: "target_not_found" },
      })
    })
  )

  it.effect("returns machine-readable canonical-target errors", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const invalidAddress = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery("not-an-address")}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const unknownBlockchain = yield* get({
        path: `/v1/asset-overrides/current?targetKind=representation&blockchain=missing-chain&representationType=token&contractAddress=${canonicalAddress}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const invalidShape = yield* get({
        path: "/v1/asset-overrides/current?targetKind=provider_asset",
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(invalidAddress).toEqual({
        status: 400,
        body: {
          _tag: "AssetOverrideCanonicalTargetError",
          code: "invalid_canonical_target",
          reason: "invalid_evm_address",
        },
      })
      expect(unknownBlockchain).toEqual({
        status: 400,
        body: {
          _tag: "AssetOverrideCanonicalTargetError",
          code: "invalid_canonical_target",
          reason: "unknown_blockchain",
        },
      })
      expect(invalidShape).toEqual({
        status: 400,
        body: {
          _tag: "AssetOverrideCanonicalTargetError",
          code: "invalid_canonical_target",
          reason: "invalid_target_shape",
        },
      })
    })
  )

  it.effect("replaces an active override and returns its current recomputation state", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const response = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: identityReplacementPayload({
          systemRevision: initial.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response).toMatchObject({
        status: 200,
        body: {
          activeIdentityOverride: {
            kind: "identity",
            operation: "replace",
            actorUserId: ids.userId,
            replacementIdentity: { _tag: "resolved", assetId: ids.systemAssetId },
            supersedesOverrideId: ids.overrideId,
          },
          history: [{ id: ids.overrideId, operation: "create" }, { operation: "replace" }],
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
    })
  )

  it.effect("withdraws an active override without deleting its history", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const response = yield* post({
        path: `/v1/asset-overrides/withdraw?${representationQuery()}`,
        payload: withdrawalPayload({ systemRevision: initial.system.identityRevision }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response).toMatchObject({
        status: 200,
        body: {
          activeIdentityOverride: null,
          effectiveDecision: { _tag: "included", assetId: ids.systemAssetId },
          history: [{ id: ids.overrideId, operation: "create" }, { operation: "withdraw" }],
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
    })
  )

  it.effect("replaces and withdraws inclusion independently from identity", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveInclusionOverride
      const replaced = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: inclusionReplacementPayload({
          systemRevision: initial.system.inclusionRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(replaced).toMatchObject({
        status: 200,
        body: {
          activeIdentityOverride: { id: ids.overrideId },
          activeInclusionOverride: {
            kind: "inclusion",
            operation: "replace",
            replacementInclusion: "included",
            supersedesOverrideId: ids.inclusionOverrideId,
          },
          effectiveDecision: { _tag: "included", assetId: TEST_BTC_ASSET_ID },
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })

      const replacedProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        replaced.body
      )
      if (replacedProjection.activeInclusionOverride === null) {
        return yield* Effect.die("The inclusion replacement was not active.")
      }

      const withdrawn = yield* post({
        path: `/v1/asset-overrides/withdraw?${representationQuery()}`,
        payload: withdrawalPayload({
          activeOverrideId: replacedProjection.activeInclusionOverride.id,
          kind: "inclusion",
          systemRevision: replacedProjection.system.inclusionRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(withdrawn).toMatchObject({
        status: 200,
        body: {
          activeIdentityOverride: { id: ids.overrideId },
          activeInclusionOverride: null,
          effectiveDecision: { _tag: "included", assetId: TEST_BTC_ASSET_ID },
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
      const withdrawnProjection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        withdrawn.body
      )
      expect(
        withdrawnProjection.history
          .filter(({ kind }) => kind === "inclusion")
          .map(({ kind, operation }) => ({ kind, operation }))
      ).toEqual([
        { kind: "inclusion", operation: "create" },
        { kind: "inclusion", operation: "replace" },
        { kind: "inclusion", operation: "withdraw" },
      ])
    })
  )

  it.effect("rejects readonly mutation callers without writing", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const denied = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: identityReplacementPayload({
          systemRevision: initial.system.identityRevision,
        }),
        role: "readonly",
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const current = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(denied).toMatchObject({
        status: 403,
        body: {
          _tag: "AssetOverrideReadonlyError",
          code: "readonly_user",
        },
      })
      expect(current).toMatchObject({
        status: 200,
        body: { history: [{ id: ids.overrideId }] },
      })
    })
  )

  it.effect("makes absent and unowned mutation targets indistinguishable", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const payload = identityReplacementPayload({
        systemRevision: initial.system.identityRevision,
      })
      const absent = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery(absentAddress)}`,
        payload,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const unowned = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload,
        userId: ids.otherUserId,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(absent).toEqual(unowned)
      expect(absent).toEqual({
        status: 404,
        body: { _tag: "AssetOverrideTargetNotFoundError", code: "target_not_found" },
      })
    })
  )

  it.effect("returns canonical-target errors before mutation", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const response = yield* post({
        path: `/v1/asset-overrides/withdraw?${representationQuery("not-an-address")}`,
        payload: withdrawalPayload({ systemRevision: initial.system.identityRevision }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response).toEqual({
        status: 400,
        body: {
          _tag: "AssetOverrideCanonicalTargetError",
          code: "invalid_canonical_target",
          reason: "invalid_evm_address",
        },
      })
    })
  )

  it.effect("returns typed identity replacement failures with blocker coverage", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const missingAssetId = "00000000-0000-4000-8000-000000000899"
      const response = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: identityReplacementPayload({
          assetId: missingAssetId,
          systemRevision: initial.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response).toMatchObject({
        status: 422,
        body: {
          _tag: "AssetOverrideReplacementValidationError",
          code: "invalid_replacement",
          validation: {
            _tag: "asset_not_found",
            assetId: missingAssetId,
            checkedTechnicalBlockerKinds: [
              "malformed_movement",
              "missing_decimals",
              "unsupported_asset_type",
            ],
            technicalBlockers: [],
            recomputation: { status: "not_scheduled" },
          },
          currentProjection: {
            activeIdentityOverride: { id: ids.overrideId },
            recomputation: { status: "not_scheduled" },
          },
        },
      })
    })
  )

  it.effect("returns typed conflicts for stale system and active override revisions", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const staleSystem = yield* post({
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: identityReplacementPayload({
          systemRevision: `${initial.system.identityRevision}:stale`,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const staleActiveId = "00000000-0000-4000-8000-000000000898"
      const staleActive = yield* post({
        path: `/v1/asset-overrides/withdraw?${representationQuery()}`,
        payload: withdrawalPayload({
          activeOverrideId: staleActiveId,
          systemRevision: initial.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const current = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(staleSystem).toMatchObject({
        status: 409,
        body: {
          _tag: "AssetOverrideMutationConflictError",
          code: "override_conflict",
          conflictKinds: ["system_revision"],
          currentActiveOverrideId: ids.overrideId,
          currentProjection: {
            activeIdentityOverride: { id: ids.overrideId },
            recomputation: { status: "not_scheduled" },
          },
        },
      })
      expect(staleActive).toMatchObject({
        status: 409,
        body: {
          _tag: "AssetOverrideMutationConflictError",
          code: "override_conflict",
          conflictKinds: ["active_override"],
          currentActiveOverrideId: ids.overrideId,
          expectedActiveOverrideId: staleActiveId,
        },
      })
      expect(current).toMatchObject({ status: 200, body: { history: [{ id: ids.overrideId }] } })
    })
  )

  it.effect("serializes racing REST replacements so only one appends", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveIdentityOverride
      const request = {
        path: `/v1/asset-overrides/replace?${representationQuery()}`,
        payload: identityReplacementPayload({
          systemRevision: initial.system.identityRevision,
        }),
      }
      const attempts = yield* Effect.all([post(request), post(request)], {
        concurrency: "unbounded",
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(attempts.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 409,
      ])
      const conflict = attempts.find(({ status }) => status === 409)
      expect(conflict?.body).toMatchObject({
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["active_override"],
        currentProjection: {
          history: [{ id: ids.overrideId, operation: "create" }, { operation: "replace" }],
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
    })
  )

  it.effect("keeps absent and unowned create targets indistinguishable", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const projection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const payload = identityCreatePayload({
        systemRevision: projection.system.identityRevision,
      })
      const absent = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery(absentAddress)}`,
        payload,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const unowned = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload,
        userId: ids.otherUserId,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(absent).toEqual(unowned)
      expect(absent).toEqual({
        status: 404,
        body: { _tag: "AssetOverrideTargetNotFoundError", code: "target_not_found" },
      })
    })
  )

  it.effect("rejects readonly and invalid create requests without writing", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const projection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const payload = identityCreatePayload({
        systemRevision: projection.system.identityRevision,
      })
      const readonly = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload,
        role: "readonly",
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const invalidTarget = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery("not-an-address")}`,
        payload,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const invalidReplacement = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          assetId: "00000000-0000-4000-8000-000000000899",
          systemRevision: projection.system.identityRevision,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(readonly).toMatchObject({
        status: 403,
        body: { _tag: "AssetOverrideReadonlyError", code: "readonly_user" },
      })
      expect(invalidTarget).toMatchObject({
        status: 400,
        body: {
          _tag: "AssetOverrideCanonicalTargetError",
          reason: "invalid_evm_address",
        },
      })
      expect(invalidReplacement).toMatchObject({
        status: 422,
        body: {
          _tag: "AssetOverrideReplacementValidationError",
          validation: { _tag: "asset_not_found" },
        },
      })
      const current = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      expect(current).toMatchObject({ status: 200, body: { history: [] } })
    })
  )

  it.effect("returns a typed conflict for a stale create revision", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const projection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const response = yield* post({
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          systemRevision: `${projection.system.identityRevision}:stale`,
        }),
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response).toMatchObject({
        status: 409,
        body: {
          _tag: "AssetOverrideMutationConflictError",
          code: "override_conflict",
          conflictKinds: ["system_revision"],
          currentActiveOverrideId: null,
          expectedActiveOverrideId: null,
        },
      })
    })
  )

  it.effect("serializes racing REST creates so only one appends", () =>
    Effect.gen(function* () {
      yield* seedOwnedRepresentation.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const initial = yield* get({
        path: `/v1/asset-overrides/current?${representationQuery()}`,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const projection = yield* Schema.decodeUnknownEffect(AssetOverrideCurrentResponse)(
        initial.body
      )
      const request = {
        path: `/v1/asset-overrides/create?${representationQuery()}`,
        payload: identityCreatePayload({
          systemRevision: projection.system.identityRevision,
        }),
      }
      yield* installCreateRacePause.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const first = yield* post(request).pipe(
        Effect.provide(HttpLive),
        Effect.scoped,
        Effect.forkScoped
      )
      yield* waitForCreateRacePause.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const attempts = yield* Effect.all(
        [Fiber.join(first), post(request).pipe(Effect.provide(HttpLive), Effect.scoped)],
        { concurrency: "unbounded" }
      )
      yield* removeCreateRacePause.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      expect(attempts.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 409,
      ])
      const conflict = attempts.find(({ status }) => status === 409)
      expect(conflict?.body).toMatchObject({
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["active_override"],
        currentActiveOverrideId: expect.any(String),
        expectedActiveOverrideId: null,
        currentProjection: {
          history: [{ operation: "create" }],
          recomputation: {
            status: "updating",
            sourceJobs: [{ sourceId: ids.sourceId, status: "pending" }],
          },
        },
      })
    })
  )
})
