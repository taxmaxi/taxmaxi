import { sql } from "drizzle-orm"
import { check, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { processingJobs } from "./ProcessingJobsTable.ts"

/** Durable prerequisite edges between processing jobs. */
export const processingJobDependencies = pgTable(
  "processing_job_dependencies",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    prerequisiteJobId: uuid("prerequisite_job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.prerequisiteJobId] }),
    index("idx_processing_job_dependencies_prerequisite").on(table.prerequisiteJobId),
    check(
      "processing_job_dependencies_not_self_referencing",
      sql`${table.jobId} <> ${table.prerequisiteJobId}`
    ),
  ]
)

export type ProcessingJobDependency = typeof processingJobDependencies.$inferSelect
export type ProcessingJobDependencyInsert = typeof processingJobDependencies.$inferInsert
