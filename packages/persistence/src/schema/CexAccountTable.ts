import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { cex } from "./CexTable.ts"
import { principals } from "./PrincipalsTable.ts"

/**
 * Connected exchange account credentials.
 *
 * This is the canonical credential store for CEX APIs (including Coinbase),
 * separate from user login identities.
 */
export const cexAccount = pgTable(
  "cex_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    cexId: uuid("cex_id")
      .references(() => cex.id, { onDelete: "cascade" })
      .notNull(),
    principalId: uuid("principal_id")
      .references(() => principals.id, { onDelete: "cascade" })
      .notNull(),

    providerUserId: text("provider_user_id"), // Provider-level user identifier (e.g. Coinbase user id).
    providerAccountId: text("provider_account_id"), // Provider account/portfolio/subaccount identifier.

    accessToken: text("access_token"),
    expiresAt: timestamp("expires_at"),
    refreshToken: text("refresh_token"),
    scopes: text("scopes"),

    apiKey: text("api_key"),
    apiSecret: text("api_secret"),

    credentialsUpdatedAt: timestamp("credentials_updated_at"), // Last token/key rotation timestamp.
    metadata: jsonb("metadata"), // Provider-specific account metadata.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_cex_account_principal_cex").on(table.principalId, table.cexId),
    uniqueIndex("cex_account_principal_cex_provider_account_unique")
      .on(table.principalId, table.cexId, table.providerAccountId)
      .where(sql`${table.providerAccountId} is not null`),
  ]
)

export type CexAccount = typeof cexAccount.$inferSelect
export type CexAccountInsert = typeof cexAccount.$inferInsert
