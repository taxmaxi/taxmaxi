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
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
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

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const toDateTimeUtc = (date: Date): DateTime.Utc => DateTime.unsafeMake(date)

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
            const candidates = yield* protocolCandidateRepository
              .listPendingReviewCandidates({
                limit: urlParams.limit ?? defaultLimit,
              })
              .pipe(
                Effect.mapError(() => toInternalServerError("Failed to list protocol candidates."))
              )

            return ProtocolCandidateReviewListResponse.make({
              candidates: candidates.map(toProtocolCandidateReviewRow),
            })
          })
        )
        .handle("getProtocolCandidate", ({ path }) =>
          Effect.gen(function* () {
            const detail = yield* protocolCandidateRepository
              .getReviewDetail({ candidateId: path.candidateId })
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

            return ProtocolCandidateReviewDetailResponse.make({
              candidate: toProtocolCandidateReviewRow(detail.value.candidate),
              observations: detail.value.observations.map(toProtocolCandidateObservationResponse),
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
