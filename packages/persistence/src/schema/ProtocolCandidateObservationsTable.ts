import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { protocolCandidates } from "./ProtocolCandidatesTable.ts"

export const protocolCandidateObservationSourceEnum = pgEnum(
  "protocol_candidate_observation_source",
  ["dune"]
)

export type ProtocolCandidateObservationSource =
  (typeof protocolCandidateObservationSourceEnum.enumValues)[number]

/**
 * Measurements that explain why a candidate was added.
 */
export const protocolCandidateObservations = pgTable(
  "protocol_candidate_observations",
  {
    // Stable internal observation identifier.
    id: uuid("id").primaryKey().defaultRandom(),
    // Candidate this evidence belongs to.
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => protocolCandidates.id, { onDelete: "cascade" }),
    // Discovery system that produced this observation.
    source: protocolCandidateObservationSourceEnum("source").notNull(),
    // Source-defined idempotency key for this candidate observation.
    sourceObservationKey: text("source_observation_key").notNull(),
    // Inclusive start of the activity window covered by the source metrics.
    observedWindowStart: timestamp("observed_window_start").notNull(),
    // Exclusive end of the activity window covered by the source metrics.
    observedWindowEnd: timestamp("observed_window_end").notNull(),
    // Broad source-defined activity score used for ranking, such as event rows,
    // instructions, trades, transfers, or other observed interactions.
    interactionCount: numeric("interaction_count", { precision: 78, scale: 0 }).notNull(),
    // Distinct transaction footprint when the source can provide it. One
    // transaction may contain many interactions.
    transactionCount: numeric("transaction_count", { precision: 78, scale: 0 }),
    // Distinct wallets/signers/traders/initiators observed around the candidate.
    // This is a breadth signal and is not bounded by transactionCount.
    uniqueActorCount: numeric("unique_actor_count", { precision: 78, scale: 0 }),
    // Representative transaction hashes retained so reviewers can inspect examples.
    sampleTransactionHashes: jsonb("sample_transaction_hashes")
      .$type<ReadonlyArray<string>>()
      .notNull(),
    // Source result retrieval/computation time, distinct from database insertion time.
    retrievedAt: timestamp("retrieved_at").notNull(),
    // Full decoded source row retained for audit and importer debugging.
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
    // Database row creation timestamp.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("protocol_candidate_observations_source_period_unique").on(
      table.candidateId,
      table.source,
      table.sourceObservationKey
    ),
    index("idx_protocol_candidate_observations_candidate").on(table.candidateId),
  ]
)

export type ProtocolCandidateObservationRow = typeof protocolCandidateObservations.$inferSelect
export type ProtocolCandidateObservationInsert = typeof protocolCandidateObservations.$inferInsert
