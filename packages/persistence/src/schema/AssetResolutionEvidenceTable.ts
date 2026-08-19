import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assetResolutionDecisions } from "./AssetResolutionDecisionsTable.ts"

/**
 * One evidence snapshot behind a resolution decision, scoped to the authority
 * that provided it and the kind of claim it makes.
 *
 * A new authority is a new row, never a new column. The decoded claim is what
 * the policy read; the raw payload is what the authority actually returned.
 * Recording evidence says nothing about which claims the authority may prove.
 */
export const assetResolutionEvidence = pgTable(
  "asset_resolution_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => assetResolutionDecisions.id, { onDelete: "cascade" }),
    authority: text("authority").notNull(),
    claimKind: text("claim_kind").notNull(),
    sourceLocator: text("source_locator"),
    retrievedAt: timestamp("retrieved_at").notNull(),
    evidenceRevision: integer("evidence_revision").notNull(),
    decodedClaim: jsonb("decoded_claim"),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_resolution_evidence_decision_authority_claim_unique").on(
      table.decisionId,
      table.authority,
      table.claimKind
    ),
    index("idx_asset_resolution_evidence_decision_id").on(table.decisionId),
  ]
)

export type AssetResolutionEvidenceRow = typeof assetResolutionEvidence.$inferSelect
export type AssetResolutionEvidenceInsert = typeof assetResolutionEvidence.$inferInsert
