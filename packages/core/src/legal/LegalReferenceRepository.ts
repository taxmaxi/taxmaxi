/**
 * LegalReferenceRepository - Core contract for deterministic legal reference retrieval.
 *
 * This service defines how callers can resolve:
 * - the active or explicit jurisdiction ruleset
 * - transaction-type-specific legal rules with citations
 * - a clause corpus for question-level grounding and ranking
 *
 * The interface is implemented in persistence and consumed by core legal services.
 *
 * @module LegalReferenceRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * LegalRuleSet - Versioned legal ruleset metadata.
 */
export type LegalRuleSet = {
  id: string
  version: string
  name: string
}

/**
 * LegalCitationSource - Source-level metadata for a legal citation.
 */
export type LegalCitationSource = {
  sourceKey: string
  title: string
  shortTitle: string | null
  sourceType: string
  authority: string
  publishedAt: Date
  sourceUrl: string | null
}

/**
 * LegalCitationReference - A concrete, citable legal clause reference.
 */
export type LegalCitationReference = {
  clauseKey: string
  sectionCode: string | null
  heading: string | null
  randnummer: string
  summary: string | null
  clauseText: string
  source: LegalCitationSource
}

/**
 * TransactionTypeLegalReference - A deterministic legal rule mapped to a transaction type.
 */
export type TransactionTypeLegalReference = {
  ruleId: string
  ruleKey: string
  title: string
  description: string
  scope: string
  outcomeCategory: string
  machineReadable: Record<string, unknown>
  relevance: number
  citations: LegalCitationReference[]
}

/**
 * TransactionTypeLegalReferenceResolution - Transaction-type mapping result with ruleset context.
 */
export type TransactionTypeLegalReferenceResolution = {
  ruleSet: LegalRuleSet | null
  references: TransactionTypeLegalReference[]
}

/**
 * LegalClauseCorpusResolution - Clause corpus result with ruleset context.
 */
export type LegalClauseCorpusResolution = {
  ruleSet: LegalRuleSet | null
  clauses: LegalCitationReference[]
}

/**
 * LegalReferenceRepositoryError - Persistence failure while resolving legal references.
 */
export class LegalReferenceRepositoryError extends Schema.TaggedError<LegalReferenceRepositoryError>()(
  "LegalReferenceRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  }
) {
  override get message(): string {
    return `Legal reference repository error during ${this.operation}: ${String(this.cause)}`
  }
}

/**
 * LegalReferenceRepositoryShape - Repository interface for legal reference reads.
 */
export interface LegalReferenceRepositoryShape {
  /**
   * Resolve the active (or explicit) ruleset for a jurisdiction.
   */
  readonly getRuleSet: ({
    jurisdictionCode,
    version,
  }: {
    jurisdictionCode: string
    version?: string
  }) => Effect.Effect<LegalRuleSet | null, LegalReferenceRepositoryError>

  /**
   * Resolve legal rules and clause citations mapped to a transaction type.
   */
  readonly getReferencesForTransactionTypeWithRuleSet: ({
    transactionTypeKey,
    jurisdictionCode,
    ruleSetVersion,
  }: {
    transactionTypeKey: string
    jurisdictionCode: string
    ruleSetVersion?: string
  }) => Effect.Effect<TransactionTypeLegalReferenceResolution, LegalReferenceRepositoryError>

  /**
   * Resolve all citable clauses reachable from the selected ruleset.
   */
  readonly getClauseCorpusForRuleSet: ({
    jurisdictionCode,
    ruleSetVersion,
  }: {
    jurisdictionCode: string
    ruleSetVersion?: string
  }) => Effect.Effect<LegalClauseCorpusResolution, LegalReferenceRepositoryError>
}

/**
 * LegalReferenceRepository - Effect tag for legal reference repository access.
 */
export class LegalReferenceRepository extends Context.Tag("LegalReferenceRepository")<
  LegalReferenceRepository,
  LegalReferenceRepositoryShape
>() {}
