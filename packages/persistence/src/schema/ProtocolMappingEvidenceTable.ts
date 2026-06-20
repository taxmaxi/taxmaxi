import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { protocolCandidateObservations } from "./ProtocolCandidateObservationsTable.ts"
import { protocolTransactionTypeMappings } from "./ProtocolTransactionTypeMappingsTable.ts"

export const protocolMappingEvidenceKindEnum = pgEnum("protocol_mapping_evidence_kind", [
  "sample_signature",
  "normalized_fixture",
  "dune_observation",
  "review_note",
])

export type ProtocolMappingEvidenceKind =
  (typeof protocolMappingEvidenceKindEnum.enumValues)[number]

/**
 * Evidence retained to explain why a protocol transaction-type mapping was reviewed.
 */
export const protocolMappingEvidence = pgTable(
  "protocol_mapping_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mappingId: uuid("mapping_id")
      .notNull()
      .references(() => protocolTransactionTypeMappings.id, { onDelete: "cascade" }),
    candidateObservationId: uuid("candidate_observation_id").references(
      () => protocolCandidateObservations.id,
      { onDelete: "set null" }
    ),
    evidenceKind: protocolMappingEvidenceKindEnum("evidence_kind").notNull(),
    sampleSignature: text("sample_signature"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_protocol_mapping_evidence_mapping").on(table.mappingId)]
)

export type ProtocolMappingEvidenceRow = typeof protocolMappingEvidence.$inferSelect
export type ProtocolMappingEvidenceInsert = typeof protocolMappingEvidence.$inferInsert
