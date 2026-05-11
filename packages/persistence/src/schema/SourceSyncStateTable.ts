import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"

/**
 * Incremental sync state per source.
 *
 * Tracks provider cursors/checkpoints independently from processing jobs so
 * ingestion can resume for both onchain and offchain providers.
 */
export const sourceSyncState = pgTable(
  "source_sync_state",
  {
    sourceId: uuid("source_id") // One state row per source.
      .primaryKey()
      .references(() => sources.id, { onDelete: "cascade" }),

    cursorPayload: jsonb("cursor_payload"), // Provider pagination/cursor state.
    highWatermark: timestamp("high_watermark"), // Latest safely processed event timestamp.

    checkpointRawRecordId: uuid("checkpoint_raw_record_id").references(() => sourceRecordsRaw.id, {
      // Exact internal replay anchor (more reliable than provider cursors alone).
      onDelete: "set null",
    }),
    checkpointExternalId: text("checkpoint_external_id"), // Provider id at the current resume boundary.

    lastSyncedAt: timestamp("last_synced_at"), // Last successful sync completion.
    lastErrorMessage: text("last_error_message"), // Most recent sync failure reason.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_source_sync_state_last_synced").on(table.lastSyncedAt)]
)

export type SourceSyncState = typeof sourceSyncState.$inferSelect
export type SourceSyncStateInsert = typeof sourceSyncState.$inferInsert
