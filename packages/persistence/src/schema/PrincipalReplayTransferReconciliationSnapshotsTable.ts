import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { syncRuns } from "./SyncRunsTable.ts"
import { transferReconciliationStatusEnum } from "./TransferReconciliationsTable.ts"

/**
 * Reviewed transfer reconciliation decisions captured before principal replay.
 * Stable identities reconnect the decision to records rebuilt with new IDs.
 */
export const principalReplayTransferReconciliationSnapshots = pgTable(
  "principal_replay_transfer_reconciliation_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    providerSourceId: uuid("provider_source_id").notNull(),
    providerTransferIdentity: text("provider_transfer_identity").notNull(),
    canonicalTransferSourceId: uuid("canonical_transfer_source_id"),
    canonicalTransferIdentity: text("canonical_transfer_identity"),
    canonicalTransactionSourceId: uuid("canonical_transaction_source_id"),
    canonicalTransactionIdentity: text("canonical_transaction_identity"),
    status: transferReconciliationStatusEnum("status").notNull(),
    matchReason: text("match_reason").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    deterministic: boolean("deterministic").notNull(),
    reviewMetadata: jsonb("review_metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "principal_replay_transfer_reconciliation_snapshots_reviewed_status",
      sql`${table.status} in ('approved', 'rejected')`
    ),
    uniqueIndex("principal_replay_transfer_reconciliation_snapshots_run_identity_unique").on(
      table.runId,
      table.providerSourceId,
      table.providerTransferIdentity
    ),
    index("idx_principal_replay_transfer_reconciliation_snapshots_run_id").on(table.runId),
  ]
)

export type PrincipalReplayTransferReconciliationSnapshot =
  typeof principalReplayTransferReconciliationSnapshots.$inferSelect
export type PrincipalReplayTransferReconciliationSnapshotInsert =
  typeof principalReplayTransferReconciliationSnapshots.$inferInsert
