CREATE TYPE "provider_transfer_processing_mode" AS ENUM('accounting_and_evidence', 'accounting_only', 'evidence_only', 'stale');--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "processing_mode" "provider_transfer_processing_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_blockchain_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_representation_type" "asset_representation_type";--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_contract_address" text;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_mint_address" text;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_decimals" integer;--> statement-breakpoint
ALTER TABLE "disposal_matches" ALTER COLUMN "matched_amount" SET DATA TYPE numeric(355,255) USING "matched_amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "fifo_lots" ALTER COLUMN "original_amount" SET DATA TYPE numeric(355,255) USING "original_amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "fifo_lots" ALTER COLUMN "remaining_amount" SET DATA TYPE numeric(355,255) USING "remaining_amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "inventory_movement_allocations" ALTER COLUMN "matched_amount" SET DATA TYPE numeric(355,255) USING "matched_amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "amount" SET DATA TYPE numeric(355,255) USING "amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "provider_transfers" ALTER COLUMN "amount" SET DATA TYPE numeric(355,255) USING "amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "transaction_legs" ALTER COLUMN "amount" SET DATA TYPE numeric(355,255) USING "amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "amount" SET DATA TYPE numeric(355,255) USING "amount"::numeric(355,255);--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("observed_blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_representation_complete" CHECK (coalesce((
        "observed_representation_type" is null
        and "observed_blockchain_id" is null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
        and "observed_decimals" is null
      ) or (
        "observed_representation_type" is null
        and "observed_blockchain_id" is not null
        and num_nonnulls("observed_contract_address", "observed_mint_address") = 1
      ) or (
        "observed_representation_type" = 'native'
        and "observed_blockchain_id" is not null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
      ) or (
        "observed_representation_type" in ('token', 'nft')
        and "observed_blockchain_id" is not null
        and num_nonnulls("observed_contract_address", "observed_mint_address") = 1
      ), false));--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_decimals_non_negative" CHECK ("observed_decimals" is null or "observed_decimals" >= 0);--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_non_observation_has_no_identity" CHECK ("processing_mode" not in ('accounting_only', 'stale') or (
        "observed_representation_type" is null
        and "observed_blockchain_id" is null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
        and "observed_decimals" is null
      ));