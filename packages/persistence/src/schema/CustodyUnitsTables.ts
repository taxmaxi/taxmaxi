import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"
import { sources } from "./SourcesTable.ts"

/** Recorded grouping boundary used by per-custody-unit accounting. */
export const custodyUnits = pgTable(
  "custody_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("custody_units_id_principal_unique").on(table.id, table.principalId),
    index("idx_custody_units_principal").on(table.principalId),
  ]
)

/** Source membership in a recorded custody unit. */
export const custodyUnitSources = pgTable(
  "custody_unit_sources",
  {
    principalId: uuid("principal_id").notNull(),
    custodyUnitId: uuid("custody_unit_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId] }),
    foreignKey({
      columns: [table.custodyUnitId, table.principalId],
      foreignColumns: [custodyUnits.id, custodyUnits.principalId],
      name: "custody_unit_sources_unit_principal_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      columns: [table.sourceId, table.principalId],
      foreignColumns: [sources.id, sources.principalId],
      name: "custody_unit_sources_source_principal_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("idx_custody_unit_sources_unit").on(table.custodyUnitId),
  ]
)

export type CustodyUnit = typeof custodyUnits.$inferSelect
export type CustodyUnitInsert = typeof custodyUnits.$inferInsert
export type CustodyUnitSource = typeof custodyUnitSources.$inferSelect
export type CustodyUnitSourceInsert = typeof custodyUnitSources.$inferInsert
