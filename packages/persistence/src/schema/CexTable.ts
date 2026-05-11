import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const cex = pgTable("cex", {
  id: uuid("id").primaryKey().defaultRandom(),

  name: text("name").notNull().unique(),
  website: text("website").notNull(),
  logoUrl: text("logo_url"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

export type Cex = typeof cex.$inferSelect
export type CexInsert = typeof cex.$inferInsert
