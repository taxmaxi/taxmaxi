import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactions } from "./TransactionsTable.ts"

/**
 * Durable transaction-level dependence on a provider asset. Covers records
 * such as exchange trades that produce no provider transfer row, so exception
 * impact can count every blocked transaction.
 */
export const providerAssetTransactionUses = pgTable(
  "provider_asset_transaction_uses",
  {
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.providerAssetRowId, table.transactionId] }),
    index("idx_provider_asset_transaction_uses_transaction").on(table.transactionId),
    index("idx_provider_asset_transaction_uses_source").on(table.sourceId),
  ]
)

export type ProviderAssetTransactionUse = typeof providerAssetTransactionUses.$inferSelect
export type ProviderAssetTransactionUseInsert = typeof providerAssetTransactionUses.$inferInsert
