import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * Durable provider-side asset identity captured from provider reference endpoints.
 */
export const providerAssets = pgTable(
  "provider_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerAssetId: text("provider_asset_id"),
    naturalKey: text("natural_key"),
    currencyCode: text("currency_code").notNull(),
    name: text("name"),
    exponent: integer("exponent"),
    providerType: text("provider_type"),
    rawProviderPayload: jsonb("raw_provider_payload"),
    discoveredAt: timestamp("discovered_at").notNull().defaultNow(),
    retrievedAt: timestamp("retrieved_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_assets_provider_asset_id_unique")
      .on(table.provider, table.providerAssetId)
      .where(sql`${table.providerAssetId} is not null`),
    uniqueIndex("provider_assets_provider_natural_key_unique")
      .on(table.provider, table.naturalKey)
      .where(sql`${table.naturalKey} is not null`),
    index("idx_provider_assets_provider").on(table.provider),
    check(
      "provider_assets_identity_requires_key",
      sql`${table.providerAssetId} is not null or ${table.naturalKey} is not null`
    ),
  ]
)

export type ProviderAssetRow = typeof providerAssets.$inferSelect
export type ProviderAssetInsert = typeof providerAssets.$inferInsert
