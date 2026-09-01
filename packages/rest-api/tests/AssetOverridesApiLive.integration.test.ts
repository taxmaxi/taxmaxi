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
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { eq } from "../../persistence/src/query/index.ts"
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
} as const

const checksumAddress = "0xAbCd000000000000000000000000000000000096"
const canonicalAddress = checksumAddress.toLowerCase()
const absentAddress = "0xabcd000000000000000000000000000000000097"
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

await Effect.runPromise(context.recreateTestDatabase())

describe("AssetOverridesApiLive", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

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
        checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
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
        checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
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
          recomputation: { status: "not_scheduled" },
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
          recomputation: { status: "not_scheduled" },
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
          recomputation: { status: "not_scheduled" },
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
          recomputation: { status: "not_scheduled" },
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
            checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
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
          recomputation: { status: "not_scheduled" },
        },
      })
    })
  )
})
