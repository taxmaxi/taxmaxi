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
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { eq } from "../../persistence/src/query/index.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_protocol_review",
})
const TestPgClientLive = context.TestPgClientLive
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

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

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () =>
    Effect.dieMessage("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.dieMessage("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

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

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  AuthServiceTestLive,
  PasswordHasherTestLive,
  SourceSyncRunServiceTestLive,
  SourceSyncServiceTestLive,
  TransferReconciliationServiceTestLive
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

const makeClient = ({
  role,
  userId,
}: {
  readonly role: "admin" | "user"
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_${role}`))
      ),
    })
  })

const seedProtocolCandidate = Effect.gen(function* () {
  const db = yield* drizzle
  const [blockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))

  if (blockchain === undefined) {
    return yield* Effect.dieMessage("Missing solana blockchain seed")
  }

  const candidateId = crypto.randomUUID()
  const rejectedCandidateId = crypto.randomUUID()
  const observationId = crypto.randomUUID()
  const retrievedAt = new Date("2026-01-02T00:00:00.000Z")

  yield* db.insert(schema.protocolCandidates).values([
    {
      id: candidateId,
      blockchainId: blockchain.id,
      subjectKind: "program",
      subjectIdentifier: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      protocolNameHint: "Jupiter",
      categoryHint: "dex",
      mappingStatus: "pending_review",
      firstSeenAt: retrievedAt,
      lastSeenAt: retrievedAt,
    },
    {
      id: rejectedCandidateId,
      blockchainId: blockchain.id,
      subjectKind: "program",
      subjectIdentifier: "RejectedProgram11111111111111111111111111111",
      protocolNameHint: "Rejected",
      categoryHint: "dex",
      mappingStatus: "rejected",
      firstSeenAt: retrievedAt,
      lastSeenAt: retrievedAt,
    },
  ])
  yield* db.insert(schema.protocolCandidateObservations).values({
    id: observationId,
    candidateId,
    onchainDataSource: "dune",
    onchainDataSourceObservationKey: "dune:jupiter:2026-01",
    observedWindowStart: new Date("2026-01-01T00:00:00.000Z"),
    observedWindowEnd: new Date("2026-01-02T00:00:00.000Z"),
    interactionCount: "12",
    transactionCount: "7",
    uniqueActorCount: "5",
    relatedSubjectIdentifiers: ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"],
    sampleTransactionHashes: ["5qJupiterSampleSignature"],
    retrievedAt,
    rawPayload: { project: "jupiter", chain: "solana" },
  })
  yield* db.insert(schema.duneProtocolCandidateObservations).values({
    observationId,
    queryId: 7648079,
    queryName: "Solana DEX protocol candidates",
    queryVersion: 1,
  })

  return { candidateId }
})

await Effect.runPromise(context.recreateTestDatabase())

describe("AdminProtocolReviewApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
  })

  it.effect("lists pending protocol candidates for admins", () =>
    Effect.gen(function* () {
      const { candidateId } = yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: crypto.randomUUID(), role: "admin" })

      const response = yield* client.adminProtocolReview.listProtocolCandidates({
        urlParams: {},
      })

      expect(response.candidates).toHaveLength(1)
      expect(response.candidates[0]?.id).toBe(candidateId)
      expect(response.candidates[0]?.mappingStatus).toBe("pending_review")
      expect(response.candidates[0]?.observationCount).toBe(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns candidate detail and TaxMaxi transaction types for admins", () =>
    Effect.gen(function* () {
      const { candidateId } = yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: crypto.randomUUID(), role: "admin" })

      const detail = yield* client.adminProtocolReview.getProtocolCandidate({
        path: { candidateId },
      })
      const transactionTypes =
        yield* client.adminProtocolReview.listTaxMaxiTransactionTypes(undefined)

      expect(detail.candidate.id).toBe(candidateId)
      expect(detail.candidate.protocolNameHint).toBe("Jupiter")
      expect(detail.observations).toHaveLength(1)
      expect(detail.observations[0]?.relatedSubjectIdentifiers).toEqual([
        "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
      ])
      expect(detail.observations[0]?.sampleTransactionHashes).toEqual(["5qJupiterSampleSignature"])
      expect(detail.observations[0]?.sourceMetadata).toMatchObject({
        source: "dune",
        queryId: 7648079,
        queryName: "Solana DEX protocol candidates",
        queryVersion: 1,
      })
      expect(transactionTypes.transactionTypes.length).toBeGreaterThan(0)
      expect(transactionTypes.transactionTypes[0]?.typeKey).toBeDefined()
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects non-admin sessions", () =>
    Effect.gen(function* () {
      yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: crypto.randomUUID(), role: "user" })

      const result = yield* client.adminProtocolReview
        .listProtocolCandidates({
          urlParams: {},
        })
        .pipe(Effect.either)

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
