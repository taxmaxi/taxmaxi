import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { sources } from "./SourcesTable.ts"

export const principalClaimTypeEnum = pgEnum("principal_claim_type", [
  "x402_receipt",
  "siwx_wallet",
  "cli_claim_token",
])

/**
 * Verifiable ownership or entitlement claim attached to a principal.
 */
export const principalClaims = pgTable(
  "principal_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    claimType: principalClaimTypeEnum("claim_type").notNull(),
    claimValueHash: text("claim_value_hash").notNull(),
    chainType: text("chain_type"),
    walletAddress: text("wallet_address"),
    payerChainType: text("payer_chain_type"),
    payerWalletAddress: text("payer_wallet_address"),
    year: integer("year"),
    jurisdiction: text("jurisdiction"),
    expiresAt: timestamp("expires_at"),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principal_claims_type_value_unique").on(table.claimType, table.claimValueHash),
    uniqueIndex("principal_claims_request_type_unique").on(table.requestId, table.claimType),
    index("idx_principal_claims_principal_id").on(table.principalId),
    index("idx_principal_claims_source_id").on(table.sourceId),
    index("idx_principal_claims_payer_wallet").on(table.payerChainType, table.payerWalletAddress),
    check(
      "principal_claims_wallet_resource_fields",
      sql`${table.claimType} not in ('siwx_wallet', 'cli_claim_token') or (${table.sourceId} is not null and ${table.chainType} is not null and ${table.walletAddress} is not null and ${table.year} is not null and ${table.jurisdiction} is not null)`
    ),
  ]
)

export type PrincipalClaimRow = typeof principalClaims.$inferSelect
export type PrincipalClaimInsert = typeof principalClaims.$inferInsert
