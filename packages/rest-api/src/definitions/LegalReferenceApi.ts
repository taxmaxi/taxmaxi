/**
 * LegalReferenceApi - HTTP schemas and endpoints for citation-backed legal retrieval.
 *
 * The API exposes deterministic legal references from configured rulesets so
 * frontend and AI flows can ground statements in DB-backed citation keys.
 *
 * @module LegalReferenceApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"

const NullableString = Schema.Union(Schema.String, Schema.Null)

/**
 * LegalReferenceValidationError - Request validation failure (400).
 */
export class LegalReferenceValidationError extends Schema.TaggedError<LegalReferenceValidationError>()(
  "LegalReferenceValidationError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 })
) {}

/**
 * LegalReferenceInternalError - Internal legal reference resolution failure (500).
 */
export class LegalReferenceInternalError extends Schema.TaggedError<LegalReferenceInternalError>()(
  "LegalReferenceInternalError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 })
) {}

/**
 * LegalCitationSource - Source metadata returned for each legal citation.
 */
export class LegalCitationSource extends Schema.Class<LegalCitationSource>("LegalCitationSource")({
  sourceKey: Schema.String,
  title: Schema.String,
  shortTitle: NullableString,
  sourceType: Schema.String,
  authority: Schema.String,
  sourceUrl: NullableString,
}) {}

/**
 * LegalCitationReferenceResponse - Clause-level citation payload.
 */
export class LegalCitationReferenceResponse extends Schema.Class<LegalCitationReferenceResponse>(
  "LegalCitationReferenceResponse"
)({
  clauseKey: Schema.String,
  sectionCode: NullableString,
  heading: NullableString,
  randnummer: Schema.String,
  summary: NullableString,
  clauseText: Schema.String,
  source: LegalCitationSource,
}) {}

/**
 * LegalRuleReferenceResponse - Rule payload including linked citations.
 */
export class LegalRuleReferenceResponse extends Schema.Class<LegalRuleReferenceResponse>(
  "LegalRuleReferenceResponse"
)({
  ruleId: Schema.String,
  ruleKey: Schema.String,
  title: Schema.String,
  description: Schema.String,
  scope: Schema.String,
  outcomeCategory: Schema.String,
  relevance: Schema.Number,
  citations: Schema.Array(LegalCitationReferenceResponse),
}) {}

/**
 * TransactionTypeLegalReferencesRequest - Request for transaction-type legal resolution.
 */
export class TransactionTypeLegalReferencesRequest extends Schema.Class<TransactionTypeLegalReferencesRequest>(
  "TransactionTypeLegalReferencesRequest"
)({
  transactionTypeKey: Schema.NonEmptyTrimmedString,
  jurisdictionCode: Schema.optional(Schema.NonEmptyTrimmedString),
  ruleSetVersion: Schema.optional(Schema.NonEmptyTrimmedString),
  maxReferences: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(20))
  ),
  maxCitationsPerReference: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(20))
  ),
}) {}

/**
 * TransactionTypeLegalReferencesResponse - Ruleset-backed references for a transaction type.
 */
export class TransactionTypeLegalReferencesResponse extends Schema.Class<TransactionTypeLegalReferencesResponse>(
  "TransactionTypeLegalReferencesResponse"
)({
  jurisdictionCode: Schema.String,
  ruleSetVersion: NullableString,
  ruleSetName: NullableString,
  references: Schema.Array(LegalRuleReferenceResponse),
}) {}

/**
 * QuestionLegalReferencesRequest - Request for question-level clause ranking.
 */
export class QuestionLegalReferencesRequest extends Schema.Class<QuestionLegalReferencesRequest>(
  "QuestionLegalReferencesRequest"
)({
  question: Schema.NonEmptyTrimmedString,
  jurisdictionCode: Schema.optional(Schema.NonEmptyTrimmedString),
  ruleSetVersion: Schema.optional(Schema.NonEmptyTrimmedString),
  maxClauses: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(20))
  ),
}) {}

/**
 * ScoredLegalClauseReferenceResponse - Clause result enriched with ranking score.
 */
export class ScoredLegalClauseReferenceResponse extends Schema.Class<ScoredLegalClauseReferenceResponse>(
  "ScoredLegalClauseReferenceResponse"
)({
  clauseKey: Schema.String,
  sectionCode: NullableString,
  heading: NullableString,
  randnummer: Schema.String,
  summary: NullableString,
  clauseText: Schema.String,
  score: Schema.Number,
  source: LegalCitationSource,
}) {}

/**
 * QuestionLegalReferencesResponse - Ranked clause set and insufficiency guardrail payload.
 */
export class QuestionLegalReferencesResponse extends Schema.Class<QuestionLegalReferencesResponse>(
  "QuestionLegalReferencesResponse"
)({
  jurisdictionCode: Schema.String,
  ruleSetVersion: NullableString,
  ruleSetName: NullableString,
  insufficiencyText: NullableString,
  references: Schema.Array(ScoredLegalClauseReferenceResponse),
}) {}

/**
 * resolveTransactionTypeReferences - Endpoint definition for transaction-type legal lookup.
 */
const resolveTransactionTypeReferences = HttpApiEndpoint.post(
  "resolveTransactionTypeReferences",
  "/references/transaction-type"
)
  .setPayload(TransactionTypeLegalReferencesRequest)
  .addSuccess(TransactionTypeLegalReferencesResponse)
  .addError(LegalReferenceValidationError)
  .addError(LegalReferenceInternalError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Resolve legal references by transaction type",
      description: "Returns deterministic legal references from the configured ruleset.",
    })
  )

/**
 * resolveQuestionReferences - Endpoint definition for question-level clause ranking.
 */
const resolveQuestionReferences = HttpApiEndpoint.post(
  "resolveQuestionReferences",
  "/references/question"
)
  .setPayload(QuestionLegalReferencesRequest)
  .addSuccess(QuestionLegalReferencesResponse)
  .addError(LegalReferenceValidationError)
  .addError(LegalReferenceInternalError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Resolve legal references by question",
      description:
        "Ranks legal clauses from the configured ruleset to ground AI responses with valid citations.",
    })
  )

/**
 * LegalReferenceApi - API group for legal reference retrieval.
 */
export class LegalReferenceApi extends HttpApiGroup.make("legalReferences")
  .add(resolveTransactionTypeReferences)
  .add(resolveQuestionReferences)
  .prefix("/v1/legal")
  .annotateContext(
    OpenApi.annotations({
      title: "Legal References",
      description:
        "Deterministic DE legal reference retrieval for product explainability and AI grounding.",
    })
  ) {}
