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
import { providerMappingStatusEnum } from "./ProviderTransactionTypeMappingsTable.ts"
import { users } from "./UsersTable.ts"

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
    assetRepresentationId: uuid("asset_representation_id"),
    canonicalFiatCurrency: text("canonical_fiat_currency"),
    mappingStatus: providerMappingStatusEnum("mapping_status").notNull().default("pending_review"),
    reviewerNotes: text("reviewer_notes"),
    sourceNotes: text("source_notes"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at"),
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
      ) or ${table.mappingStatus} in ('pending_review', 'rejected')`
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
