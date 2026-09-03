/**
 * Durable source evidence for exact network representations.
 *
 * @module SourceRepresentationUsesTable
 */

import { sql } from "drizzle-orm"
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { assetRepresentationTypeEnum } from "./AssetRepresentationsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"
import { sources } from "./SourcesTable.ts"

/** Exact native, contract, or mint representation observed by one source. */
export const sourceRepresentationUses = pgTable(
  "source_representation_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    representationType: assetRepresentationTypeEnum("representation_type").notNull(),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "source_representation_uses_identity_matches_type",
      sql`(
        ${table.representationType} = 'native'
        and ${table.contractAddress} is null
        and ${table.mintAddress} is null
      ) or (
        ${table.representationType} in ('token', 'nft')
        and num_nonnulls(${table.contractAddress}, ${table.mintAddress}) = 1
      )`
    ),
    uniqueIndex("source_representation_uses_native_unique_idx")
      .on(table.sourceId, table.blockchainId)
      .where(sql`${table.representationType} = 'native'`),
    uniqueIndex("source_representation_uses_contract_unique_idx")
      .on(table.sourceId, table.blockchainId, table.representationType, table.contractAddress)
      .where(sql`${table.contractAddress} is not null`),
    uniqueIndex("source_representation_uses_mint_unique_idx")
      .on(table.sourceId, table.blockchainId, table.representationType, table.mintAddress)
      .where(sql`${table.mintAddress} is not null`),
    uniqueIndex("source_representation_uses_id_source_unique_idx").on(table.id, table.sourceId),
    index("idx_source_representation_uses_source").on(table.sourceId),
  ]
)

export type SourceRepresentationUse = typeof sourceRepresentationUses.$inferSelect
export type SourceRepresentationUseInsert = typeof sourceRepresentationUses.$inferInsert
