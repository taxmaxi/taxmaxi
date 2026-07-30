import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/**
 * Canonical economic assets used for valuation, inventory, and tax accounting.
 *
 * Chain-specific identity belongs in `asset_representations`.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    coingeckoCoinId: text("coingecko_coin_id"),
    logoUrl: text("logo_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    isSpam: boolean("is_spam").notNull().default(false),
  },
  (table) => [
    index("asset_symbol_idx").on(table.symbol),
    uniqueIndex("assets_coingecko_coin_id_unique")
      .on(table.coingeckoCoinId)
      .where(sql`${table.coingeckoCoinId} is not null`),
  ]
)

export type Asset = typeof assets.$inferSelect
export type AssetInsert = typeof assets.$inferInsert
