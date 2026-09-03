import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assetRepresentationTypeEnum } from "./AssetRepresentationsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sourceRepresentationUses } from "./SourceRepresentationUsesTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactions } from "./TransactionsTable.ts"

export const providerTransferDirectionEnum = pgEnum("provider_transfer_direction", [
  "inbound",
  "outbound",
])

export type ProviderTransferDirection = (typeof providerTransferDirectionEnum.enumValues)[number]

/** Controls whether a provider movement participates in accounting and reconciliation. */
export const providerTransferProcessingModeEnum = pgEnum("provider_transfer_processing_mode", [
  "accounting_and_evidence",
  "accounting_only",
  "evidence_only",
  "stale",
])

export type ProviderTransferProcessingMode =
  (typeof providerTransferProcessingModeEnum.enumValues)[number]

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
    sourceRepresentationUseId: uuid("source_representation_use_id"),

    timestamp: timestamp("timestamp").notNull(),
    direction: providerTransferDirectionEnum("direction").notNull(),
    processingMode: providerTransferProcessingModeEnum("processing_mode").notNull(),

    fromAccountRef: text("from_account_ref"),
    toAccountRef: text("to_account_ref"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    networkName: text("network_name"),
    networkHash: text("network_hash"),
    observedBlockchainId: uuid("observed_blockchain_id").references(() => blockchains.id),
    observedRepresentationType: assetRepresentationTypeEnum("observed_representation_type"),
    observedContractAddress: text("observed_contract_address"),
    observedMintAddress: text("observed_mint_address"),
    observedDecimals: integer("observed_decimals"),

    amount: numeric("amount", { precision: 355, scale: 255 }).notNull(),
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRepresentationUseId, table.sourceId],
      foreignColumns: [sourceRepresentationUses.id, sourceRepresentationUses.sourceId],
      name: "provider_transfers_representation_use_source_fk",
    }),
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
    check(
      "provider_transfers_observed_representation_complete",
      sql`coalesce((
        ${table.observedRepresentationType} is null
        and ${table.observedBlockchainId} is null
        and ${table.observedContractAddress} is null
        and ${table.observedMintAddress} is null
        and ${table.observedDecimals} is null
      ) or (
        ${table.observedRepresentationType} is null
        and ${table.observedBlockchainId} is not null
        and num_nonnulls(${table.observedContractAddress}, ${table.observedMintAddress}) = 1
      ) or (
        ${table.observedRepresentationType} = 'native'
        and ${table.observedBlockchainId} is not null
        and ${table.observedContractAddress} is null
        and ${table.observedMintAddress} is null
      ) or (
        ${table.observedRepresentationType} in ('token', 'nft')
        and ${table.observedBlockchainId} is not null
        and num_nonnulls(${table.observedContractAddress}, ${table.observedMintAddress}) = 1
      ), false)`
    ),
    check(
      "provider_transfers_observed_decimals_non_negative",
      sql`${table.observedDecimals} is null or ${table.observedDecimals} >= 0`
    ),
    check(
      "provider_transfers_non_observation_has_no_identity",
      sql`${table.processingMode} not in ('accounting_only', 'stale') or (
        ${table.observedRepresentationType} is null
        and ${table.observedBlockchainId} is null
        and ${table.observedContractAddress} is null
        and ${table.observedMintAddress} is null
        and ${table.observedDecimals} is null
      )`
    ),
    uniqueIndex("provider_transfers_source_external_id_unique_idx")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    index("idx_provider_transfers_source_timestamp").on(table.sourceId, table.timestamp),
    index("idx_provider_transfers_transaction").on(table.transactionId),
    index("idx_provider_transfers_provider_asset").on(table.providerAssetId),
    index("idx_provider_transfers_representation_use").on(table.sourceRepresentationUseId),
    index("idx_provider_transfers_external_group").on(table.sourceId, table.externalGroupId),
    index("idx_provider_transfers_network_hash").on(table.networkHash),
  ]
)

export type ProviderTransfer = typeof providerTransfers.$inferSelect
export type ProviderTransferInsert = typeof providerTransfers.$inferInsert
