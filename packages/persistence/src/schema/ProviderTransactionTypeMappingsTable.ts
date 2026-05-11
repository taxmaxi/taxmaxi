import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { transactionTypes } from "./TransactionTypesTable.ts"

export const providerMappingStatusEnum = pgEnum("provider_mapping_status", [
  "approved",
  "pending_review",
  "rejected",
])

export type ProviderMappingStatus = (typeof providerMappingStatusEnum.enumValues)[number]

export const providerInventoryEffectEnum = pgEnum("provider_inventory_effect", [
  "acquisition",
  "disposal",
  "income",
  "internal_transfer",
  "non_inventory",
  "unknown",
])

export type ProviderInventoryEffect = (typeof providerInventoryEffectEnum.enumValues)[number]

export const providerTaxTreatmentEnum = pgEnum("provider_tax_treatment", [
  "taxable_by_default",
  "non_taxable_by_default",
  "requires_additional_rule_logic",
])

export type ProviderTaxTreatment = (typeof providerTaxTreatmentEnum.enumValues)[number]

export const providerResolutionStrategyEnum = pgEnum("provider_resolution_strategy", [
  "static",
  "amount_sign",
  "venue_side",
  "amount_sign_fee",
  "no_leg",
])

export type ProviderResolutionStrategy = (typeof providerResolutionStrategyEnum.enumValues)[number]

/**
 * Provider transaction type -> canonical transaction mapping.
 */
export const providerTransactionTypeMappings = pgTable(
  "provider_transaction_type_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerTransactionType: text("provider_transaction_type").notNull(),
    transactionTypeKey: text("transaction_type_key").references(() => transactionTypes.typeKey),
    inventoryEffect: providerInventoryEffectEnum("inventory_effect").notNull(),
    taxTreatment: providerTaxTreatmentEnum("tax_treatment").notNull(),
    resolutionStrategy: providerResolutionStrategyEnum("resolution_strategy").notNull(),
    pairedRecordRequired: boolean("paired_record_required").notNull().default(false),
    mappingStatus: providerMappingStatusEnum("mapping_status").notNull().default("pending_review"),
    reviewerNotes: text("reviewer_notes"),
    sourceNotes: text("source_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_transaction_type_mappings_provider_type_unique").on(
      table.provider,
      table.providerTransactionType
    ),
    index("idx_provider_transaction_type_mappings_provider").on(table.provider),
    check(
      "provider_transaction_type_mappings_pending_review_allows_null_key",
      sql`${table.mappingStatus} in ('pending_review', 'rejected') or ${table.transactionTypeKey} is not null`
    ),
  ]
)

export type ProviderTransactionTypeMappingRow = typeof providerTransactionTypeMappings.$inferSelect
export type ProviderTransactionTypeMappingInsert =
  typeof providerTransactionTypeMappings.$inferInsert
