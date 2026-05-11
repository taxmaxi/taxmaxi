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
import { sql } from "drizzle-orm"
import { addresses } from "./AddressesTable.ts"
import { assets } from "./AssetsTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactions } from "./TransactionsTable.ts"
import { transfers } from "./TransfersTable.ts"
import { users } from "./UsersTable.ts"

/**
 * Leg kind enum - the accounting classification of each leg
 * - acquisition: receiving an asset (creates tax basis)
 * - disposal: sending an asset (triggers gain/loss calculation)
 * - income: receiving an asset as income (e.g., staking rewards, airdrops)
 * - fee: gas fees or other transaction costs (always deductible)
 */
export const legKindEnum = pgEnum("leg_kind", ["acquisition", "disposal", "income", "fee"])

export type LegKind = (typeof legKindEnum.enumValues)[number]

/**
 * Provenance enum - how the leg was derived
 * - deterministic: derived from known transfer patterns (most reliable)
 * - rule: derived from function signature or protocol mappings
 * - ai: derived from LLM categorization (requires review)
 * - manual: manually set by user
 */
export const legProvenanceEnum = pgEnum("leg_provenance", ["deterministic", "rule", "ai", "manual"])

export type LegProvenance = (typeof legProvenanceEnum.enumValues)[number]

/**
 * Transaction legs table - normalized accounting legs derived from raw transfers/events
 *
 * This table is the canonical substrate for FIFO and tax reporting. Each transfer
 * may produce multiple legs (e.g., a swap produces a disposal leg and an acquisition leg,
 * plus potentially a fee leg for gas).
 *
 * Key invariants:
 * - Fee legs are always explicit (never conflated with payments)
 * - Acquisition legs create FIFO lots
 * - Disposal legs consume FIFO lots via disposal_matches
 * - Income legs are taxable events at acquisition value
 */
export const transactionLegs = pgTable(
  "transaction_legs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sourceId: uuid("source_id") // Owning source for cross-provider FIFO and replay.
      .notNull()
      .references(() => sources.id, {
        onDelete: "cascade",
      }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      // Raw record link used to trace normalization decisions back to provider payload.
      onDelete: "set null",
    }),
    externalId: text("external_id"), // Provider leg/event id for idempotent replay.

    // Transaction context
    txHash: text("tx_hash"), // Optional onchain tx reference for explorer/debug links.
    timestamp: timestamp("timestamp").notNull(),

    // User/address scope
    userId: uuid("user_id").references(() => users.id),
    addressId: uuid("address_id").references(() => addresses.id, { onDelete: "cascade" }),

    // Asset and amount
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    amount: numeric("amount", { precision: 100, scale: 30 }).notNull(), // Exact asset quantity in canonical asset units.

    // Accounting classification
    kind: legKindEnum("kind").notNull(),

    // How this leg was derived
    provenance: legProvenanceEnum("provenance").notNull(),

    // Derivation metadata - which rule/pattern/layer produced this leg
    derivationRule: text("derivation_rule"),
    metadata: jsonb("metadata"), // Rule/debug payload for review and replay traceability.

    // Link to parent transaction
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),

    // Link to source transfer (if derived from a transfer)
    sourceTransferId: uuid("source_transfer_id").references(() => transfers.id, {
      onDelete: "cascade",
    }),

    // Fiat valuation at time of leg (calculated from price at timestamp)
    fiatAmount: numeric("fiat_amount", { precision: 36, scale: 8 }),
    fiatCurrency: text("fiat_currency"),

    // For fee legs: link to the transaction that incurred this fee
    feeForTransactionId: uuid("fee_for_transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "transaction_legs_identifier_present",
      sql`${table.txHash} is not null or ${table.externalId} is not null`
    ),
    check(
      "transaction_legs_tx_hash_requires_address",
      sql`${table.txHash} is null or ${table.addressId} is not null`
    ),
    uniqueIndex("idx_transaction_legs_source_external_unique")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),

    // Prevent duplicate legs from same transfer with same kind
    // A transfer can produce multiple legs of different kinds (e.g., swap: acquisition + disposal)
    uniqueIndex("idx_transaction_legs_unique")
      .on(table.txHash, table.addressId, table.assetId, table.kind, table.sourceTransferId)
      .where(sql`${table.txHash} is not null and ${table.addressId} is not null`),

    // Ensure a transaction has at most one canonical gas fee leg per asset+address.
    uniqueIndex("idx_transaction_legs_gas_fee_unique")
      .on(table.txHash, table.addressId, table.assetId)
      .where(
        sql`${table.txHash} is not null AND ${table.addressId} is not null AND ${table.kind} = 'fee' AND ${table.derivationRule} IN ('gas_fee', 'failed_tx_gas_fee')`
      ),

    // Query legs by source (cross-provider import and tax replay)
    index("idx_transaction_legs_source").on(table.sourceId),

    // Query legs by transaction
    index("idx_transaction_legs_transaction").on(table.transactionId),

    // Query legs by address (for portfolio views)
    index("idx_transaction_legs_address").on(table.addressId),

    // Query legs by user (for tax reports)
    index("idx_transaction_legs_user").on(table.userId),

    // Query legs by asset (for FIFO processing)
    index("idx_transaction_legs_asset").on(table.assetId),

    // Query legs by kind (e.g., all acquisitions for FIFO lot creation)
    index("idx_transaction_legs_kind").on(table.kind),

    // Timestamp ordering for chronological processing
    index("idx_transaction_legs_timestamp").on(table.timestamp),
  ]
)

export type TransactionLeg = typeof transactionLegs.$inferSelect
export type TransactionLegInsert = typeof transactionLegs.$inferInsert
