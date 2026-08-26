import { boolean, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { principalAssetOverrides } from "./PrincipalAssetOverridesTable.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"

/** The source job that applies one accepted principal asset override. */
export const principalAssetOverrideApplications = pgTable(
  "principal_asset_override_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    overrideId: uuid("override_id")
      .notNull()
      .references(() => principalAssetOverrides.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    replayJobId: uuid("replay_job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    dependsOnSourceIds: uuid("depends_on_source_ids").array().notNull().default([]),
    requiresReplay: boolean("requires_replay").notNull().default(true),
    supersededAt: timestamp("superseded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principal_asset_override_applications_override_source_unique").on(
      table.overrideId,
      table.sourceId
    ),
    index("idx_principal_asset_override_applications_source_active").on(
      table.sourceId,
      table.supersededAt
    ),
    index("idx_principal_asset_override_applications_replay_job").on(table.replayJobId),
  ]
)

/** One source-specific application link for an accepted override history entry. */
export type PrincipalAssetOverrideApplicationRow =
  typeof principalAssetOverrideApplications.$inferSelect
/**
 * PrincipalAssetOverrideApplicationsTable - Causal replay links for asset overrides.
 *
 * @module PrincipalAssetOverrideApplicationsTable
 */
