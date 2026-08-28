import { foreignKey, pgTable, timestamp, uuid } from "drizzle-orm/pg-core"
import { assetResolutionDecisions } from "./AssetResolutionDecisionsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

/**
 * Current roles for immutable asset-resolution decisions.
 *
 * A policy evaluation can advance without replacing the global conclusion.
 * Human approval changes the conclusion pointer with compare-and-set while
 * every decision row remains unchanged.
 */
export const assetResolutionCurrentState = pgTable(
  "asset_resolution_current_state",
  {
    providerAssetRowId: uuid("provider_asset_row_id")
      .primaryKey()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    currentConclusionId: uuid("current_conclusion_id").references(
      () => assetResolutionDecisions.id
    ),
    currentPolicyEvaluationId: uuid("current_policy_evaluation_id").references(
      () => assetResolutionDecisions.id
    ),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.providerAssetRowId, table.currentConclusionId],
      foreignColumns: [assetResolutionDecisions.providerAssetRowId, assetResolutionDecisions.id],
      name: "asset_resolution_current_conclusion_observation_fk",
    }),
    foreignKey({
      columns: [table.providerAssetRowId, table.currentPolicyEvaluationId],
      foreignColumns: [assetResolutionDecisions.providerAssetRowId, assetResolutionDecisions.id],
      name: "asset_resolution_current_policy_evaluation_observation_fk",
    }),
  ]
)

export type AssetResolutionCurrentStateRow = typeof assetResolutionCurrentState.$inferSelect
export type AssetResolutionCurrentStateInsert = typeof assetResolutionCurrentState.$inferInsert
