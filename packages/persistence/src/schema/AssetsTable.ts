import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { blockchains } from "./BlockchainsTable.ts"

export const assetTypeEnum = pgEnum("asset_type", ["native", "token", "nft"])

export type AssetType = (typeof assetTypeEnum.enumValues)[number]

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    contractAddress: text("contract_address"), // Nullable for native assets
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    coingeckoCoinId: text("coingecko_coin_id"),
    logoUrl: text("logo_url"),
    type: assetTypeEnum("type").notNull().default("token"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    isSpam: boolean("is_spam").notNull().default(false),
  },
  (table) => [
    // Unique constraint for tokens (blockchainId + contractAddress)
    unique("unique_token_idx").on(table.blockchainId, table.contractAddress),
    uniqueIndex("assets_native_blockchain_unique")
      .on(table.blockchainId)
      .where(sql`${table.contractAddress} is null`),
    index("asset_symbol_idx").on(table.symbol),
    index("asset_coingecko_coin_id_idx").on(table.coingeckoCoinId),
  ]
)

export type Asset = typeof assets.$inferSelect
export type AssetInsert = typeof assets.$inferInsert
