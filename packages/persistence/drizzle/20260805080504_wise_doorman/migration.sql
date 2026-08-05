ALTER TABLE "provider_transfers" ADD COLUMN "observed_blockchain_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_representation_type" "asset_representation_type";--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_contract_address" text;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_mint_address" text;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD COLUMN "observed_decimals" integer;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("observed_blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_representation_complete" CHECK ((
        "observed_representation_type" is null
        and "observed_blockchain_id" is null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
        and "observed_decimals" is null
      ) or (
        "observed_representation_type" = 'native'
        and "observed_blockchain_id" is not null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
      ) or (
        "observed_representation_type" in ('token', 'nft')
        and "observed_blockchain_id" is not null
        and num_nonnulls("observed_contract_address", "observed_mint_address") = 1
      ));--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_observed_decimals_non_negative" CHECK ("observed_decimals" is null or "observed_decimals" >= 0);