import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./UsersTable.ts"

export const authProviderTypeEnum = pgEnum("auth_provider_type", ["local", "google", "coinbase"])

export const identities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProviderTypeEnum("provider").notNull(),
    providerId: text("provider_id").notNull(),
    passwordHash: text("password_hash"),
    providerData: jsonb("provider_data"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_provider_id_uidx").on(table.provider, table.providerId),
    uniqueIndex("auth_identities_user_provider_uidx").on(table.userId, table.provider),
  ]
)

export type IdentityRow = typeof identities.$inferSelect
