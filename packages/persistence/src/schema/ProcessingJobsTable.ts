import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { sources } from "./SourcesTable.ts"
import { users } from "./UsersTable.ts"

export const jobModeEnum = pgEnum("job_mode", ["sync", "replay"])
export const jobStatusEnum = pgEnum("job_status", ["pending", "processing", "completed", "failed"])

/**
 * Per-run processing status and resume metadata.
 *
 * Jobs track operational progress while `source_sync_state` tracks durable
 * source-level cursor state across runs.
 */
export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, {
        onDelete: "cascade",
      }),
    userId: uuid("user_id").references(() => users.id),
    mode: jobModeEnum("mode").notNull().default("sync"),
    status: jobStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    queuedAt: timestamp("queued_at"),
    startedAt: timestamp("started_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    completedAt: timestamp("completed_at"),
    nextRetryAt: timestamp("next_retry_at"),
    errorMessage: text("error_message"),
    progressDetails: jsonb("progress_details"), // Optional run metrics/stage counters for UI and debugging.
    queueName: text("queue_name"),
    queueJobId: text("queue_job_id"),
    workerId: text("worker_id"),
    checkpointExternalId: text("checkpoint_external_id"), // Lightweight provider-facing resume anchor.
    checkpointPayload: jsonb("checkpoint_payload"), // Opaque provider-specific checkpoint/cursor blob.
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_processing_jobs_source_id").on(table.sourceId),
    index("idx_processing_jobs_user_id").on(table.userId),
    index("idx_processing_jobs_status").on(table.status),
    index("idx_processing_jobs_queue_job").on(table.queueName, table.queueJobId),
    index("idx_processing_jobs_heartbeat_at").on(table.heartbeatAt),
    uniqueIndex("processing_jobs_active_source_unique")
      .on(table.sourceId)
      .where(sql`${table.status} in ('pending', 'processing')`),
    uniqueIndex("processing_jobs_queue_job_unique")
      .on(table.queueName, table.queueJobId)
      .where(sql`${table.queueName} is not null and ${table.queueJobId} is not null`),
    check("processing_jobs_attempt_count_non_negative", sql`${table.attemptCount} >= 0`),
    check("processing_jobs_max_attempts_positive", sql`${table.maxAttempts} > 0`),
  ]
)

export type ProcessingJob = typeof processingJobs.$inferSelect
export type ProcessingJobInsert = typeof processingJobs.$inferInsert
