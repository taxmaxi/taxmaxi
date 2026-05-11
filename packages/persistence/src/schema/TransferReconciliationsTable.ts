import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { providerTransfers } from "./ProviderTransfersTable.ts"
import { transfers } from "./TransfersTable.ts"
import { transactions } from "./TransactionsTable.ts"
import { users } from "./UsersTable.ts"

export const transferReconciliationStatusEnum = pgEnum("transfer_reconciliation_status", [
  "pending",
  "needs_review",
  "approved",
  "rejected",
  "auto_applied",
])

export type TransferReconciliationStatus =
  (typeof transferReconciliationStatusEnum.enumValues)[number]

/**
 * Durable reconciliation state between provider-side principal movements and
 * canonical onchain receipts across the same user.
 */
export const transferReconciliations = pgTable(
  "transfer_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerTransferId: uuid("provider_transfer_id")
      .notNull()
      .references(() => providerTransfers.id, { onDelete: "cascade" }),
    canonicalTransferId: uuid("canonical_transfer_id").references(() => transfers.id, {
      onDelete: "cascade",
    }),
    canonicalTransactionId: uuid("canonical_transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),

    status: transferReconciliationStatusEnum("status").notNull().default("pending"),
    matchReason: text("match_reason").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("0"),
    deterministic: boolean("deterministic").notNull().default(false),
    reviewMetadata: jsonb("review_metadata"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "transfer_reconciliations_confidence_range",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`
    ),
    check(
      "transfer_reconciliations_auto_applied_requires_match",
      sql`${table.status} != 'auto_applied' or (${table.canonicalTransferId} is not null and ${table.deterministic} = true)`
    ),
    check(
      "transfer_reconciliations_link_requires_target",
      sql`${table.canonicalTransferId} is not null or ${table.canonicalTransactionId} is not null or ${table.status} in ('pending', 'needs_review', 'rejected')`
    ),
    uniqueIndex("transfer_reconciliations_provider_transfer_unique_idx").on(
      table.providerTransferId
    ),
    index("idx_transfer_reconciliations_user_status").on(table.userId, table.status),
    index("idx_transfer_reconciliations_canonical_transfer").on(table.canonicalTransferId),
    index("idx_transfer_reconciliations_canonical_transaction").on(table.canonicalTransactionId),
  ]
)

export type TransferReconciliation = typeof transferReconciliations.$inferSelect
export type TransferReconciliationInsert = typeof transferReconciliations.$inferInsert
