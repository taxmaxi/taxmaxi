import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { assets } from "./AssetsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { providerTransfers } from "./ProviderTransfersTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactionLegs } from "./TransactionLegsTable.ts"

export const fifoLots = pgTable(
  "fifo_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
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

    // Exactly one durable acquisition origin: a derived leg or an inbound provider transfer.
    sourceLegId: uuid("source_leg_id").references(() => transactionLegs.id, {
      onDelete: "cascade",
    }),
    sourceProviderTransferId: uuid("source_provider_transfer_id").references(
      () => providerTransfers.id,
      {
        onDelete: "cascade",
      }
    ),
    sourceLegSequence: integer("source_leg_sequence").notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "fifo_lots_origin_present",
      sql`num_nonnulls(${table.sourceLegId}, ${table.sourceProviderTransferId}) = 1`
    ),
    // One FIFO lot per acquisition leg - prevents duplicates on retry
    uniqueIndex("idx_fifo_lots_source_leg")
      .on(table.sourceLegId, table.sourceLegSequence)
      .where(sql`${table.sourceLegId} is not null`),
    uniqueIndex("idx_fifo_lots_source_provider_transfer")
      .on(table.sourceProviderTransferId)
      .where(sql`${table.sourceProviderTransferId} is not null`),
    // Index for principal + asset lookups in portfolio queries
    index("idx_fifo_lots_principal_asset_remaining").on(
      table.principalId,
      table.assetId,
      table.remainingAmount
    ),
  ]
)

export type FifoLot = typeof fifoLots.$inferSelect
export type FifoLotInsert = typeof fifoLots.$inferInsert
