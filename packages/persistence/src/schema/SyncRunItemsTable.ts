import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"
import { syncRuns } from "./SyncRunsTable.ts"

export const syncRunItemStatusEnum = pgEnum("sync_run_item_status", [
  "queued",
  "running",
  "completed",
  "failed",
])

/**
 * Link between a user-wide sync run and one source-level processing attempt.
 */
export const syncRunItems = pgTable(
  "sync_run_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    processingJobId: uuid("processing_job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    status: syncRunItemStatusEnum("status").notNull().default("queued"),
    message: text("message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_sync_run_items_run_id").on(table.runId),
    index("idx_sync_run_items_source_id").on(table.sourceId),
    index("idx_sync_run_items_processing_job_id").on(table.processingJobId),
    uniqueIndex("sync_run_items_run_source_unique").on(table.runId, table.sourceId),
  ]
)

export type SyncRunItem = typeof syncRunItems.$inferSelect
export type SyncRunItemInsert = typeof syncRunItems.$inferInsert
