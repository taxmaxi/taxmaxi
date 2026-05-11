import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

/**
 * Provider transaction type catalog captured from provider docs or observed payloads.
 */
export const providerTransactionTypeCatalog = pgTable(
  "provider_transaction_type_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerTransactionType: text("provider_transaction_type").notNull(),
    description: text("description"),
    sourceUrl: text("source_url"),
    retrievedAt: timestamp("retrieved_at").notNull(),
    rawSourcePayload: jsonb("raw_source_payload"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_transaction_type_catalog_provider_type_unique").on(
      table.provider,
      table.providerTransactionType
    ),
    index("idx_provider_transaction_type_catalog_provider").on(table.provider),
  ]
)

export type ProviderTransactionTypeCatalogRow = typeof providerTransactionTypeCatalog.$inferSelect
export type ProviderTransactionTypeCatalogInsert =
  typeof providerTransactionTypeCatalog.$inferInsert
