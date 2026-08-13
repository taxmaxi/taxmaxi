import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { users } from "./UsersTable.ts"

export const billingSubscriptionStatusEnum = pgEnum("billing_subscription_status", [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
])

export const creditEntryKindEnum = pgEnum("credit_entry_kind", [
  "annual_grant",
  "top_up",
  "transaction_usage",
  "manual_adjustment",
])

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: billingSubscriptionStatusEnum("subscription_status"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_accounts_stripe_customer_unique").on(table.stripeCustomerId),
    uniqueIndex("billing_accounts_stripe_subscription_unique")
      .on(table.stripeSubscriptionId)
      .where(sql`${table.stripeSubscriptionId} is not null`),
  ]
)

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    kind: creditEntryKindEnum("kind").notNull(),
    reference: text("reference").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_ledger_reference_unique").on(table.reference),
    index("idx_credit_ledger_user_id").on(table.userId),
    index("idx_credit_ledger_expires_at").on(table.expiresAt),
    check("credit_ledger_delta_non_zero", sql`${table.delta} <> 0`),
  ]
)

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
})

export type BillingAccountRow = typeof billingAccounts.$inferSelect
export type CreditLedgerRow = typeof creditLedger.$inferSelect
export type StripeEventRow = typeof stripeEvents.$inferSelect
