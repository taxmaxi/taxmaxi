ALTER TABLE "principal_claims" ADD COLUMN "payer_chain_type" text;--> statement-breakpoint
ALTER TABLE "principal_claims" ADD COLUMN "payer_wallet_address" text;--> statement-breakpoint
CREATE INDEX "idx_principal_claims_payer_wallet" ON "principal_claims" ("payer_chain_type","payer_wallet_address");