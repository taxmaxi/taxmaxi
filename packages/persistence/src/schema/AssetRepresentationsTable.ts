import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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

/**
 * Concrete native, contract, or mint representations of an economic asset.
 *
 * `contractAddress` stores an EVM contract, Solana mint, or equivalent
 * chain-native identifier. Native representations have no contract address.
 */
export const assetRepresentations = pgTable(
  "asset_representations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    type: assetRepresentationTypeEnum("type").notNull(),
    contractAddress: text("contract_address"),
    decimals: integer("decimals").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "asset_representations_identity_matches_type",
      sql`(
        ${table.type} = 'native'
        and ${table.contractAddress} is null
      ) or (
        ${table.type} in ('token', 'nft')
        and ${table.contractAddress} is not null
      )`
    ),
    check("asset_representations_decimals_non_negative", sql`${table.decimals} >= 0`),
    unique("asset_representations_id_asset_unique").on(table.id, table.assetId),
    uniqueIndex("asset_representations_chain_contract_unique")
      .on(table.blockchainId, table.contractAddress)
      .where(sql`${table.contractAddress} is not null`),
    uniqueIndex("asset_representations_chain_native_unique")
      .on(table.blockchainId)
      .where(sql`${table.type} = 'native'`),
    index("asset_representations_asset_idx").on(table.assetId),
    index("asset_representations_blockchain_idx").on(table.blockchainId),
  ]
)

export type AssetRepresentation = typeof assetRepresentations.$inferSelect
export type AssetRepresentationInsert = typeof assetRepresentations.$inferInsert
