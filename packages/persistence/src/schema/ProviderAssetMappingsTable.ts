import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { providerMappingStatusEnum } from "./ProviderTransactionTypeMappingsTable.ts"

export const providerAssetMappingKindEnum = pgEnum("provider_asset_mapping_kind", ["asset", "fiat"])

export type ProviderAssetMappingKind = (typeof providerAssetMappingKindEnum.enumValues)[number]

/**
 * Provider asset -> canonical asset / fiat mapping.
 */
export const providerAssetMappings = pgTable(
  "provider_asset_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id),
    mappingKind: providerAssetMappingKindEnum("mapping_kind").notNull(),
    canonicalAssetId: uuid("canonical_asset_id").references(() => assets.id),
    canonicalAssetRepresentationId: uuid("canonical_asset_representation_id"),
    canonicalFiatCurrency: text("canonical_fiat_currency"),
    mappingStatus: providerMappingStatusEnum("mapping_status").notNull().default("pending_review"),
    reviewerNotes: text("reviewer_notes"),
    sourceNotes: text("source_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_asset_mappings_provider_asset_row_unique").on(table.providerAssetRowId),
    foreignKey({
      columns: [table.canonicalAssetRepresentationId, table.canonicalAssetId],
      foreignColumns: [assetRepresentations.id, assetRepresentations.assetId],
      name: "provider_asset_mappings_representation_asset_fk",
    }),
    index("idx_provider_asset_mappings_status").on(table.mappingStatus),
    check(
      "provider_asset_mappings_kind_requires_target",
      sql`(
        ${table.mappingKind} = 'asset'
        and ${table.canonicalAssetId} is not null
        and ${table.canonicalFiatCurrency} is null
      ) or (
        ${table.mappingKind} = 'fiat'
        and ${table.canonicalAssetId} is null
        and ${table.canonicalAssetRepresentationId} is null
        and ${table.canonicalFiatCurrency} is not null
      ) or ${table.mappingStatus} in ('pending_review', 'rejected')`
    ),
    check(
      "provider_asset_mappings_representation_requires_asset",
      sql`${table.canonicalAssetRepresentationId} is null or ${table.canonicalAssetId} is not null`
    ),
  ]
)

export type ProviderAssetMappingRow = typeof providerAssetMappings.$inferSelect
export type ProviderAssetMappingInsert = typeof providerAssetMappings.$inferInsert
