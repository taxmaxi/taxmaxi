import { sql } from "drizzle-orm"
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"

/**
 * Append-only history of which economic asset owns a network representation.
 *
 * Ownership is keyed on the representation itself, not on the provider
 * observation that first surfaced it, so a second provider observing the same
 * representation can reuse the settled conclusion. Corrections append a row
 * linked to the prior ownership conclusion while the representation row keeps
 * the current owner projection.
 */
export const assetRepresentationOwnershipDecisions = pgTable(
  "asset_representation_ownership_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetRepresentationId: uuid("asset_representation_id")
      .notNull()
      .references(() => assetRepresentations.id),
    assetId: uuid("asset_id").notNull(),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    policyRevision: text("policy_revision").notNull(),
    reason: text("reason"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_representation_ownership_record_unique")
      .on(table.assetRepresentationId)
      .where(sql`${table.supersedesDecisionId} is null`),
    uniqueIndex("asset_representation_ownership_supersedes_unique")
      .on(table.supersedesDecisionId)
      .where(sql`${table.supersedesDecisionId} is not null`),
    uniqueIndex("asset_representation_ownership_representation_id_unique").on(
      table.assetRepresentationId,
      table.id
    ),
    index("idx_asset_representation_ownership_asset_id").on(table.assetId),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [assets.id],
      name: "asset_representation_ownership_asset_id_fk",
    }),
    foreignKey({
      columns: [table.assetRepresentationId, table.supersedesDecisionId],
      foreignColumns: [table.assetRepresentationId, table.id],
      name: "asset_representation_ownership_supersedes_fk",
    }),
  ]
)

export type AssetRepresentationOwnershipDecisionRow =
  typeof assetRepresentationOwnershipDecisions.$inferSelect
export type AssetRepresentationOwnershipDecisionInsert =
  typeof assetRepresentationOwnershipDecisions.$inferInsert
