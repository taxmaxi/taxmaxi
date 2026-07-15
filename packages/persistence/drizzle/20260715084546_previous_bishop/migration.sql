CREATE TYPE "inventory_movement_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "inventory_movement_purpose" AS ENUM('principal', 'fee', 'reward');--> statement-breakpoint
CREATE TYPE "inventory_movement_reconciliation_status" AS ENUM('unmatched', 'matched', 'needs_review');--> statement-breakpoint
CREATE TYPE "inventory_movement_tax_treatment" AS ENUM('taxable', 'non_taxable', 'pending_review');--> statement-breakpoint
CREATE TABLE "inventory_movement_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"inventory_movement_id" uuid NOT NULL,
	"fifo_lot_id" uuid NOT NULL,
	"matched_amount" numeric(100,30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movement_allocations_amount_positive" CHECK ("matched_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid,
	"transaction_id" uuid NOT NULL,
	"provider_transfer_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"timestamp" timestamp NOT NULL,
	"direction" "inventory_movement_direction" NOT NULL,
	"purpose" "inventory_movement_purpose" NOT NULL,
	"tax_treatment" "inventory_movement_tax_treatment" NOT NULL,
	"reconciliation_status" "inventory_movement_reconciliation_status" NOT NULL,
	"amount" numeric(100,30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movement_allocations_lot_movement_unique_idx" ON "inventory_movement_allocations" ("inventory_movement_id","fifo_lot_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_movement_allocations_movement" ON "inventory_movement_allocations" ("inventory_movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_provider_transfer_unique_idx" ON "inventory_movements" ("provider_transfer_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_source_timestamp" ON "inventory_movements" ("source_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_principal_asset" ON "inventory_movements" ("principal_id","asset_id");--> statement-breakpoint
ALTER TABLE "inventory_movement_allocations" ADD CONSTRAINT "inventory_movement_allocations_iAO6csLCSW6D_fkey" FOREIGN KEY ("inventory_movement_id") REFERENCES "inventory_movements"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movement_allocations" ADD CONSTRAINT "inventory_movement_allocations_fifo_lot_id_fifo_lots_id_fkey" FOREIGN KEY ("fifo_lot_id") REFERENCES "fifo_lots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_g3T9P1auBFr8_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_Hu4boO3PhauI_fkey" FOREIGN KEY ("provider_transfer_id") REFERENCES "provider_transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");