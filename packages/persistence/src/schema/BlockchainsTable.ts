import { integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const chainTypeEnum = pgEnum("chain_type", ["evm", "solana", "bitcoin", "cardano", "other"])

export type ChainType = (typeof chainTypeEnum.enumValues)[number]

export const blockchains = pgTable("blockchains", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  chainType: chainTypeEnum("chain_type").notNull(),
  chainId: integer("chain_id"), // Nullable, primarily for EVM chains
  nativeAssetSymbol: text("native_asset_symbol").notNull(),
  explorerUrl: text("explorer_url"),
  logoUrl: text("logo_url"),
  coingeckoPlatformId: text("coingecko_platform_id").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export type Blockchain = typeof blockchains.$inferSelect
export type BlockchainInsert = typeof blockchains.$inferInsert
