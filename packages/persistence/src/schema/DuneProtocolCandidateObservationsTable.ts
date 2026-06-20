import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core"
import { protocolCandidateObservations } from "./ProtocolCandidateObservationsTable.ts"

/**
 * Dune-specific metadata for protocol candidate observations.
 *
 * This table keeps saved-query identity structured for idempotency and audit
 * without forcing generic observations from future sources to carry Dune query
 * columns.
 */
export const duneProtocolCandidateObservations = pgTable("dune_protocol_candidate_observations", {
  // Observation row this Dune metadata describes.
  observationId: uuid("observation_id")
    .primaryKey()
    .references(() => protocolCandidateObservations.id, { onDelete: "cascade" }),
  // Dune saved-query id that produced the observation.
  queryId: integer("query_id").notNull(),
  // Human-readable Dune saved-query name at import time.
  queryName: text("query_name").notNull(),
  // Importer-controlled version for interpreting the Dune query output.
  queryVersion: integer("query_version").notNull(),
})

export type DuneProtocolCandidateObservationRow =
  typeof duneProtocolCandidateObservations.$inferSelect
export type DuneProtocolCandidateObservationInsert =
  typeof duneProtocolCandidateObservations.$inferInsert
