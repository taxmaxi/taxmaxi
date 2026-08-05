import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

export const assetTypeEnum = pgEnum("asset_type", ["fungible", "nft"])

export type AssetType = (typeof assetTypeEnum.enumValues)[number]

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    coingeckoCoinId: text("coingecko_coin_id"),
    logoUrl: text("logo_url"),
    type: assetTypeEnum("type").notNull().default("fungible"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("asset_symbol_idx").on(table.symbol),
    uniqueIndex("asset_coingecko_coin_id_unique_idx").on(table.coingeckoCoinId),
  ]
)

export type Asset = typeof assets.$inferSelect
export type AssetInsert = typeof assets.$inferInsert
