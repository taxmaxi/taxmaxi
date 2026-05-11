import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { sources } from "./SourcesTable.ts"

/**
 * Raw provider transaction/event payload cache.
 *
 * Stores provider-native responses (Coinbase, Etherscan, Bitcoin, Hyperliquid, ...)
 * so normalization can be replayed without re-fetching remote APIs.
 */
export const sourceRecordsRaw = pgTable(
  "source_records_raw",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sourceId: uuid("source_id") // Parent source that produced this raw provider record.
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),

    provider: text("provider").notNull(), // Origin system: coinbase, etherscan, bitcoin-rpc, etc.
    recordType: text("record_type").notNull(), // Provider-native family: transaction, fill, transfer, log, etc.

    externalAccountId: text("external_account_id"), // Provider account/subaccount context.
    externalRecordId: text("external_record_id").notNull(), // Provider idempotency key.
    externalParentId: text("external_parent_id"), // Parent link for child records (e.g. fill -> order).

    occurredAt: timestamp("occurred_at").notNull(), // Provider event time used for deterministic ordering.
    payload: jsonb("payload").notNull(), // Full original provider payload for replay/audit.

    importedAt: timestamp("imported_at").notNull().defaultNow(),
    normalizedAt: timestamp("normalized_at"), // Set once canonical transaction/leg writes succeed.
    normalizationError: text("normalization_error"), // Last normalization failure message.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_records_raw_source_external_unique").on(
      table.sourceId,
      table.recordType,
      table.externalRecordId
    ),
    index("idx_source_records_raw_source_occurred").on(table.sourceId, table.occurredAt),
    index("idx_source_records_raw_source_normalized").on(table.sourceId, table.normalizedAt),
  ]
)

export type SourceRecordRaw = typeof sourceRecordsRaw.$inferSelect
export type SourceRecordRawInsert = typeof sourceRecordsRaw.$inferInsert
