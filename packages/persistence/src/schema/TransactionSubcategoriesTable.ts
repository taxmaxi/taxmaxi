import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const transactionSubcategories = pgTable("transaction_subcategories", {
  subcategoryKey: text("subcategory_key").primaryKey(),
  nameEn: text("name_en").notNull(),
  nameDe: text("name_de").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export type TransactionSubcategory = typeof transactionSubcategories.$inferSelect
