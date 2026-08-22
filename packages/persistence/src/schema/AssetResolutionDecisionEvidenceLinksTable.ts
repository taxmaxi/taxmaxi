import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { assetResolutionDecisions } from "./AssetResolutionDecisionsTable.ts"
import { assetResolutionEvidence } from "./AssetResolutionEvidenceTable.ts"

/** Immutable evidence snapshots explicitly reviewed for a human decision. */
export const assetResolutionDecisionEvidenceLinks = pgTable(
  "asset_resolution_decision_evidence_links",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => assetResolutionDecisions.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => assetResolutionEvidence.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.decisionId, table.evidenceId] })]
)

export type AssetResolutionDecisionEvidenceLink =
  typeof assetResolutionDecisionEvidenceLinks.$inferSelect
