import { boolean, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sources } from "./SourcesTable.ts"

/** Durable source usage of a provider asset, including records without provider transfers. */
export const providerAssetSourceUses = pgTable(
  "provider_asset_source_uses",
  {
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    hasChainlessObservation: boolean("has_chainless_observation").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.providerAssetRowId, table.sourceId] }),
    index("idx_provider_asset_source_uses_source").on(table.sourceId),
  ]
)

export type ProviderAssetSourceUse = typeof providerAssetSourceUses.$inferSelect
export type ProviderAssetSourceUseInsert = typeof providerAssetSourceUses.$inferInsert
