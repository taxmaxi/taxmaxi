import { sql } from "drizzle-orm"
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assetResolutionDecisionStatusEnum } from "./AssetResolutionDecisionsTable.ts"
import { assets } from "./AssetsTable.ts"

/**
 * Append-only history of which economic asset owns a network representation.
 *
 * Ownership is keyed on the representation itself, not on the provider
 * observation that first surfaced it, so a second provider observing the same
 * representation can reuse the settled conclusion. At most one decision is
 * active per representation, and the composite foreign key onto
 * (asset_id, id) of asset_representations makes a decision naming a different
 * owner than the representation's current asset impossible to insert.
 */
export const assetRepresentationOwnershipDecisions = pgTable(
  "asset_representation_ownership_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetRepresentationId: uuid("asset_representation_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    status: assetResolutionDecisionStatusEnum("status").notNull().default("active"),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    policyRevision: text("policy_revision").notNull(),
    reason: text("reason"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_representation_ownership_active_unique")
      .on(table.assetRepresentationId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("asset_representation_ownership_supersedes_unique")
      .on(table.supersedesDecisionId)
      .where(sql`${table.supersedesDecisionId} is not null`),
    index("idx_asset_representation_ownership_asset_id").on(table.assetId),
    foreignKey({
      columns: [table.assetId, table.assetRepresentationId],
      foreignColumns: [assetRepresentations.assetId, assetRepresentations.id],
      name: "asset_representation_ownership_owner_matches_fk",
    }),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [assets.id],
      name: "asset_representation_ownership_asset_id_fk",
    }),
    foreignKey({
      columns: [table.supersedesDecisionId],
      foreignColumns: [table.id],
      name: "asset_representation_ownership_supersedes_fk",
    }),
  ]
)

export type AssetRepresentationOwnershipDecisionRow =
  typeof assetRepresentationOwnershipDecisions.$inferSelect
export type AssetRepresentationOwnershipDecisionInsert =
  typeof assetRepresentationOwnershipDecisions.$inferInsert
