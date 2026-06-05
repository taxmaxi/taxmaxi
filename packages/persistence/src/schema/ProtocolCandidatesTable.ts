import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { blockchains } from "./BlockchainsTable.ts"
import { providerMappingStatusEnum } from "./ProviderTransactionTypeMappingsTable.ts"

/**
 * Programs, contracts, or protocols we found and still need to review.
 *
 * This is a todo list for mapping work, not tax classification data.
 */
export const protocolCandidates = pgTable(
  "protocol_candidates",
  {
    // Stable internal candidate identifier.
    id: uuid("id").primaryKey().defaultRandom(),
    // Chain where the discovered subject exists.
    blockchainId: uuid("blockchain_id")
      .notNull()
      .references(() => blockchains.id),
    // Chain-neutral subject category, such as "program", "contract", or "protocol".
    subjectKind: text("subject_kind").notNull(),
    // Stable source identifier for the subject, such as a Solana program id or EVM contract address.
    subjectIdentifier: text("subject_identifier").notNull(),
    // Optional protocol/project name suggested by the discovery source.
    protocolNameHint: text("protocol_name_hint"),
    // Optional classification category suggested by the discovery source.
    categoryHint: text("category_hint"),
    // Review lifecycle for deciding whether this candidate maps to TaxMaxi behavior.
    mappingStatus: providerMappingStatusEnum("mapping_status").notNull().default("pending_review"),
    // Earliest source retrieval time that observed this candidate.
    firstSeenAt: timestamp("first_seen_at").notNull(),
    // Latest source retrieval time that observed this candidate.
    lastSeenAt: timestamp("last_seen_at").notNull(),
    // Database row creation timestamp.
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Database row update timestamp.
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("protocol_candidates_blockchain_subject_unique").on(
      table.blockchainId,
      table.subjectKind,
      table.subjectIdentifier
    ),
    index("idx_protocol_candidates_mapping_status").on(table.mappingStatus),
  ]
)

export type ProtocolCandidateRow = typeof protocolCandidates.$inferSelect
export type ProtocolCandidateInsert = typeof protocolCandidates.$inferInsert
