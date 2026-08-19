import { sql } from "drizzle-orm"
import { check, index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { jobStatusEnum } from "./ProcessingJobsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

/**
 * One durable background resolution job per provider observation and evidence revision.
 *
 * Identity is global: it is not keyed by user, source, or transaction.
 */
export const assetResolutionJobs = pgTable(
  "asset_resolution_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    evidenceRevision: integer("evidence_revision").notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_resolution_jobs_observation_revision_unique").on(
      table.providerAssetRowId,
      table.evidenceRevision
    ),
    index("idx_asset_resolution_jobs_status").on(table.status),
    check("asset_resolution_jobs_evidence_revision_positive", sql`${table.evidenceRevision} > 0`),
  ]
)

export type AssetResolutionJob = typeof assetResolutionJobs.$inferSelect
export type AssetResolutionJobInsert = typeof assetResolutionJobs.$inferInsert
