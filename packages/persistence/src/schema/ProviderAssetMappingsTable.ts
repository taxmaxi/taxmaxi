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
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

export const providerAssetMappingKindEnum = pgEnum("provider_asset_mapping_kind", ["asset", "fiat"])

export type ProviderAssetMappingKind = (typeof providerAssetMappingKindEnum.enumValues)[number]

/**
 * Provider-asset mapping lifecycle. Unlike the shared provider mapping
 * status, observations have a final `excluded` state: the observation never
 * maps to a canonical asset, its transactions stay stored and visible, and
 * the calculation is complete without them. `rejected` stays an open
 * question; `excluded` is a final evidence-backed answer.
 */
export const providerAssetMappingStatusEnum = pgEnum("provider_asset_mapping_status", [
  "approved",
  "pending_review",
  "rejected",
  "excluded",
])

export type ProviderAssetMappingStatus = (typeof providerAssetMappingStatusEnum.enumValues)[number]

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
    assetRepresentationId: uuid("asset_representation_id"),
    canonicalFiatCurrency: text("canonical_fiat_currency"),
    mappingStatus: providerAssetMappingStatusEnum("mapping_status")
      .notNull()
      .default("pending_review"),
    reviewerNotes: text("reviewer_notes"),
    sourceNotes: text("source_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_asset_mappings_provider_asset_row_unique").on(table.providerAssetRowId),
    index("idx_provider_asset_mappings_status").on(table.mappingStatus),
    check(
      "provider_asset_mappings_kind_requires_target",
      sql`(
        ${table.mappingKind} = 'asset'
        and ${table.canonicalAssetId} is not null
      ) or (
        ${table.mappingKind} = 'fiat'
        and ${table.canonicalFiatCurrency} is not null
      ) or ${table.mappingStatus} in ('pending_review', 'rejected', 'excluded')`
    ),
    check(
      "provider_asset_mappings_representation_requires_asset",
      sql`${table.assetRepresentationId} is null or ${table.canonicalAssetId} is not null`
    ),
    foreignKey({
      columns: [table.canonicalAssetId, table.assetRepresentationId],
      foreignColumns: [assetRepresentations.assetId, assetRepresentations.id],
      name: "provider_asset_mappings_representation_matches_asset_fk",
    }),
  ]
)

export type ProviderAssetMappingRow = typeof providerAssetMappings.$inferSelect
export type ProviderAssetMappingInsert = typeof providerAssetMappings.$inferInsert
