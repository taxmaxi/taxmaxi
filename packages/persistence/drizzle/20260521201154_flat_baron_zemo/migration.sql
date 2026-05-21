ALTER TABLE "principal_claims" DROP CONSTRAINT "principal_claims_wallet_resource_fields";--> statement-breakpoint
ALTER TYPE "principal_claim_type" RENAME VALUE 'cli_claim_token' TO 'anonymous_source_claim_token';--> statement-breakpoint
ALTER TABLE "principal_claims" ADD CONSTRAINT "principal_claims_wallet_resource_fields" CHECK ("claim_type" not in ('siwx_wallet', 'anonymous_source_claim_token') or ("source_id" is not null and "chain_type" is not null and "wallet_address" is not null and "year" is not null and "jurisdiction" is not null));
