/**
 * LegalReferenceService - Core legal retrieval and grounding orchestration.
 *
 * This service sits on top of LegalReferenceRepository and provides:
 * - bounded list shaping for transaction-type references
 * - deterministic clause ranking for free-form legal questions
 * - a standardized insufficiency guardrail message for AI usage
 *
 * @module LegalReferenceService
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  LegalReferenceRepository,
  type LegalCitationReference,
  type LegalReferenceRepositoryError,
  type LegalRuleSet,
  type TransactionTypeLegalReferenceResolution,
} from "./LegalReferenceRepository.ts"

/**
 * Standard insufficiency response used when configured legal references are missing.
 */
export const INSUFFICIENT_CITED_BASIS_TEXT = "Insufficient cited basis in configured legal ruleset."

/**
 * ScoredLegalClauseReference - Legal clause enriched with deterministic relevance score.
 */
export type ScoredLegalClauseReference = LegalCitationReference & {
  score: number
}

/**
 * QuestionLegalReferenceResolution - Question lookup result with ranked references.
 */
export type QuestionLegalReferenceResolution = {
  ruleSet: LegalRuleSet | null
  references: ScoredLegalClauseReference[]
  insufficiencyText: string | null
}

/**
 * LegalReferenceServiceShape - Public service API for legal grounding flows.
 */
export interface LegalReferenceServiceShape {
  /**
   * Resolve active or explicit ruleset metadata.
   */
  readonly getRuleSet: ({
    jurisdictionCode,
    version,
  }: {
    jurisdictionCode: string
    version?: string
  }) => Effect.Effect<LegalRuleSet | null, LegalReferenceRepositoryError>

  /**
   * Resolve transaction-type legal rules and citations with bounded output sizes.
   */
  readonly getReferencesForTransactionTypeWithRuleSet: ({
    transactionTypeKey,
    jurisdictionCode,
    ruleSetVersion,
    maxReferences,
    maxCitationsPerReference,
  }: {
    transactionTypeKey: string
    jurisdictionCode: string
    ruleSetVersion?: string
    maxReferences?: number
    maxCitationsPerReference?: number
  }) => Effect.Effect<TransactionTypeLegalReferenceResolution, LegalReferenceRepositoryError>

  /**
   * Resolve and rank ruleset clauses for a free-form legal question.
   */
  readonly getRelevantClausesForQuestion: ({
    question,
    jurisdictionCode,
    ruleSetVersion,
    maxClauses,
  }: {
    question: string
    jurisdictionCode: string
    ruleSetVersion?: string
    maxClauses?: number
  }) => Effect.Effect<QuestionLegalReferenceResolution, LegalReferenceRepositoryError>
}

/**
 * LegalReferenceService - Effect tag for legal retrieval and ranking.
 */
export class LegalReferenceService extends Context.Tag("LegalReferenceService")<
  LegalReferenceService,
  LegalReferenceServiceShape
>() {}

/**
 * Internal type used during ranking to keep stable tie-break order.
 */
type ScoredClause = {
  clause: LegalCitationReference
  index: number
  score: number
}

/**
 * Collapse repeated whitespace and trim textual fragments before scoring.
 */
function normalizeWhitespace(input: string): string {
  return input
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Tokenize user input for simple lexical matching.
 */
function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
}

/**
 * Count exact token matches in a tokenized text fragment.
 */
function countTokenMatches(tokens: ReadonlyArray<string>, token: string): number {
  if (!token) {
    return 0
  }

  return tokens.reduce((count, currentToken) => {
    return currentToken === token ? count + 1 : count
  }, 0)
}

/**
 * Clamp optional integer parameters to deterministic min/max boundaries.
 */
function clampInt({
  max,
  min,
  value,
}: {
  value: number | undefined
  min: number
  max: number
}): number {
  if (value === undefined || Number.isNaN(value)) {
    return max
  }

  const integer = Math.trunc(value)
  return Math.min(max, Math.max(min, integer))
}

/**
 * Deterministically rank clauses against a question.
 *
 * Scoring combines token frequency across clause content and heading emphasis,
 * with a bonus for exact phrase inclusion. Ties are resolved by original corpus
 * order for stable outputs across identical inputs.
 */
function rankClausesByQuestion({
  clauses,
  question,
}: {
  clauses: LegalCitationReference[]
  question: string
}): ScoredClause[] {
  const questionTokens = tokenize(question)
  const loweredQuestion = question.toLowerCase().trim()

  return clauses
    .map((clause, index) => {
      const searchable = normalizeWhitespace(
        [clause.heading ?? "", clause.summary ?? "", clause.clauseText].join("\n")
      ).toLowerCase()
      const searchableTokens = tokenize(searchable)
      const headingTokens = tokenize(clause.heading ?? "")

      const keywordScore = questionTokens.reduce((sum, token) => {
        return sum + countTokenMatches(searchableTokens, token)
      }, 0)

      const headingScore = questionTokens.reduce((sum, token) => {
        return sum + countTokenMatches(headingTokens, token) * 2
      }, 0)

      const exactPhraseScore =
        loweredQuestion.length > 10 && searchable.includes(loweredQuestion) ? 8 : 0

      return {
        clause,
        index,
        score: keywordScore + headingScore + exactPhraseScore,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return left.index - right.index
    })
}

/**
 * Build live service implementation backed by LegalReferenceRepository.
 */
const make = Effect.gen(function* () {
  const repository = yield* LegalReferenceRepository

  const getRuleSet: LegalReferenceServiceShape["getRuleSet"] = ({ jurisdictionCode, version }) => {
    if (version === undefined) {
      return repository.getRuleSet({ jurisdictionCode })
    }

    return repository.getRuleSet({ jurisdictionCode, version })
  }

  const getReferencesForTransactionTypeWithRuleSet: LegalReferenceServiceShape["getReferencesForTransactionTypeWithRuleSet"] =
    ({
      transactionTypeKey,
      jurisdictionCode,
      ruleSetVersion,
      maxReferences,
      maxCitationsPerReference,
    }) =>
      repository
        .getReferencesForTransactionTypeWithRuleSet(
          ruleSetVersion === undefined
            ? {
                transactionTypeKey,
                jurisdictionCode,
              }
            : {
                transactionTypeKey,
                jurisdictionCode,
                ruleSetVersion,
              }
        )
        .pipe(
          Effect.map((resolution) => {
            const maxRules = clampInt({
              value: maxReferences,
              min: 1,
              max: 20,
            })
            const maxCitations = clampInt({
              value: maxCitationsPerReference,
              min: 1,
              max: 20,
            })

            return {
              ruleSet: resolution.ruleSet,
              references: resolution.references.slice(0, maxRules).map((reference) => ({
                ...reference,
                citations: reference.citations.slice(0, maxCitations),
              })),
            }
          })
        )

  const getRelevantClausesForQuestion: LegalReferenceServiceShape["getRelevantClausesForQuestion"] =
    ({ question, jurisdictionCode, ruleSetVersion, maxClauses }) =>
      Effect.gen(function* () {
        const trimmedQuestion = question.trim()
        const maxClauseCount = clampInt({ value: maxClauses, min: 1, max: 20 })

        const clauseCorpus = yield* repository.getClauseCorpusForRuleSet(
          ruleSetVersion === undefined
            ? {
                jurisdictionCode,
              }
            : {
                jurisdictionCode,
                ruleSetVersion,
              }
        )

        if (!trimmedQuestion || clauseCorpus.clauses.length === 0) {
          return {
            ruleSet: clauseCorpus.ruleSet,
            references: [],
            insufficiencyText: INSUFFICIENT_CITED_BASIS_TEXT,
          } satisfies QuestionLegalReferenceResolution
        }

        const rankedClauses = rankClausesByQuestion({
          clauses: clauseCorpus.clauses,
          question: trimmedQuestion,
        })
          .filter((item) => item.score > 0)
          .slice(0, maxClauseCount)
          .map((item) => ({
            ...item.clause,
            score: item.score,
          }))

        return {
          ruleSet: clauseCorpus.ruleSet,
          references: rankedClauses,
          insufficiencyText: rankedClauses.length > 0 ? null : INSUFFICIENT_CITED_BASIS_TEXT,
        } satisfies QuestionLegalReferenceResolution
      })

  return {
    getRuleSet,
    getReferencesForTransactionTypeWithRuleSet,
    getRelevantClausesForQuestion,
  } satisfies LegalReferenceServiceShape
})

/**
 * LegalReferenceServiceLive - Production layer for legal reference service.
 */
export const LegalReferenceServiceLive = Layer.effect(LegalReferenceService, make)
