ALTER TABLE "disposal_matches" DROP CONSTRAINT "disposal_matches_fifo_lot_id_fifo_lots_id_fkey";--> statement-breakpoint
ALTER TABLE "inventory_movement_allocations" DROP CONSTRAINT "inventory_movement_allocations_fifo_lot_id_fifo_lots_id_fkey";--> statement-breakpoint
DROP TABLE "disposal_matches";--> statement-breakpoint
DROP TABLE "fifo_lots";--> statement-breakpoint
DROP TABLE "inventory_movement_allocations";--> statement-breakpoint
DROP TYPE "fifo_lot_cost_basis_status";