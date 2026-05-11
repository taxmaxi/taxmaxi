import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { transactionTypes } from "./TransactionTypesTable.ts"

/**
 * Canonical legal sources (e.g., BMF letters, statutes, court rulings).
 *
 * Keep these records immutable by version; create new rows for legal updates
 * so historical tax calculations can be replayed against the exact source set.
 */
export const legalSources = pgTable(
  "legal_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKey: text("source_key").notNull(),
    jurisdictionCode: text("jurisdiction_code").notNull(),
    sourceType: text("source_type").notNull(),
    authority: text("authority").notNull(),
    title: text("title").notNull(),
    shortTitle: text("short_title"),
    language: text("language").notNull().default("de"),
    sourceUrl: text("source_url"),
    publishedAt: timestamp("published_at").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    checksumSha256: text("checksum_sha256"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("legal_sources_source_key_unique").on(table.sourceKey),
    index("idx_legal_sources_jurisdiction").on(table.jurisdictionCode),
    index("idx_legal_sources_effective_from").on(table.effectiveFrom),
  ]
)

/**
 * Atomic clauses for retrieval and citation.
 *
 * For BMF documents this is typically keyed by Randnummer (RN).
 */
export const legalClauses = pgTable(
  "legal_clauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => legalSources.id, { onDelete: "cascade" }),
    clauseKey: text("clause_key").notNull(),
    sectionCode: text("section_code"),
    heading: text("heading"),
    randnummer: text("randnummer").notNull(),
    clauseText: text("clause_text").notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("legal_clauses_clause_key_unique").on(table.clauseKey),
    unique("legal_clauses_source_randnummer_unique").on(table.sourceId, table.randnummer),
    index("idx_legal_clauses_source").on(table.sourceId),
    index("idx_legal_clauses_randnummer").on(table.randnummer),
  ]
)

/**
 * Jurisdiction-specific deterministic rules built from legal clauses.
 */
export const legalRules = pgTable(
  "legal_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleKey: text("rule_key").notNull(),
    jurisdictionCode: text("jurisdiction_code").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    scope: text("scope").notNull(),
    outcomeCategory: text("outcome_category").notNull(),
    machineReadable: jsonb("machine_readable").$type<Record<string, unknown>>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("legal_rules_rule_key_unique").on(table.ruleKey),
    index("idx_legal_rules_jurisdiction").on(table.jurisdictionCode),
    index("idx_legal_rules_active").on(table.isActive),
  ]
)

/**
 * Many-to-many mapping from deterministic rules to exact legal clauses.
 */
export const legalRuleCitations = pgTable(
  "legal_rule_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => legalRules.id, { onDelete: "cascade" }),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => legalClauses.id, { onDelete: "cascade" }),
    citationOrder: integer("citation_order").notNull().default(0),
    quote: text("quote"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("legal_rule_citations_rule_clause_unique").on(table.ruleId, table.clauseId),
    index("idx_legal_rule_citations_rule_order").on(table.ruleId, table.citationOrder),
    index("idx_legal_rule_citations_clause").on(table.clauseId),
  ]
)

/**
 * Versioned jurisdiction rule sets so historical calculations are replayable.
 */
export const jurisdictionRuleSets = pgTable(
  "jurisdiction_rule_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jurisdictionCode: text("jurisdiction_code").notNull(),
    version: text("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("jurisdiction_rule_sets_jurisdiction_version_unique").on(
      table.jurisdictionCode,
      table.version
    ),
    index("idx_jurisdiction_rule_sets_jurisdiction").on(table.jurisdictionCode),
    index("idx_jurisdiction_rule_sets_active").on(table.isActive),
  ]
)

/**
 * Membership table connecting a rule set version with concrete rules.
 */
export const jurisdictionRuleSetRules = pgTable(
  "jurisdiction_rule_set_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => jurisdictionRuleSets.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => legalRules.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("jurisdiction_rule_set_rules_unique").on(table.ruleSetId, table.ruleId),
    index("idx_jurisdiction_rule_set_rules_set").on(table.ruleSetId, table.priority),
    index("idx_jurisdiction_rule_set_rules_rule").on(table.ruleId),
  ]
)

/**
 * Maps product transaction types to deterministic legal rules.
 *
 * This mapping powers both explainability and rule-based tax handling.
 */
export const transactionTypeLegalRules = pgTable(
  "transaction_type_legal_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionTypeKey: text("transaction_type_key")
      .notNull()
      .references(() => transactionTypes.typeKey, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => legalRules.id, { onDelete: "cascade" }),
    relevance: numeric("relevance", { precision: 3, scale: 2 }).notNull().default("1.00"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("transaction_type_legal_rules_unique").on(table.transactionTypeKey, table.ruleId),
    index("idx_transaction_type_legal_rules_type").on(table.transactionTypeKey),
    index("idx_transaction_type_legal_rules_rule").on(table.ruleId),
  ]
)

export type LegalSource = typeof legalSources.$inferSelect
export type LegalSourceInsert = typeof legalSources.$inferInsert
export type LegalClause = typeof legalClauses.$inferSelect
export type LegalClauseInsert = typeof legalClauses.$inferInsert
export type LegalRule = typeof legalRules.$inferSelect
export type LegalRuleInsert = typeof legalRules.$inferInsert
export type LegalRuleCitation = typeof legalRuleCitations.$inferSelect
export type LegalRuleCitationInsert = typeof legalRuleCitations.$inferInsert
export type JurisdictionRuleSet = typeof jurisdictionRuleSets.$inferSelect
export type JurisdictionRuleSetInsert = typeof jurisdictionRuleSets.$inferInsert
export type JurisdictionRuleSetRule = typeof jurisdictionRuleSetRules.$inferSelect
export type JurisdictionRuleSetRuleInsert = typeof jurisdictionRuleSetRules.$inferInsert
export type TransactionTypeLegalRule = typeof transactionTypeLegalRules.$inferSelect
export type TransactionTypeLegalRuleInsert = typeof transactionTypeLegalRules.$inferInsert
