import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { reviewStatusEnum } from "./TransactionReviewTable.ts"
import { syncRuns } from "./SyncRunsTable.ts"

/**
 * Durable user review decisions captured before a principal replay removes
 * and rebuilds canonical transactions. Rows survive retries for the same run.
 */
export const principalReplayReviewSnapshots = pgTable(
  "principal_replay_review_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull(),
    transactionIdentity: text("transaction_identity").notNull(),
    reviewStatus: reviewStatusEnum("review_status").notNull(),
    originalTypeKey: text("original_type_key"),
    originalConfidence: numeric("original_confidence", { precision: 3, scale: 2 }),
    currentTypeKey: text("current_type_key"),
    legalRuleSetVersion: text("legal_rule_set_version"),
    categorizationReason: text("categorization_reason"),
    matchedLayer: text("matched_layer"),
    needsReview: boolean("needs_review").notNull(),
    userNotes: text("user_notes"),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principal_replay_review_snapshots_run_identity_unique").on(
      table.runId,
      table.sourceId,
      table.transactionIdentity
    ),
    index("idx_principal_replay_review_snapshots_run_id").on(table.runId),
  ]
)

export type PrincipalReplayReviewSnapshot = typeof principalReplayReviewSnapshots.$inferSelect
export type PrincipalReplayReviewSnapshotInsert = typeof principalReplayReviewSnapshots.$inferInsert
