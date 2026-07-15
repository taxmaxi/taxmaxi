ALTER TABLE "inventory_movements" ADD COLUMN "transaction_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "provider_transfer_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "inventory_movements_provider_transfer_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_provider_transfer_unique_idx" ON "inventory_movements" ("provider_transfer_id") WHERE "provider_transfer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_transaction_leg_unique_idx" ON "inventory_movements" ("transaction_leg_id") WHERE "transaction_leg_id" is not null;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_transaction_leg_id_transaction_legs_id_fkey" FOREIGN KEY ("transaction_leg_id") REFERENCES "transaction_legs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_origin_present" CHECK (num_nonnulls("provider_transfer_id", "transaction_leg_id") = 1);