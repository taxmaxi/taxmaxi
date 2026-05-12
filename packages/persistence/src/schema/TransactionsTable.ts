import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactionTypes } from "./TransactionTypesTable.ts"
import { principals } from "./PrincipalsTable.ts"

/**
 * Canonical source-agnostic transaction envelope.
 *
 * This table stores shared transaction identity and provider metadata.
 * Source-specific details live in companion context tables.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sourceId: uuid("source_id") // Owning source for ingestion lineage and permissions.
      .notNull()
      .references(() => sources.id, {
        onDelete: "cascade",
      }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      // Raw payload link for deterministic replay/debug.
      onDelete: "set null",
    }),
    externalId: text("external_id"), // Provider transaction id (idempotent within a source).
    externalGroupId: text("external_group_id"), // Groups related rows (e.g. order id, batch id).

    timestamp: timestamp("timestamp").notNull(),
    transactionType: varchar("transaction_type"),

    providerTransactionType: text("provider_transaction_type"), // Raw provider type: send, buy, advanced_trade_fill, etc.
    providerStatus: text("provider_status"), // Raw provider status: completed, pending, failed, etc.
    providerResourcePath: text("provider_resource_path"), // Provider API resource path for audit/debug.
    providerDescription: text("provider_description"), // Human-readable provider description/title.
    providerCreatedAt: timestamp("provider_created_at"), // Provider creation timestamp.
    providerUpdatedAt: timestamp("provider_updated_at"), // Provider last update timestamp.

    metadata: jsonb("metadata"), // Provider-specific data that does not fit canonical columns.

    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "transactions_identifier_present",
      sql`${table.externalId} is not null or ${table.sourceRawRecordId} is not null`
    ),

    foreignKey({
      columns: [table.transactionType],
      foreignColumns: [transactionTypes.typeKey],
      name: "transactions_transaction_type_fk",
    }),

    uniqueIndex("transactions_source_external_id_unique_idx")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),

    index("idx_transactions_source_timestamp").on(table.sourceId, table.timestamp),
    index("idx_transactions_principal_timestamp").on(table.principalId, table.timestamp),
    index("idx_transactions_external_group").on(table.sourceId, table.externalGroupId),
    index("idx_transactions_source_provider_type").on(
      table.sourceId,
      table.providerTransactionType
    ),
    index("idx_transactions_source_provider_status").on(table.sourceId, table.providerStatus),
  ]
)

export type Transaction = typeof transactions.$inferSelect
export type TransactionInsert = typeof transactions.$inferInsert
