import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./UsersTable.ts"

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export type SessionRow = typeof sessions.$inferSelect
