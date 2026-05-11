/**
 * LegalReferenceRepositoryLive - Database-backed implementation for legal reference reads.
 *
 * This layer translates ruleset, rule, and citation queries into deterministic
 * repository responses used by core legal services.
 *
 * @module LegalReferenceRepositoryLive
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  LegalReferenceRepository,
  LegalReferenceRepositoryError,
  type LegalReferenceRepositoryShape,
} from "@my/core/legal"
import { schema } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"

/**
 * Convert SQL-layer failures into legal-repository-specific typed errors.
 */
const wrapLegalSqlError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LegalReferenceRepositoryError, R> =>
    Effect.mapError(effect, (cause) => new LegalReferenceRepositoryError({ operation, cause }))

/**
 * Construct the live repository implementation using the shared Drizzle client.
 */
const make = Effect.gen(function* () {
  const db = yield* drizzle

  /**
   * Resolve active ruleset (or explicit version) for a jurisdiction.
   */
  const getRuleSet: LegalReferenceRepositoryShape["getRuleSet"] = ({ jurisdictionCode, version }) =>
    Effect.gen(function* () {
      if (version !== undefined) {
        const [ruleSet] = yield* db
          .select({
            id: schema.jurisdictionRuleSets.id,
            version: schema.jurisdictionRuleSets.version,
            name: schema.jurisdictionRuleSets.name,
          })
          .from(schema.jurisdictionRuleSets)
          .where(
            and(
              eq(schema.jurisdictionRuleSets.jurisdictionCode, jurisdictionCode),
              eq(schema.jurisdictionRuleSets.version, version)
            )
          )
          .limit(1)

        return ruleSet ?? null
      }

      const [activeRuleSet] = yield* db
        .select({
          id: schema.jurisdictionRuleSets.id,
          version: schema.jurisdictionRuleSets.version,
          name: schema.jurisdictionRuleSets.name,
        })
        .from(schema.jurisdictionRuleSets)
        .where(
          and(
            eq(schema.jurisdictionRuleSets.jurisdictionCode, jurisdictionCode),
            eq(schema.jurisdictionRuleSets.isActive, true)
          )
        )
        .orderBy(desc(schema.jurisdictionRuleSets.effectiveFrom))
        .limit(1)

      return activeRuleSet ?? null
    }).pipe(wrapLegalSqlError("getRuleSet"))

  /**
   * Resolve legal rules and clause citations mapped to a transaction type.
   */
  const getReferencesForTransactionTypeWithRuleSet: LegalReferenceRepositoryShape["getReferencesForTransactionTypeWithRuleSet"] =
    ({ transactionTypeKey, jurisdictionCode, ruleSetVersion }) =>
      Effect.gen(function* () {
        const ruleSet = yield* getRuleSet(
          ruleSetVersion === undefined
            ? { jurisdictionCode }
            : { jurisdictionCode, version: ruleSetVersion }
        )

        if (!ruleSet) {
          return {
            ruleSet: null,
            references: [],
          }
        }

        const ruleRows = yield* db
          .select({
            ruleId: schema.legalRules.id,
            ruleKey: schema.legalRules.ruleKey,
            title: schema.legalRules.title,
            description: schema.legalRules.description,
            scope: schema.legalRules.scope,
            outcomeCategory: schema.legalRules.outcomeCategory,
            machineReadable: schema.legalRules.machineReadable,
            relevance: schema.transactionTypeLegalRules.relevance,
          })
          .from(schema.transactionTypeLegalRules)
          .innerJoin(
            schema.legalRules,
            eq(schema.transactionTypeLegalRules.ruleId, schema.legalRules.id)
          )
          .innerJoin(
            schema.jurisdictionRuleSetRules,
            eq(schema.jurisdictionRuleSetRules.ruleId, schema.legalRules.id)
          )
          .where(
            and(
              eq(schema.transactionTypeLegalRules.transactionTypeKey, transactionTypeKey),
              eq(schema.legalRules.jurisdictionCode, jurisdictionCode),
              eq(schema.legalRules.isActive, true),
              eq(schema.jurisdictionRuleSetRules.ruleSetId, ruleSet.id)
            )
          )
          .orderBy(
            desc(schema.transactionTypeLegalRules.relevance),
            asc(schema.jurisdictionRuleSetRules.priority)
          )

        if (ruleRows.length === 0) {
          return {
            ruleSet,
            references: [],
          }
        }

        const ruleIds = ruleRows.map((row) => row.ruleId)

        const citationRows = yield* db
          .select({
            ruleId: schema.legalRuleCitations.ruleId,
            clauseKey: schema.legalClauses.clauseKey,
            sectionCode: schema.legalClauses.sectionCode,
            heading: schema.legalClauses.heading,
            randnummer: schema.legalClauses.randnummer,
            summary: schema.legalClauses.summary,
            clauseText: schema.legalClauses.clauseText,
            sourceKey: schema.legalSources.sourceKey,
            sourceTitle: schema.legalSources.title,
            sourceShortTitle: schema.legalSources.shortTitle,
            sourceType: schema.legalSources.sourceType,
            sourceAuthority: schema.legalSources.authority,
            sourcePublishedAt: schema.legalSources.publishedAt,
            sourceUrl: schema.legalSources.sourceUrl,
          })
          .from(schema.legalRuleCitations)
          .innerJoin(
            schema.legalClauses,
            eq(schema.legalRuleCitations.clauseId, schema.legalClauses.id)
          )
          .innerJoin(schema.legalSources, eq(schema.legalClauses.sourceId, schema.legalSources.id))
          .where(inArray(schema.legalRuleCitations.ruleId, ruleIds))
          .orderBy(asc(schema.legalRuleCitations.citationOrder))

        // Group citation rows by rule for deterministic assembly in output order.
        const citationsByRuleId = new Map<string, Array<(typeof citationRows)[number]>>()
        for (const citation of citationRows) {
          const existing = citationsByRuleId.get(citation.ruleId)
          if (existing) {
            existing.push(citation)
          } else {
            citationsByRuleId.set(citation.ruleId, [citation])
          }
        }

        return {
          ruleSet,
          references: ruleRows.map((rule) => ({
            ruleId: rule.ruleId,
            ruleKey: rule.ruleKey,
            title: rule.title,
            description: rule.description,
            scope: rule.scope,
            outcomeCategory: rule.outcomeCategory,
            machineReadable:
              typeof rule.machineReadable === "object" && rule.machineReadable !== null
                ? (rule.machineReadable as Record<string, unknown>)
                : {},
            relevance: Number(rule.relevance),
            citations: (citationsByRuleId.get(rule.ruleId) ?? []).map((citation) => ({
              clauseKey: citation.clauseKey,
              sectionCode: citation.sectionCode,
              heading: citation.heading,
              randnummer: citation.randnummer,
              summary: citation.summary,
              clauseText: citation.clauseText,
              source: {
                sourceKey: citation.sourceKey,
                title: citation.sourceTitle,
                shortTitle: citation.sourceShortTitle,
                sourceType: citation.sourceType,
                authority: citation.sourceAuthority,
                publishedAt: citation.sourcePublishedAt,
                sourceUrl: citation.sourceUrl,
              },
            })),
          })),
        }
      }).pipe(wrapLegalSqlError("getReferencesForTransactionTypeWithRuleSet"))

  /**
   * Resolve unique clause corpus for a ruleset (used for question-level ranking).
   */
  const getClauseCorpusForRuleSet: LegalReferenceRepositoryShape["getClauseCorpusForRuleSet"] = ({
    jurisdictionCode,
    ruleSetVersion,
  }) =>
    Effect.gen(function* () {
      const ruleSet = yield* getRuleSet(
        ruleSetVersion === undefined
          ? { jurisdictionCode }
          : { jurisdictionCode, version: ruleSetVersion }
      )

      if (!ruleSet) {
        return {
          ruleSet: null,
          clauses: [],
        }
      }

      const rows = yield* db
        .select({
          clauseKey: schema.legalClauses.clauseKey,
          sectionCode: schema.legalClauses.sectionCode,
          heading: schema.legalClauses.heading,
          randnummer: schema.legalClauses.randnummer,
          summary: schema.legalClauses.summary,
          clauseText: schema.legalClauses.clauseText,
          sourceKey: schema.legalSources.sourceKey,
          sourceTitle: schema.legalSources.title,
          sourceShortTitle: schema.legalSources.shortTitle,
          sourceType: schema.legalSources.sourceType,
          sourceAuthority: schema.legalSources.authority,
          sourcePublishedAt: schema.legalSources.publishedAt,
          sourceUrl: schema.legalSources.sourceUrl,
          citationOrder: schema.legalRuleCitations.citationOrder,
        })
        .from(schema.jurisdictionRuleSetRules)
        .innerJoin(
          schema.legalRules,
          eq(schema.jurisdictionRuleSetRules.ruleId, schema.legalRules.id)
        )
        .innerJoin(
          schema.legalRuleCitations,
          eq(schema.legalRuleCitations.ruleId, schema.legalRules.id)
        )
        .innerJoin(
          schema.legalClauses,
          eq(schema.legalRuleCitations.clauseId, schema.legalClauses.id)
        )
        .innerJoin(schema.legalSources, eq(schema.legalClauses.sourceId, schema.legalSources.id))
        .where(
          and(
            eq(schema.jurisdictionRuleSetRules.ruleSetId, ruleSet.id),
            eq(schema.legalRules.jurisdictionCode, jurisdictionCode),
            eq(schema.legalRules.isActive, true)
          )
        )
        .orderBy(asc(schema.legalClauses.clauseKey), asc(schema.legalRuleCitations.citationOrder))

      // Keep only the first row per clause key to avoid duplicate clauses.
      const uniqueClauses = new Map<string, (typeof rows)[number]>()
      for (const row of rows) {
        if (!uniqueClauses.has(row.clauseKey)) {
          uniqueClauses.set(row.clauseKey, row)
        }
      }

      return {
        ruleSet,
        clauses: Array.from(uniqueClauses.values()).map((clause) => ({
          clauseKey: clause.clauseKey,
          sectionCode: clause.sectionCode,
          heading: clause.heading,
          randnummer: clause.randnummer,
          summary: clause.summary,
          clauseText: clause.clauseText,
          source: {
            sourceKey: clause.sourceKey,
            title: clause.sourceTitle,
            shortTitle: clause.sourceShortTitle,
            sourceType: clause.sourceType,
            authority: clause.sourceAuthority,
            publishedAt: clause.sourcePublishedAt,
            sourceUrl: clause.sourceUrl,
          },
        })),
      }
    }).pipe(wrapLegalSqlError("getClauseCorpusForRuleSet"))

  return {
    getRuleSet,
    getReferencesForTransactionTypeWithRuleSet,
    getClauseCorpusForRuleSet,
  } satisfies LegalReferenceRepositoryShape
})

/**
 * LegalReferenceRepositoryLive - Production layer export.
 */
export const LegalReferenceRepositoryLive = Layer.effect(LegalReferenceRepository, make)
