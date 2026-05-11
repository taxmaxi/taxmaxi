import { index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cexAccount } from "./CexAccountTable.ts"
import { transactions } from "./TransactionsTable.ts"

export const transactionVenueTypeEnum = pgEnum("transaction_venue_type", ["cex", "dex"])

/**
 * Venue-specific context for canonical transactions.
 *
 * Stores order/fill/account attributes for CEX and DEX records without mixing
 * exchange-specific fields into the canonical transaction envelope.
 */
export const transactionVenueContext = pgTable(
  "transaction_venue_context",
  {
    transactionId: uuid("transaction_id")
      // 1:1 link to canonical transaction envelope.
      .primaryKey()
      .references(() => transactions.id, {
        onDelete: "cascade",
      }),

    venueType: transactionVenueTypeEnum("venue_type").notNull(), // Which venue family produced this transaction.

    cexAccountId: uuid("cex_account_id").references(() => cexAccount.id, {
      onDelete: "set null",
    }),
    externalAccountId: text("external_account_id"), // Provider account/subaccount identifier.

    externalOrderId: text("external_order_id"), // Provider order identifier.
    externalFillId: text("external_fill_id"), // Provider fill/trade identifier.

    side: text("side"), // buy/sell/long/short when available.
    instrument: text("instrument"), // Symbol/product pair (e.g. BTC-USD).
    fillPrice: numeric("fill_price", { precision: 100, scale: 30 }), // Execution price in quote currency.
    commissionAmount: numeric("commission_amount", { precision: 100, scale: 30 }), // Venue fee charged for execution.
    commissionCurrency: text("commission_currency"), // Fee currency code.

    metadata: jsonb("metadata"), // Provider payload fragment for audit and troubleshooting.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_transaction_venue_context_cex_account").on(table.cexAccountId),
    index("idx_transaction_venue_context_external_account").on(table.externalAccountId),
    index("idx_transaction_venue_context_order").on(table.externalOrderId),
    index("idx_transaction_venue_context_fill").on(table.externalFillId),
  ]
)

export type TransactionVenueContext = typeof transactionVenueContext.$inferSelect
export type TransactionVenueContextInsert = typeof transactionVenueContext.$inferInsert
