import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
    logoUrl: text("logo_url"),
    type: assetTypeEnum("type").notNull().default("token"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    isSpam: boolean("is_spam").notNull().default(false),
  },
  (table) => [
    // Unique constraint for tokens (blockchainId + contractAddress)
    unique("unique_token_idx").on(table.blockchainId, table.contractAddress),
    // Unique constraint for native assets (blockchainId + symbol, where contractAddress is NULL)
    // This might need a partial index or a more complex check depending on Drizzle ORM capabilities for NULLs in unique constraints.
    // For now, we'll rely on application logic or a simpler unique constraint on symbol if truly global symbols are unique enough.
    // A common pattern is to ensure contractAddress is an empty string for native assets if the DB doesn't support NULL in unique constraints well.
    index("asset_symbol_idx").on(table.symbol),
  ]
)

export type Asset = typeof assets.$inferSelect
export type AssetInsert = typeof assets.$inferInsert
