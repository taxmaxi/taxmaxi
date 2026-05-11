import { sql } from "drizzle-orm"
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { addresses } from "./AddressesTable.ts"
import { cexAccount } from "./CexAccountTable.ts"
import { users } from "./UsersTable.ts"

// Source families we ingest from.
export const sourceableTypeEnum = pgEnum("sourceable_type", ["onchain", "cex", "dex"])

/**
 * User-connected data source.
 *
 * A source is the root object for ingestion, sync state, raw records, jobs,
 * and normalized accounting outputs.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),
    providerKey: text("provider_key"), // Concrete adapter key: etherscan, coinbase, bitcoin-rpc, hyperliquid.
    providerMetadata: jsonb("provider_metadata"), // Provider-specific source config and hints.
    lastSyncedAt: timestamp("last_synced_at"), // Last successful sync timestamp for this source.

    addressId: uuid("address_id").references(() => addresses.id, { onDelete: "cascade" }),
    cexAccountId: uuid("cex_account_id").references(() => cexAccount.id, { onDelete: "cascade" }),

    sourceableType: sourceableTypeEnum("sourceable_type").notNull(), // Source family routing.

    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "sourceable_id_not_null",
      sql`${table.addressId} is not null or ${table.cexAccountId} is not null`
    ),
    index("idx_sources_provider_key").on(table.providerKey),
    uniqueIndex("sources_user_address_unique").on(table.userId, table.addressId),
    uniqueIndex("sources_user_cex_account_unique").on(table.userId, table.cexAccountId),
  ]
)

export type SourceInsert = typeof sources.$inferInsert
export type SourceRow = typeof sources.$inferSelect
