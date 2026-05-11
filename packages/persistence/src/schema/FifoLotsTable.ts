import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactionLegs } from "./TransactionLegsTable.ts"
import { users } from "./UsersTable.ts"

export const fifoLots = pgTable(
  "fifo_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),

    // Acquisition details
    acquiredAt: timestamp("acquired_at").notNull(),
    originalAmount: numeric("original_amount", { precision: 100, scale: 30 }).notNull(),
    remainingAmount: numeric("remaining_amount", { precision: 100, scale: 30 }).notNull(),

    // Cost basis information
    costBasisPerToken: numeric("cost_basis_per_token", { precision: 36, scale: 18 }).notNull(),
    costBasisCurrency: text("cost_basis_currency").notNull(),

    // Link to the acquisition leg
    sourceLegId: uuid("source_leg_id")
      .notNull()
      .references(() => transactionLegs.id, {
        onDelete: "cascade",
      }),
    sourceLegSequence: integer("source_leg_sequence").notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One FIFO lot per acquisition leg - prevents duplicates on retry
    uniqueIndex("idx_fifo_lots_source_leg").on(table.sourceLegId, table.sourceLegSequence),
    // Index for user + asset lookups in portfolio queries
    index("idx_fifo_lots_user_asset_remaining").on(
      table.userId,
      table.assetId,
      table.remainingAmount
    ),
  ]
)

export type FifoLot = typeof fifoLots.$inferSelect
export type FifoLotInsert = typeof fifoLots.$inferInsert
