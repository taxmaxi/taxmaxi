CREATE TYPE "transaction_leg_origin_kind" AS ENUM('provider_transfer', 'canonical_transfer', 'none');--> statement-breakpoint
-- transaction_legs is replayable derived state, and origin_kind can only be supplied truthfully by the writer.
-- Delete-and-replay avoids both false defaults and ambiguous nulls before adding the required column.
DELETE FROM "transaction_legs";--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "origin_kind" "transaction_leg_origin_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "provider_transfer_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_provider_transfer" ON "transaction_legs" ("provider_transfer_id");--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_provider_transfer_id_provider_transfers_id_fk" FOREIGN KEY ("provider_transfer_id") REFERENCES "provider_transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_origin_matches_kind" CHECK (("origin_kind" = 'provider_transfer' and "provider_transfer_id" is not null and "source_transfer_id" is null)
        or ("origin_kind" = 'canonical_transfer' and "provider_transfer_id" is null and "source_transfer_id" is not null)
        or ("origin_kind" = 'none' and "provider_transfer_id" is null and "source_transfer_id" is null));
