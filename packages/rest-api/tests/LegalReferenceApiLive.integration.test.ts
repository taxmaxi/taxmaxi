import { HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import { LegalReferenceService, LegalReferenceServiceLive } from "@my/core/legal"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { afterAll, describe, expect, it } from "vitest"
import {
  SourceSyncRunService,
  type SourceSyncRunServiceShape,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import {
  QuestionLegalReferencesResponse,
  TransactionTypeLegalReferencesResponse,
} from "../src/definitions/LegalReferenceApi.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"

const ACTIVE_DE_RULESET_VERSION = "de-crypto-income-tax-v2025-03-06"
const DE_CITATION_KEY_PATTERN = /^DE\.BMF\.2025-03-06\.RN[0-9A-Z]+$/
const INSUFFICIENT_CITED_BASIS_TEXT = "Insufficient cited basis in configured legal ruleset."

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_legal",
})
const TestPgClientLive = context.TestPgClientLive

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
  Layer.provide(SimpleTokenValidatorLive),
  Layer.provideMerge(PersistenceLayer),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

const postJson = <Response, Encoded, Requirements>({
  path,
  payload,
  responseSchema,
}: {
  readonly path: string
  readonly payload: unknown
  readonly responseSchema: Schema.Schema<Response, Encoded, Requirements>
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyUnsafeJson(payload),
      HttpClient.execute
    )
    const body = yield* response.json
    const decodedBody = yield* Schema.decodeUnknown(responseSchema)(body)

    return {
      status: response.status,
      body: decodedBody,
    }
  })

const resolveQuestionViaService = ({
  question,
  maxClauses,
}: {
  readonly question: string
  readonly maxClauses: number
}) =>
  Effect.gen(function* () {
    const service = yield* LegalReferenceService
    return yield* service.getRelevantClausesForQuestion({
      jurisdictionCode: "DE",
      question,
      maxClauses,
    })
  }).pipe(
    Effect.provide(LegalReferenceServiceLive),
    Effect.provide(PersistenceLayer),
    Effect.scoped
  )

await Effect.runPromise(context.recreateTestDatabase())

describe("LegalReferenceApiLive", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  it("returns question-level DE legal references from the active fresh-DB ruleset", async () => {
    const serviceResponse = await Effect.runPromise(
      resolveQuestionViaService({
        question: "Ist ein Tausch von ETH in einen anderen Coin steuerpflichtig?",
        maxClauses: 5,
      })
    )

    expect(serviceResponse.ruleSet?.version).toBe(ACTIVE_DE_RULESET_VERSION)
    expect(serviceResponse.references.length).toBeGreaterThan(0)

    const response = await Effect.runPromise(
      postJson({
        path: "/v1/legal/references/question",
        payload: {
          jurisdictionCode: "DE",
          question: "Ist ein Tausch von ETH in einen anderen Coin steuerpflichtig?",
          maxClauses: 5,
        },
        responseSchema: QuestionLegalReferencesResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.ruleSetVersion).toBe(ACTIVE_DE_RULESET_VERSION)
    expect(response.body.ruleSetName).toBe("DE Crypto Income Tax Ruleset (BMF 2025-03-06)")
    expect(response.body.insufficiencyText).toBeNull()
    expect(response.body.references.length).toBeGreaterThan(0)
    expect(
      response.body.references.every((reference: { clauseKey: string }) =>
        DE_CITATION_KEY_PATTERN.test(reference.clauseKey)
      )
    ).toBe(true)
    expect(
      response.body.references.every(
        (reference: { clauseKey: string }) => !reference.clauseKey.startsWith("chunk-")
      )
    ).toBe(true)
  })

  it("returns transaction-type references with configured DE citation keys and ruleset version", async () => {
    const response = await Effect.runPromise(
      postJson({
        path: "/v1/legal/references/transaction-type",
        payload: {
          jurisdictionCode: "DE",
          transactionTypeKey: "swap_crypto_to_crypto",
          maxReferences: 5,
          maxCitationsPerReference: 5,
        },
        responseSchema: TransactionTypeLegalReferencesResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.ruleSetVersion).toBe(ACTIVE_DE_RULESET_VERSION)
    expect(response.body.ruleSetName).toBe("DE Crypto Income Tax Ruleset (BMF 2025-03-06)")
    expect(response.body.references.length).toBeGreaterThan(0)
    expect(
      response.body.references.every(
        (reference: { citations: ReadonlyArray<unknown> }) => reference.citations.length > 0
      )
    ).toBe(true)
    expect(
      response.body.references
        .flatMap(
          (reference: { citations: ReadonlyArray<{ clauseKey: string }> }) => reference.citations
        )
        .every((citation: { clauseKey: string }) =>
          DE_CITATION_KEY_PATTERN.test(citation.clauseKey)
        )
    ).toBe(true)
    expect(
      response.body.references
        .flatMap(
          (reference: { citations: ReadonlyArray<{ clauseKey: string }> }) => reference.citations
        )
        .every((citation: { clauseKey: string }) => !citation.clauseKey.startsWith("chunk-"))
    ).toBe(true)
  })

  it("returns insufficiency text for unsupported questions without inventing references", async () => {
    const response = await Effect.runPromise(
      postJson({
        path: "/v1/legal/references/question",
        payload: {
          jurisdictionCode: "DE",
          question: "Blorptax quantum toaster carry rule for Martian NFTs?",
          maxClauses: 5,
        },
        responseSchema: QuestionLegalReferencesResponse,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.ruleSetVersion).toBe(ACTIVE_DE_RULESET_VERSION)
    expect(response.body.references).toEqual([])
    expect(response.body.insufficiencyText).toBe(INSUFFICIENT_CITED_BASIS_TEXT)
  })

  it("seeds exactly one active DE ruleset on a fresh migrated database", async () => {
    const activeRuleSets = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            jurisdictionCode: schema.jurisdictionRuleSets.jurisdictionCode,
            version: schema.jurisdictionRuleSets.version,
            isActive: schema.jurisdictionRuleSets.isActive,
          })
          .from(schema.jurisdictionRuleSets)
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
    )

    const activeDeRuleSets = activeRuleSets.filter(
      (ruleSet) => ruleSet.jurisdictionCode === "DE" && ruleSet.isActive
    )

    expect(activeDeRuleSets).toEqual([
      {
        jurisdictionCode: "DE",
        version: ACTIVE_DE_RULESET_VERSION,
        isActive: true,
      },
    ])
  })
})
