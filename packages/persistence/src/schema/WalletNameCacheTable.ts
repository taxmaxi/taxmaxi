/**
 * Wallet name cache schema
 *
 * Caches wallet name to address resolutions per name-service namespace
 * (ENS, SNS). Name records can change, so entries carry an absolute expiry
 * and get refreshed after it passes.
 *
 * @module WalletNameCacheTable
 */

import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

/**
 * wallet_name_cache table
 */
export const walletNameCache = pgTable(
  "wallet_name_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace").notNull(),
    name: text("name").notNull(),
    resolvedAddress: text("resolved_address").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("wallet_name_cache_namespace_name_idx").on(table.namespace, table.name)]
)

/**
 * Row type for wallet_name_cache
 */
export type WalletNameCacheRow = typeof walletNameCache.$inferSelect

/**
 * Insert type for wallet_name_cache
 */
export type WalletNameCacheInsert = typeof walletNameCache.$inferInsert
