/**
 * Durable source replay work requested by principal asset override records.
 *
 * @module PrincipalAssetOverrideApplicationsTable
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { principalAssetOverrides } from "./PrincipalAssetOverridesTables.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"

/** One source replay selected by an accepted override history record. */
export const principalAssetOverrideApplications = pgTable(
  "principal_asset_override_applications",
  {
    overrideId: uuid("override_id")
      .notNull()
      .references(() => principalAssetOverrides.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    processingJobId: uuid("processing_job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.overrideId, table.sourceId] }),
    index("idx_principal_asset_override_applications_source").on(table.sourceId),
    index("idx_principal_asset_override_applications_job").on(table.processingJobId),
  ]
)

export type PrincipalAssetOverrideApplication =
  typeof principalAssetOverrideApplications.$inferSelect
