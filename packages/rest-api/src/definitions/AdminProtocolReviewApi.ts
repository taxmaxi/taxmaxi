/**
 * AdminProtocolReviewApi - Read-only protocol candidate review endpoints.
 *
 * @module AdminProtocolReviewApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"

export class ProtocolCandidateNotFoundError extends Schema.TaggedError<ProtocolCandidateNotFoundError>()(
  "ProtocolCandidateNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class ProtocolCandidateReviewRow extends Schema.Class<ProtocolCandidateReviewRow>(
  "ProtocolCandidateReviewRow"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  subjectKind: Schema.Literal("program", "contract", "protocol"),
  subjectIdentifier: Schema.String,
  protocolNameHint: Schema.NullOr(Schema.String),
  categoryHint: Schema.NullOr(Schema.String),
  mappingStatus: Schema.Literal("approved", "pending_review", "rejected"),
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  observationCount: Schema.Number,
}) {}

export class ProtocolCandidateReviewListResponse extends Schema.Class<ProtocolCandidateReviewListResponse>(
  "ProtocolCandidateReviewListResponse"
)({
  candidates: Schema.Array(ProtocolCandidateReviewRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class ProtocolCandidateObservationSourceMetadataResponse extends Schema.Class<ProtocolCandidateObservationSourceMetadataResponse>(
  "ProtocolCandidateObservationSourceMetadataResponse"
)({
  source: Schema.Literal("dune"),
  queryId: Schema.Number,
  queryName: Schema.String,
  queryVersion: Schema.Number,
}) {}

export class ProtocolCandidateObservationResponse extends Schema.Class<ProtocolCandidateObservationResponse>(
  "ProtocolCandidateObservationResponse"
)({
  id: Schema.String,
  onchainDataSource: Schema.Literal("dune"),
  onchainDataSourceObservationKey: Schema.String,
  observedWindowStart: Schema.DateTimeUtc,
  observedWindowEnd: Schema.DateTimeUtc,
  interactionCount: Schema.String,
  transactionCount: Schema.NullOr(Schema.String),
  uniqueActorCount: Schema.NullOr(Schema.String),
  relatedSubjectIdentifiers: Schema.Array(Schema.String),
  sampleTransactionHashes: Schema.Array(Schema.String),
  retrievedAt: Schema.DateTimeUtc,
  rawPayload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  sourceMetadata: ProtocolCandidateObservationSourceMetadataResponse,
}) {}

export class ProtocolCandidateReviewDetailResponse extends Schema.Class<ProtocolCandidateReviewDetailResponse>(
  "ProtocolCandidateReviewDetailResponse"
)({
  candidate: ProtocolCandidateReviewRow,
  observations: Schema.Array(ProtocolCandidateObservationResponse),
  observationsPage: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class TaxMaxiTransactionTypeResponse extends Schema.Class<TaxMaxiTransactionTypeResponse>(
  "TaxMaxiTransactionTypeResponse"
)({
  typeKey: Schema.String,
  categoryKey: Schema.NullOr(Schema.String),
  subcategoryKey: Schema.NullOr(Schema.String),
  labelEn: Schema.String,
  labelDe: Schema.String,
}) {}

export class TaxMaxiTransactionTypeListResponse extends Schema.Class<TaxMaxiTransactionTypeListResponse>(
  "TaxMaxiTransactionTypeListResponse"
)({
  transactionTypes: Schema.Array(TaxMaxiTransactionTypeResponse),
}) {}

const CandidateListQuery = Schema.Struct({
  cursor: Schema.optional(Schema.UUID),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(100)
    )
  ),
})

const CandidateDetailQuery = Schema.Struct({
  observationCursor: Schema.optional(Schema.UUID),
  observationLimit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(25)
    )
  ),
})

const listProtocolCandidates = HttpApiEndpoint.get(
  "listProtocolCandidates",
  "/protocol-review/candidates"
)
  .setUrlParams(CandidateListQuery)
  .addSuccess(ProtocolCandidateReviewListResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List protocol candidates waiting for review",
      description: "Lists pending protocol candidates for the admin review queue.",
    })
  )

const getProtocolCandidate = HttpApiEndpoint.get(
  "getProtocolCandidate",
  "/protocol-review/candidates/:candidateId"
)
  .setPath(
    Schema.Struct({
      candidateId: Schema.UUID,
    })
  )
  .setUrlParams(CandidateDetailQuery)
  .addSuccess(ProtocolCandidateReviewDetailResponse)
  .addError(ProtocolCandidateNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Get protocol candidate review detail",
      description: "Returns one candidate with source observations and Dune metadata.",
    })
  )

const listTaxMaxiTransactionTypes = HttpApiEndpoint.get(
  "listTaxMaxiTransactionTypes",
  "/protocol-review/transaction-types"
)
  .addSuccess(TaxMaxiTransactionTypeListResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List TaxMaxi transaction types",
      description: "Lists canonical TaxMaxi transaction types available for protocol mappings.",
    })
  )

export class AdminProtocolReviewApi extends HttpApiGroup.make("adminProtocolReview")
  .add(listProtocolCandidates)
  .add(getProtocolCandidate)
  .add(listTaxMaxiTransactionTypes)
  .middleware(AdminAuthMiddleware)
  .prefix("/v1/admin")
  .annotateContext(
    OpenApi.annotations({
      title: "Admin protocol review",
      description: "Read-only protocol candidate review endpoints",
    })
  ) {}
