import { sql } from "drizzle-orm"
import {
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { fifoLots } from "./FifoLotsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { providerTransfers } from "./ProviderTransfersTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactionLegs } from "./TransactionLegsTable.ts"
import { transactions } from "./TransactionsTable.ts"

export const inventoryMovementDirectionEnum = pgEnum("inventory_movement_direction", [
  "inbound",
  "outbound",
])

export const inventoryMovementPurposeEnum = pgEnum("inventory_movement_purpose", [
  "principal",
  "fee",
  "reward",
])

export const inventoryMovementTaxTreatmentEnum = pgEnum("inventory_movement_tax_treatment", [
  "taxable",
  "non_taxable",
  "pending_review",
])

export const inventoryMovementReconciliationStatusEnum = pgEnum(
  "inventory_movement_reconciliation_status",
  ["unmatched", "matched", "needs_review"]
)

/**
 * Provider-neutral factual custody movements. Tax classification is deliberately
 * stored separately from movement direction.
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      onDelete: "set null",
    }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    providerTransferId: uuid("provider_transfer_id").references(() => providerTransfers.id, {
      onDelete: "cascade",
    }),
    transactionLegId: uuid("transaction_leg_id").references(() => transactionLegs.id, {
      onDelete: "cascade",
    }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    timestamp: timestamp("timestamp").notNull(),
    direction: inventoryMovementDirectionEnum("direction").notNull(),
    purpose: inventoryMovementPurposeEnum("purpose").notNull(),
    taxTreatment: inventoryMovementTaxTreatmentEnum("tax_treatment").notNull(),
    reconciliationStatus:
      inventoryMovementReconciliationStatusEnum("reconciliation_status").notNull(),
    amount: numeric("amount", { precision: 100, scale: 30 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("inventory_movements_amount_positive", sql`${table.amount} > 0`),
    check(
      "inventory_movements_origin_present",
      sql`num_nonnulls(${table.providerTransferId}, ${table.transactionLegId}) = 1`
    ),
    uniqueIndex("inventory_movements_provider_transfer_unique_idx")
      .on(table.providerTransferId)
      .where(sql`${table.providerTransferId} is not null`),
    uniqueIndex("inventory_movements_transaction_leg_unique_idx")
      .on(table.transactionLegId)
      .where(sql`${table.transactionLegId} is not null`),
    index("idx_inventory_movements_source_timestamp").on(table.sourceId, table.timestamp),
    index("idx_inventory_movements_principal_asset").on(table.principalId, table.assetId),
    index("idx_inventory_movements_transaction").on(table.transactionId),
  ]
)

/** FIFO quantity consumed by an outbound custody movement, without tax disposal semantics. */
export const inventoryMovementAllocations = pgTable(
  "inventory_movement_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryMovementId: uuid("inventory_movement_id")
      .notNull()
      .references(() => inventoryMovements.id, { onDelete: "cascade" }),
    fifoLotId: uuid("fifo_lot_id")
      .notNull()
      .references(() => fifoLots.id, { onDelete: "cascade" }),
    matchedAmount: numeric("matched_amount", { precision: 100, scale: 30 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("inventory_movement_allocations_amount_positive", sql`${table.matchedAmount} > 0`),
    uniqueIndex("inventory_movement_allocations_lot_movement_unique_idx").on(
      table.inventoryMovementId,
      table.fifoLotId
    ),
    index("idx_inventory_movement_allocations_movement").on(table.inventoryMovementId),
    index("idx_inventory_movement_allocations_fifo_lot").on(table.fifoLotId),
  ]
)

export type InventoryMovement = typeof inventoryMovements.$inferSelect
export type InventoryMovementInsert = typeof inventoryMovements.$inferInsert
export type InventoryMovementAllocation = typeof inventoryMovementAllocations.$inferSelect
export type InventoryMovementAllocationInsert = typeof inventoryMovementAllocations.$inferInsert
