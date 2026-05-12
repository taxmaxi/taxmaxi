import { sql } from "drizzle-orm"
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./UsersTable.ts"

export const principalKindEnum = pgEnum("principal_kind", ["user", "anonymous_wallet"])

/**
 * Durable ownership principal for sync and tax data.
 */
export const principals = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: principalKindEnum("kind").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "principals_kind_user_id_consistency",
      sql`(${table.kind} = 'user' and ${table.userId} is not null) or (${table.kind} = 'anonymous_wallet' and ${table.userId} is null)`
    ),
    uniqueIndex("principals_user_unique").on(table.userId),
    index("idx_principals_kind").on(table.kind),
  ]
)

export type PrincipalRow = typeof principals.$inferSelect
export type PrincipalInsert = typeof principals.$inferInsert
