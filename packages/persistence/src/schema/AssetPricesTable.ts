import { index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"

export const assetPrices = pgTable(
  "asset_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }), // Cascade delete if asset is deleted
    timestamp: timestamp("timestamp", { withTimezone: false }).notNull(), // Store as UTC, date part significant for daily prices
    price: numeric("price", { precision: 36, scale: 18 }).notNull(), // Sufficient precision for crypto prices
    currency: text("currency").notNull(), // e.g., 'EUR', 'USD'
    source: text("source"), // Optional: e.g., 'coingecko', 'manual'
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("unique_asset_price_idx").on(table.assetId, table.timestamp, table.currency),
    index("asset_price_asset_id_idx").on(table.assetId),
    index("asset_price_timestamp_idx").on(table.timestamp),
    index("asset_price_currency_idx").on(table.currency),
  ]
)

export type AssetPrice = typeof assetPrices.$inferSelect
export type AssetPriceInsert = typeof assetPrices.$inferInsert
