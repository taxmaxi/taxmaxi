import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

export const assetResolutionOutcomeEnum = pgEnum("asset_resolution_outcome", [
  "attach",
  "pending",
  "fail_closed",
])

export type AssetResolutionOutcome = (typeof assetResolutionOutcomeEnum.enumValues)[number]

/**
 * Immutable attach-only policy decision history for one provider observation
 * and evidence revision.
 *
 * One row per (providerAssetRowId, evidenceRevision): a second decision for
 * the same pair is a no-op so replaying a resolution job never rewrites history.
 */
export const assetResolutionDecisions = pgTable(
  "asset_resolution_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerAssetRowId: uuid("provider_asset_row_id")
      .notNull()
      .references(() => providerAssets.id, { onDelete: "cascade" }),
    evidenceRevision: integer("evidence_revision").notNull(),
    policyRevision: text("policy_revision").notNull(),
    outcome: assetResolutionOutcomeEnum("outcome").notNull(),
    assetId: uuid("asset_id").references(() => assets.id),
    assetRepresentationId: uuid("asset_representation_id"),
    blockchain: text("blockchain"),
    representationType: text("representation_type"),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    decimals: integer("decimals"),
    reason: text("reason"),
    chainEvidence: jsonb("chain_evidence"),
    coinGeckoEvidence: jsonb("coingecko_evidence"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_resolution_decisions_observation_revision_unique").on(
      table.providerAssetRowId,
      table.evidenceRevision
    ),
    index("idx_asset_resolution_decisions_asset_id").on(table.assetId),
    check(
      "asset_resolution_decisions_evidence_revision_positive",
      sql`${table.evidenceRevision} > 0`
    ),
    check(
      "asset_resolution_decisions_attach_requires_target",
      sql`${table.outcome} <> 'attach' or (${table.assetId} is not null and ${table.assetRepresentationId} is not null)`
    ),
  ]
)

export type AssetResolutionDecisionRow = typeof assetResolutionDecisions.$inferSelect
export type AssetResolutionDecisionInsert = typeof assetResolutionDecisions.$inferInsert
