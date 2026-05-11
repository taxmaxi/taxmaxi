import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { addresses } from "./AddressesTable.ts"
import { assets } from "./AssetsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"
import { transactions } from "./TransactionsTable.ts"

/**
 * Onchain-specific context for canonical transactions.
 *
 * Keeps chain details (chain tx id, block context, fee context, from/to) out of
 * the source-agnostic transaction envelope while preserving explorer links and
 * reconciliation context.
 *
 * `chainTxId` stores hash/signature/txid depending on blockchain:
 * - EVM: tx hash
 * - Solana: signature
 * - Bitcoin: txid
 */
export const transactionOnchainContext = pgTable(
  "transaction_onchain_context",
  {
    transactionId: uuid("transaction_id")
      // 1:1 link to canonical transaction envelope.
      .primaryKey()
      .references(() => transactions.id, {
        onDelete: "cascade",
      }),

    blockchainId: uuid("blockchain_id")
      // Required for explorer links and chain-specific interpretation.
      .notNull()
      .references(() => blockchains.id),
    addressId: uuid("address_id")
      .notNull()
      .references(() => addresses.id, {
        onDelete: "cascade",
      }),

    chainTxId: text("tx_hash").notNull(), // Hash/signature/txid for explorer deep-links.
    blockHeight: numeric("block_number"), // Block number (EVM), slot/height equivalent on other chains.
    blockHash: text("block_hash"), // Optional block hash when provided by upstream API.
    positionInBlock: numeric("position_in_block"), // Log/event index or transaction index in block.

    fromAddress: text("from_address").notNull(), // Initiator/sender in chain-native format.
    toAddress: text("to_address"),

    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }), // EVM-specific gas used.
    gasPrice: numeric("gas_price", { precision: 78, scale: 0 }), // EVM-specific gas price.

    feeAmount: numeric("gas_fee_in_native", { precision: 78, scale: 0 }), // Chain fee amount in native units.
    feeAssetId: uuid("fee_asset_id").references(() => assets.id), // Native fee asset (ETH, SOL, BTC, ...).

    feeCostBasisAmount: numeric("gas_fee_cost_basis_amount", { precision: 36, scale: 8 }), // Fiat value at execution time.
    feeCostBasisCurrency: text("gas_fee_cost_basis_currency"), // Fiat currency code for fee valuation.

    isError: boolean("is_error").default(false).notNull(),
    functionName: text("function_name"), // Optional decoded method/function label.
    metadata: jsonb("metadata"), // Chain/provider-specific extras not modeled as dedicated columns.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transaction_onchain_context_chain_tx_hash_address_unique").on(
      table.blockchainId,
      table.chainTxId,
      table.addressId
    ),
    index("idx_transaction_onchain_context_tx_hash").on(table.chainTxId),
    index("idx_transaction_onchain_context_blockchain_tx_hash").on(
      table.blockchainId,
      table.chainTxId
    ),
    index("idx_transaction_onchain_context_address").on(table.addressId),
  ]
)

export type TransactionOnchainContext = typeof transactionOnchainContext.$inferSelect
export type TransactionOnchainContextInsert = typeof transactionOnchainContext.$inferInsert
