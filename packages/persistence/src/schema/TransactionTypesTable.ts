import { foreignKey, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { transactionCategories } from "./TransactionCategoriesTable.ts"
import { transactionSubcategories } from "./TransactionSubcategoriesTable.ts"

export const transactionTypes = pgTable(
  "transaction_types",
  {
    typeKey: text("type_key").primaryKey(),
    categoryKey: text("category_key"),
    subcategoryKey: text("subcategory_key"),
    labelEn: text("label_en").notNull(),
    labelDe: text("label_de").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.categoryKey],
      foreignColumns: [transactionCategories.categoryKey],
      name: "transaction_types_category_key_fk",
    }),
    foreignKey({
      columns: [table.subcategoryKey],
      foreignColumns: [transactionSubcategories.subcategoryKey],
      name: "transaction_types_subcategory_key_fk",
    }),
  ]
)

export type TransactionType = typeof transactionTypes.$inferSelect
