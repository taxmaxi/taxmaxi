import { boolean, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { transactions } from "./TransactionsTable.ts"

export const reviewStatusEnum = pgEnum("review_status", [
  "auto_applied",
  "needs_review",
  "approved",
  "changed",
])

export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number]

// Transaction review metadata - extends transactions with review-specific fields
export const transactionReviews = pgTable("transaction_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),

  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" })
    .unique(),

  principalId: uuid("principal_id")
    .notNull()
    .references(() => principals.id, { onDelete: "cascade" }),

  // Review status
  reviewStatus: reviewStatusEnum("review_status").notNull().default("needs_review"),

  // Original auto-detected values (for rollback)
  originalTypeKey: text("original_type_key"),
  originalConfidence: numeric("original_confidence", { precision: 3, scale: 2 }),

  // Current values (may differ if user changed)
  currentTypeKey: text("current_type_key"),

  // Ruleset replay key captured at categorization/review decision time
  legalRuleSetVersion: text("legal_rule_set_version"),

  // Categorization reasoning/evidence
  categorizationReason: text("categorization_reason"), // The reasoning from categorization
  matchedLayer: text("matched_layer"), // Which categorization layer matched

  // User can flag for review or mark as resolved
  needsReview: boolean("needs_review").notNull().default(true),

  // User notes
  userNotes: text("user_notes"),

  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

export type TransactionReview = typeof transactionReviews.$inferSelect
export type TransactionReviewInsert = typeof transactionReviews.$inferInsert
