/**
 * AdminProtocolReviewApiLive - Live implementation of read-only protocol review endpoints.
 *
 * @module AdminProtocolReviewApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import {
  ProtocolCandidateRepository,
  type ProtocolCandidateReviewListRow,
  type ProtocolCandidateReviewObservation,
  type TaxMaxiTransactionTypeReference,
} from "@my/sync-engine/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  ProtocolCandidateInvalidCursorError,
  ProtocolCandidateNotFoundError,
  ProtocolCandidateObservationResponse,
  ProtocolCandidateObservationSourceMetadataResponse,
  ProtocolCandidateReviewDetailResponse,
  ProtocolCandidateReviewListResponse,
  ProtocolCandidateReviewRow,
  TaxMaxiTransactionTypeListResponse,
  TaxMaxiTransactionTypeResponse,
} from "../definitions/AdminProtocolReviewApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"

const defaultLimit = 50
const defaultObservationLimit = 10

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })
const invalidCursorError = (cursorName: string) =>
  new ProtocolCandidateInvalidCursorError({ message: `Invalid ${cursorName} cursor.` })

const toDateTimeUtc = (date: Date): DateTime.Utc => DateTime.unsafeMake(date)

const CandidateCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  lastSeenAt: Schema.DateTimeUtc,
  id: Schema.UUID,
})

const ObservationCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  retrievedAt: Schema.DateTimeUtc,
  id: Schema.UUID,
})

const EncodedCandidateCursorPayload = Schema.parseJson(CandidateCursorPayload)
const EncodedObservationCursorPayload = Schema.parseJson(ObservationCursorPayload)

const encodePayload = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url")

const decodePayload = <A>(
  cursor: string,
  schema: Schema.Schema<A, string>,
  cursorName: string
): Effect.Effect<A, ProtocolCandidateInvalidCursorError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url").toString("utf8"),
      catch: () => invalidCursorError(cursorName),
    })

    return yield* Schema.decodeUnknown(schema)(decoded).pipe(
      Effect.mapError(() => invalidCursorError(cursorName))
    )
  })

const decodeCandidateCursor = (cursor: string | undefined) =>
  Effect.gen(function* () {
    if (cursor === undefined) {
      return null
    }

    const payload = yield* decodePayload(
      cursor,
      EncodedCandidateCursorPayload,
      "protocol candidate"
    )
    return {
      id: payload.id,
      lastSeenAt: DateTime.toDateUtc(payload.lastSeenAt),
    }
  })

const decodeObservationCursor = (cursor: string | undefined) =>
  Effect.gen(function* () {
    if (cursor === undefined) {
      return null
    }

    const payload = yield* decodePayload(
      cursor,
      EncodedObservationCursorPayload,
      "protocol candidate observation"
    )
    return {
      id: payload.id,
      retrievedAt: DateTime.toDateUtc(payload.retrievedAt),
    }
  })

const candidateCursorFor = (candidate: ProtocolCandidateReviewListRow): string =>
  encodePayload({
    version: 1,
    lastSeenAt: candidate.lastSeenAt.toISOString(),
    id: candidate.id,
  })

const observationCursorFor = (observation: ProtocolCandidateReviewObservation): string =>
  encodePayload({
    version: 1,
    retrievedAt: observation.retrievedAt.toISOString(),
    id: observation.id,
  })

const toProtocolCandidateReviewRow = (
  row: ProtocolCandidateReviewListRow
): ProtocolCandidateReviewRow =>
  ProtocolCandidateReviewRow.make({
    id: row.id,
    blockchainId: row.blockchainId,
    blockchainName: row.blockchainName,
    subjectKind: row.subjectKind,
    subjectIdentifier: row.subjectIdentifier,
    protocolNameHint: row.protocolNameHint,
    categoryHint: row.categoryHint,
    mappingStatus: row.mappingStatus,
    firstSeenAt: toDateTimeUtc(row.firstSeenAt),
    lastSeenAt: toDateTimeUtc(row.lastSeenAt),
    observationCount: row.observationCount,
  })

const toProtocolCandidateObservationResponse = (
  observation: ProtocolCandidateReviewObservation
): ProtocolCandidateObservationResponse =>
  ProtocolCandidateObservationResponse.make({
    id: observation.id,
    onchainDataSource: observation.onchainDataSource,
    onchainDataSourceObservationKey: observation.onchainDataSourceObservationKey,
    observedWindowStart: toDateTimeUtc(observation.observedWindowStart),
    observedWindowEnd: toDateTimeUtc(observation.observedWindowEnd),
    interactionCount: observation.interactionCount,
    transactionCount: observation.transactionCount,
    uniqueActorCount: observation.uniqueActorCount,
    relatedSubjectIdentifiers: [...observation.relatedSubjectIdentifiers],
    sampleTransactionHashes: [...observation.sampleTransactionHashes],
    retrievedAt: toDateTimeUtc(observation.retrievedAt),
    rawPayload: observation.rawPayload,
    sourceMetadata: ProtocolCandidateObservationSourceMetadataResponse.make({
      source: observation.sourceMetadata.source,
      queryId: observation.sourceMetadata.queryId,
      queryName: observation.sourceMetadata.queryName,
      queryVersion: observation.sourceMetadata.queryVersion,
    }),
  })

const toTaxMaxiTransactionTypeResponse = (
  transactionType: TaxMaxiTransactionTypeReference
): TaxMaxiTransactionTypeResponse =>
  TaxMaxiTransactionTypeResponse.make({
    typeKey: transactionType.typeKey,
    categoryKey: transactionType.categoryKey,
    subcategoryKey: transactionType.subcategoryKey,
    labelEn: transactionType.labelEn,
    labelDe: transactionType.labelDe,
  })

export const AdminProtocolReviewApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "adminProtocolReview",
  (handlers) =>
    Effect.gen(function* () {
      const protocolCandidateRepository = yield* ProtocolCandidateRepository

      return handlers
        .handle("listProtocolCandidates", ({ urlParams }) =>
          Effect.gen(function* () {
            const cursor = yield* decodeCandidateCursor(urlParams.cursor)
            const candidates = yield* protocolCandidateRepository
              .listPendingReviewCandidates({
                cursor,
                limit: (urlParams.limit ?? defaultLimit) + 1,
              })
              .pipe(
                Effect.mapError(() => toInternalServerError("Failed to list protocol candidates."))
              )
            const limit = urlParams.limit ?? defaultLimit
            const visibleCandidates = candidates.slice(0, limit)
            const lastCandidate = visibleCandidates.at(-1)
            const hasMore = candidates.length > limit

            return ProtocolCandidateReviewListResponse.make({
              candidates: visibleCandidates.map(toProtocolCandidateReviewRow),
              page: {
                nextCursor:
                  hasMore && lastCandidate !== undefined ? candidateCursorFor(lastCandidate) : null,
                hasMore,
              },
            })
          })
        )
        .handle("getProtocolCandidate", ({ path, urlParams }) =>
          Effect.gen(function* () {
            const observationCursor = yield* decodeObservationCursor(urlParams.observationCursor)
            const detail = yield* protocolCandidateRepository
              .getReviewDetail({
                candidateId: path.candidateId,
                observationCursor,
                observationLimit: (urlParams.observationLimit ?? defaultObservationLimit) + 1,
              })
              .pipe(
                Effect.mapError(() => toInternalServerError("Failed to load protocol candidate."))
              )

            if (Option.isNone(detail)) {
              return yield* Effect.fail(
                new ProtocolCandidateNotFoundError({
                  message: "Protocol candidate not found.",
                })
              )
            }
            const observationLimit = urlParams.observationLimit ?? defaultObservationLimit
            const visibleObservations = detail.value.observations.slice(0, observationLimit)
            const lastObservation = visibleObservations.at(-1)
            const hasMoreObservations = detail.value.observations.length > observationLimit

            return ProtocolCandidateReviewDetailResponse.make({
              candidate: toProtocolCandidateReviewRow(detail.value.candidate),
              observations: visibleObservations.map(toProtocolCandidateObservationResponse),
              observationsPage: {
                nextCursor:
                  hasMoreObservations && lastObservation !== undefined
                    ? observationCursorFor(lastObservation)
                    : null,
                hasMore: hasMoreObservations,
              },
            })
          })
        )
        .handle("listTaxMaxiTransactionTypes", () =>
          Effect.gen(function* () {
            const transactionTypes = yield* protocolCandidateRepository
              .listTransactionTypes()
              .pipe(
                Effect.mapError(() =>
                  toInternalServerError("Failed to list TaxMaxi transaction types.")
                )
              )

            return TaxMaxiTransactionTypeListResponse.make({
              transactionTypes: transactionTypes.map(toTaxMaxiTransactionTypeResponse),
            })
          })
        )
    })
)
