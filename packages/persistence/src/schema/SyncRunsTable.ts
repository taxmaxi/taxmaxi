import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"

export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "partially_failed",
])

/**
 * User-wide source sync orchestration run.
 *
 * A run is the aggregate user-visible parent for many source-level processing
 * jobs. Source jobs remain the execution unit and Postgres remains the status
 * source of truth.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    status: syncRunStatusEnum("status").notNull().default("queued"),
    requestedSourceCount: integer("requested_source_count").notNull().default(0),
    queuedSourceCount: integer("queued_source_count").notNull().default(0),
    runningSourceCount: integer("running_source_count").notNull().default(0),
    completedSourceCount: integer("completed_source_count").notNull().default(0),
    failedSourceCount: integer("failed_source_count").notNull().default(0),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    message: text("message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_sync_runs_principal_id").on(table.principalId),
    index("idx_sync_runs_status").on(table.status),
    index("idx_sync_runs_created_at").on(table.createdAt),
  ]
)

export type SyncRun = typeof syncRuns.$inferSelect
export type SyncRunInsert = typeof syncRuns.$inferInsert
