import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { blockchains } from "./BlockchainsTable.ts"
import { protocolCandidates } from "./ProtocolCandidatesTable.ts"
import {
  providerInventoryEffectEnum,
  providerMappingStatusEnum,
  providerTaxTreatmentEnum,
} from "./ProviderTransactionTypeMappingsTable.ts"
import { transactionTypes } from "./TransactionTypesTable.ts"

export const protocolMovementPatternEnum = pgEnum("protocol_movement_pattern", [
  "token_out_and_token_in",
])

export type ProtocolMovementPattern = (typeof protocolMovementPatternEnum.enumValues)[number]

/**
 * Reviewed protocol subject mappings that may classify onchain activity when approved.
 */
export const protocolTransactionTypeMappings = pgTable(
  "protocol_transaction_type_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id").references(() => protocolCandidates.id, {
      onDelete: "set null",
    }),
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    subjectIdentifier: text("subject_identifier").notNull(),
    protocolName: text("protocol_name").notNull(),
    movementPattern: protocolMovementPatternEnum("movement_pattern").notNull(),
    transactionTypeKey: text("transaction_type_key").references(() => transactionTypes.typeKey),
    inventoryEffect: providerInventoryEffectEnum("inventory_effect").notNull(),
    taxTreatment: providerTaxTreatmentEnum("tax_treatment").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    mappingStatus: providerMappingStatusEnum("mapping_status").notNull().default("pending_review"),
    version: integer("version").notNull(),
    reviewerNotes: text("reviewer_notes"),
    sourceNotes: text("source_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("protocol_transaction_type_mappings_subject_pattern_version_unique").on(
      table.blockchainId,
      table.subjectIdentifier,
      table.movementPattern,
      table.version
    ),
    index("idx_protocol_transaction_type_mappings_blockchain_subject").on(
      table.blockchainId,
      table.subjectIdentifier
    ),
    index("idx_protocol_transaction_type_mappings_mapping_status").on(table.mappingStatus),
    check(
      "protocol_transaction_type_mappings_approved_requires_type_key",
      sql`${table.mappingStatus} in ('pending_review', 'rejected') or ${table.transactionTypeKey} is not null`
    ),
    check(
      "protocol_transaction_type_mappings_confidence_range",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`
    ),
  ]
)

export type ProtocolTransactionTypeMappingRow = typeof protocolTransactionTypeMappings.$inferSelect
export type ProtocolTransactionTypeMappingInsert =
  typeof protocolTransactionTypeMappings.$inferInsert
