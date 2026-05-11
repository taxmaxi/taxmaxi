import { sql } from "drizzle-orm"
import {
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactions } from "./TransactionsTable.ts"

export const providerTransferDirectionEnum = pgEnum("provider_transfer_direction", [
  "inbound",
  "outbound",
])

export type ProviderTransferDirection = (typeof providerTransferDirectionEnum.enumValues)[number]

/**
 * Durable provider-side principal movements captured before canonical asset mapping
 * or onchain reconciliation is complete.
 */
export const providerTransfers = pgTable(
  "provider_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      onDelete: "set null",
    }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    externalGroupId: text("external_group_id"),

    providerAssetId: uuid("provider_asset_id").references(() => providerAssets.id, {
      onDelete: "set null",
    }),

    timestamp: timestamp("timestamp").notNull(),
    direction: providerTransferDirectionEnum("direction").notNull(),

    fromAccountRef: text("from_account_ref"),
    toAccountRef: text("to_account_ref"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    networkName: text("network_name"),
    networkHash: text("network_hash"),

    amount: numeric("amount", { precision: 100, scale: 30 }).notNull(),
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "provider_transfers_identifier_present",
      sql`${table.externalId} is not null or ${table.networkHash} is not null`
    ),
    check(
      "provider_transfers_from_party_present",
      sql`${table.fromAddress} is not null or ${table.fromAccountRef} is not null`
    ),
    check(
      "provider_transfers_to_party_present",
      sql`${table.toAddress} is not null or ${table.toAccountRef} is not null`
    ),
    check("provider_transfers_amount_positive", sql`${table.amount} > 0`),
    uniqueIndex("provider_transfers_source_external_id_unique_idx")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    index("idx_provider_transfers_source_timestamp").on(table.sourceId, table.timestamp),
    index("idx_provider_transfers_transaction").on(table.transactionId),
    index("idx_provider_transfers_external_group").on(table.sourceId, table.externalGroupId),
    index("idx_provider_transfers_network_hash").on(table.networkHash),
  ]
)

export type ProviderTransfer = typeof providerTransfers.$inferSelect
export type ProviderTransferInsert = typeof providerTransfers.$inferInsert
