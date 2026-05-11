/**
 * LegalReferenceApiLive - Live handlers for legal reference endpoints.
 *
 * Delegates legal retrieval to the core LegalReferenceService and maps results
 * into HTTP response schemas used by the REST API.
 *
 * @module LegalReferenceApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { LegalReferenceService, LegalReferenceServiceLive } from "@my/core/legal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  LegalCitationReferenceResponse,
  LegalCitationSource,
  LegalReferenceInternalError,
  LegalRuleReferenceResponse,
  QuestionLegalReferencesResponse,
  ScoredLegalClauseReferenceResponse,
  TransactionTypeLegalReferencesResponse,
} from "../definitions/LegalReferenceApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"

/** Default jurisdiction while DE is the active legal scope. */
const DEFAULT_JURISDICTION_CODE = "DE"

/**
 * Map internal service/repository failures to API-level 500 error.
 */
const mapInternalError = (operation: string) =>
  Effect.catchAll(() =>
    Effect.fail(
      new LegalReferenceInternalError({
        message: `Failed to resolve legal references (${operation}).`,
      })
    )
  )

/**
 * Map core citation shape into the REST response schema.
 */
const mapCitation = (citation: {
  clauseKey: string
  sectionCode: string | null
  heading: string | null
  randnummer: string
  summary: string | null
  clauseText: string
  source: {
    sourceKey: string
    title: string
    shortTitle: string | null
    sourceType: string
    authority: string
    sourceUrl: string | null
  }
}) =>
  LegalCitationReferenceResponse.make({
    clauseKey: citation.clauseKey,
    sectionCode: citation.sectionCode,
    heading: citation.heading,
    randnummer: citation.randnummer,
    summary: citation.summary,
    clauseText: citation.clauseText,
    source: LegalCitationSource.make({
      sourceKey: citation.source.sourceKey,
      title: citation.source.title,
      shortTitle: citation.source.shortTitle,
      sourceType: citation.source.sourceType,
      authority: citation.source.authority,
      sourceUrl: citation.source.sourceUrl,
    }),
  })

/**
 * LegalReferenceApiLive - Group implementation for legal reference endpoints.
 */
export const LegalReferenceApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "legalReferences",
  (handlers) =>
    Effect.gen(function* () {
      const legalReferenceService = yield* LegalReferenceService

      return handlers
        .handle("resolveTransactionTypeReferences", ({ payload }) => {
          // Default to DE when the caller does not specify jurisdiction.
          const jurisdictionCode = payload.jurisdictionCode ?? DEFAULT_JURISDICTION_CODE

          const params: {
            transactionTypeKey: string
            jurisdictionCode: string
            ruleSetVersion?: string
            maxReferences?: number
            maxCitationsPerReference?: number
          } = {
            transactionTypeKey: payload.transactionTypeKey,
            jurisdictionCode,
          }

          if (payload.ruleSetVersion !== undefined) {
            params.ruleSetVersion = payload.ruleSetVersion
          }

          if (payload.maxReferences !== undefined) {
            params.maxReferences = payload.maxReferences
          }

          if (payload.maxCitationsPerReference !== undefined) {
            params.maxCitationsPerReference = payload.maxCitationsPerReference
          }

          return legalReferenceService.getReferencesForTransactionTypeWithRuleSet(params).pipe(
            Effect.map((resolution) =>
              TransactionTypeLegalReferencesResponse.make({
                jurisdictionCode,
                ruleSetVersion: resolution.ruleSet?.version ?? null,
                ruleSetName: resolution.ruleSet?.name ?? null,
                references: resolution.references.map((reference) =>
                  LegalRuleReferenceResponse.make({
                    ruleId: reference.ruleId,
                    ruleKey: reference.ruleKey,
                    title: reference.title,
                    description: reference.description,
                    scope: reference.scope,
                    outcomeCategory: reference.outcomeCategory,
                    relevance: reference.relevance,
                    citations: reference.citations.map(mapCitation),
                  })
                ),
              })
            ),
            mapInternalError("transaction-type")
          )
        })
        .handle("resolveQuestionReferences", ({ payload }) => {
          // Default to DE when the caller does not specify jurisdiction.
          const jurisdictionCode = payload.jurisdictionCode ?? DEFAULT_JURISDICTION_CODE

          const params: {
            question: string
            jurisdictionCode: string
            ruleSetVersion?: string
            maxClauses?: number
          } = {
            question: payload.question,
            jurisdictionCode,
          }

          if (payload.ruleSetVersion !== undefined) {
            params.ruleSetVersion = payload.ruleSetVersion
          }

          if (payload.maxClauses !== undefined) {
            params.maxClauses = payload.maxClauses
          }

          return legalReferenceService.getRelevantClausesForQuestion(params).pipe(
            Effect.map((resolution) =>
              QuestionLegalReferencesResponse.make({
                jurisdictionCode,
                ruleSetVersion: resolution.ruleSet?.version ?? null,
                ruleSetName: resolution.ruleSet?.name ?? null,
                insufficiencyText: resolution.insufficiencyText,
                references: resolution.references.map((reference) =>
                  ScoredLegalClauseReferenceResponse.make({
                    clauseKey: reference.clauseKey,
                    sectionCode: reference.sectionCode,
                    heading: reference.heading,
                    randnummer: reference.randnummer,
                    summary: reference.summary,
                    clauseText: reference.clauseText,
                    score: reference.score,
                    source: LegalCitationSource.make({
                      sourceKey: reference.source.sourceKey,
                      title: reference.source.title,
                      shortTitle: reference.source.shortTitle,
                      sourceType: reference.source.sourceType,
                      authority: reference.source.authority,
                      sourceUrl: reference.source.sourceUrl,
                    }),
                  })
                ),
              })
            ),
            mapInternalError("question")
          )
        })
    })
).pipe(Layer.provide(LegalReferenceServiceLive))
