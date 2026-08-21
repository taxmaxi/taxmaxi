import { index, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { assetResolutionDecisions } from "./AssetResolutionDecisionsTable.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"

export const assetRematerializationStatusEnum = pgEnum("asset_rematerialization_status", [
  "pending",
  "running",
  "complete",
  "operator_attention",
])

/** Durable per-source rebuild work created by one accepted human decision. */
export const assetDecisionRematerializations = pgTable(
  "asset_decision_rematerializations",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => assetResolutionDecisions.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    processingJobId: uuid("processing_job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    status: assetRematerializationStatusEnum("status").notNull().default("pending"),
    failureCode: text("failure_code"),
    lastFailureAt: timestamp("last_failure_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.decisionId, table.sourceId] }),
    index("idx_asset_decision_rematerializations_source").on(table.sourceId),
    index("idx_asset_decision_rematerializations_status").on(table.status),
  ]
)

export type AssetDecisionRematerialization = typeof assetDecisionRematerializations.$inferSelect
