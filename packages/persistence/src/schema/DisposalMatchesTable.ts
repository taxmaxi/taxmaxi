import { index, numeric, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { fifoLots } from "./FifoLotsTable.ts"
import { transactionLegs } from "./TransactionLegsTable.ts"

export const disposalMatches = pgTable(
  "disposal_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The disposal leg
    disposalLegId: uuid("disposal_leg_id")
      .notNull()
      .references(() => transactionLegs.id, {
        onDelete: "cascade",
      }),

    // Which FIFO lot provided the tokens
    fifoLotId: uuid("fifo_lot_id")
      .notNull()
      .references(() => fifoLots.id, { onDelete: "cascade" }),

    // How much from this lot was used
    matchedAmount: numeric("matched_amount", { precision: 100, scale: 30 }).notNull(),

    // Cost basis of the matched amount (from the lot)
    costBasis: numeric("cost_basis", { precision: 36, scale: 8 }).notNull(),

    // Proceeds allocated to this portion of the disposal
    proceeds: numeric("proceeds", { precision: 36, scale: 8 }).notNull(),

    // Calculated gain/loss for this match
    gainLoss: numeric("gain_loss", { precision: 36, scale: 8 }).notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Each lot can only be matched once per disposal leg - prevents duplicates on retry
    uniqueIndex("idx_disposal_matches_leg_unique").on(table.fifoLotId, table.disposalLegId),
    // Index for querying by leg
    index("idx_disposal_matches_leg").on(table.disposalLegId),
  ]
)

export type DisposalMatch = typeof disposalMatches.$inferSelect
export type DisposalMatchInsert = typeof disposalMatches.$inferInsert
