ALTER TABLE "fifo_lots" ADD COLUMN "source_provider_transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "fifo_lots" ALTER COLUMN "source_leg_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "idx_fifo_lots_source_leg";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fifo_lots_source_leg" ON "fifo_lots" ("source_leg_id","source_leg_sequence") WHERE "source_leg_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fifo_lots_source_provider_transfer" ON "fifo_lots" ("source_provider_transfer_id") WHERE "source_provider_transfer_id" is not null;--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_zo6btAURiYIu_fkey" FOREIGN KEY ("source_provider_transfer_id") REFERENCES "provider_transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_origin_present" CHECK (num_nonnulls("source_leg_id", "source_provider_transfer_id") = 1);