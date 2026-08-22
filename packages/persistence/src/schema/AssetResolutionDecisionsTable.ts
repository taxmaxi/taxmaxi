import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
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
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

export const assetResolutionOutcomeEnum = pgEnum("asset_resolution_outcome", [
  "attach",
  "create_standalone",
  "identity",
  "excluded",
  "pending",
  "fail_closed",
])

export type AssetResolutionOutcome = (typeof assetResolutionOutcomeEnum.enumValues)[number]

export const assetResolutionDecisionStatusEnum = pgEnum("asset_resolution_decision_status", [
  "active",
  "superseded",
])

export type AssetResolutionDecisionStatus =
  (typeof assetResolutionDecisionStatusEnum.enumValues)[number]

/**
 * Append-only automatic policy decision history for one provider
 * observation and evidence revision.
 *
 * Decision content is never edited. A correction appends a new active row
 * that names the row it replaces through supersedes_decision_id, and the
 * replaced row's status flips to superseded. At most one decision is active
 * per (providerAssetRowId, evidenceRevision), enforced by a partial unique
 * index, so replaying a resolution job never rewrites history and concurrent
 * recorders cannot both win.
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
    status: assetResolutionDecisionStatusEnum("status").notNull().default("active"),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    assetId: uuid("asset_id").references(() => assets.id),
    assetRepresentationId: uuid("asset_representation_id").references(
      () => assetRepresentations.id
    ),
    blockchain: text("blockchain"),
    representationType: text("representation_type"),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    decimals: integer("decimals"),
    reason: text("reason"),
    humanClaim: jsonb("human_claim"),
    rationale: text("rationale"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_resolution_decisions_active_observation_revision_unique")
      .on(table.providerAssetRowId, table.evidenceRevision)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("asset_resolution_decisions_supersedes_unique")
      .on(table.supersedesDecisionId)
      .where(sql`${table.supersedesDecisionId} is not null`),
    index("idx_asset_resolution_decisions_asset_id").on(table.assetId),
    foreignKey({
      columns: [table.supersedesDecisionId],
      foreignColumns: [table.id],
      name: "asset_resolution_decisions_supersedes_decision_id_fk",
    }),
    check(
      "asset_resolution_decisions_evidence_revision_positive",
      sql`${table.evidenceRevision} > 0`
    ),
    check(
      "asset_resolution_decisions_approval_requires_target",
      sql`${table.outcome}::text not in ('attach', 'create_standalone') or (${table.assetId} is not null and (${table.blockchain} is null or ${table.assetRepresentationId} is not null))`
    ),
  ]
)

export type AssetResolutionDecisionRow = typeof assetResolutionDecisions.$inferSelect
export type AssetResolutionDecisionInsert = typeof assetResolutionDecisions.$inferInsert
