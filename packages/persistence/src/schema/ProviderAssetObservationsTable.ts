/**
 * ProviderAssetObservationsTable - Durable source observations of provider assets.
 *
 * @module ProviderAssetObservationsTable
 */

import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"

/**
 * Provider assets observed while normalizing a source row, including assets
 * that could not yet produce a canonical transfer.
 */
export const providerAssetObservations = pgTable(
  "provider_asset_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRawRecordId: uuid("source_raw_record_id")
      .notNull()
      .references(() => sourceRecordsRaw.id, { onDelete: "cascade" }),
    providerAssetId: uuid("provider_asset_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_asset_observations_raw_asset_unique").on(
      table.sourceRawRecordId,
      table.providerAssetId
    ),
    index("idx_provider_asset_observations_provider_asset").on(table.providerAssetId),
    index("idx_provider_asset_observations_source").on(table.sourceId),
  ]
)

export type ProviderAssetObservation = typeof providerAssetObservations.$inferSelect
export type ProviderAssetObservationInsert = typeof providerAssetObservations.$inferInsert
