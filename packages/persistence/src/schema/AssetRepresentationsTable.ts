import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"

export const assetRepresentationTypeEnum = pgEnum("asset_representation_type", [
  "native",
  "token",
  "nft",
])

export type AssetRepresentationType = (typeof assetRepresentationTypeEnum.enumValues)[number]

/** Concrete native asset, contract, or mint representing an economic asset on one network. */
export const assetRepresentations = pgTable(
  "asset_representations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    type: assetRepresentationTypeEnum("type").notNull(),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    decimals: integer("decimals").notNull(),
    logoUrl: text("logo_url"),
    isSpam: boolean("is_spam").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("asset_representations_decimals_non_negative", sql`${table.decimals} >= 0`),
    check(
      "asset_representations_identity_matches_type",
      sql`(
        ${table.type} = 'native'
        and ${table.contractAddress} is null
        and ${table.mintAddress} is null
      ) or (
        ${table.type} in ('token', 'nft')
        and num_nonnulls(${table.contractAddress}, ${table.mintAddress}) = 1
      )`
    ),
    uniqueIndex("asset_representations_native_blockchain_unique_idx")
      .on(table.blockchainId)
      .where(sql`${table.type} = 'native'`),
    uniqueIndex("asset_representations_contract_unique_idx")
      .on(table.blockchainId, sql`lower(${table.contractAddress})`)
      .where(sql`${table.contractAddress} is not null`),
    uniqueIndex("asset_representations_mint_unique_idx")
      .on(table.blockchainId, table.mintAddress)
      .where(sql`${table.mintAddress} is not null`),
    uniqueIndex("asset_representations_asset_id_id_unique_idx").on(table.assetId, table.id),
    index("idx_asset_representations_asset").on(table.assetId),
    index("idx_asset_representations_blockchain").on(table.blockchainId),
  ]
)

export type AssetRepresentation = typeof assetRepresentations.$inferSelect
export type AssetRepresentationInsert = typeof assetRepresentations.$inferInsert
