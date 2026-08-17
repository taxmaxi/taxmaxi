/**
 * ProviderAssetReviewReplaysTable - Durable links from asset decisions to replay jobs.
 *
 * @module ProviderAssetReviewReplaysTable
 */

import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sources } from "./SourcesTable.ts"

/** The latest replay job requested for one reviewed provider asset and source. */
export const providerAssetReviewReplays = pgTable(
  "provider_asset_review_replays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_asset_review_replays_asset_source_unique").on(
      table.providerAssetRowId,
      table.sourceId
    ),
    index("idx_provider_asset_review_replays_job").on(table.jobId),
  ]
)

export type ProviderAssetReviewReplay = typeof providerAssetReviewReplays.$inferSelect
export type ProviderAssetReviewReplayInsert = typeof providerAssetReviewReplays.$inferInsert
