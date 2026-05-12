CREATE TYPE "principal_claim_type" AS ENUM('x402_receipt', 'siwx_wallet', 'cli_claim_token');--> statement-breakpoint
CREATE TYPE "principal_kind" AS ENUM('user', 'anonymous_wallet');--> statement-breakpoint
CREATE TABLE "principal_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"source_id" uuid,
	"request_id" uuid NOT NULL,
	"claim_type" "principal_claim_type" NOT NULL,
	"claim_value_hash" text NOT NULL,
	"chain_type" text,
	"wallet_address" text,
	"year" integer,
	"jurisdiction" text,
	"expires_at" timestamp,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_claims_wallet_resource_fields" CHECK ("claim_type" not in ('siwx_wallet', 'cli_claim_token') or ("source_id" is not null and "chain_type" is not null and "wallet_address" is not null and "year" is not null and "jurisdiction" is not null))
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" "principal_kind" NOT NULL,
	"user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principals_kind_user_id_consistency" CHECK (("kind" = 'user' and "user_id" is not null) or ("kind" = 'anonymous_wallet' and "user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "addresses" DROP CONSTRAINT "addresses_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "cex_account" DROP CONSTRAINT "cex_account_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "fifo_lots" DROP CONSTRAINT "fifo_lots_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "sources_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "transaction_legs" DROP CONSTRAINT "transaction_legs_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "transaction_reviews" DROP CONSTRAINT "transaction_reviews_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" DROP CONSTRAINT "transfer_reconciliations_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "addresses" DROP CONSTRAINT "addresses_address_user_id_unique";--> statement-breakpoint
DROP INDEX "idx_cex_account_user_cex";--> statement-breakpoint
DROP INDEX "cex_account_user_cex_provider_account_unique";--> statement-breakpoint
DROP INDEX "idx_fifo_lots_user_asset_remaining";--> statement-breakpoint
DROP INDEX "idx_processing_jobs_user_id";--> statement-breakpoint
DROP INDEX "sources_user_address_unique";--> statement-breakpoint
DROP INDEX "sources_user_cex_account_unique";--> statement-breakpoint
DROP INDEX "idx_sync_runs_user_id";--> statement-breakpoint
DROP INDEX "idx_transaction_legs_user";--> statement-breakpoint
DROP INDEX "idx_transfer_reconciliations_user_status";--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cex_account" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "cex_account" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "fifo_lots" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "processing_jobs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "transaction_legs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "transaction_reviews" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_principal_address_unique" UNIQUE("address","principal_id");--> statement-breakpoint
CREATE INDEX "idx_cex_account_principal_cex" ON "cex_account" ("principal_id","cex_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cex_account_principal_cex_provider_account_unique" ON "cex_account" ("principal_id","cex_id","provider_account_id") WHERE "provider_account_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_fifo_lots_principal_asset_remaining" ON "fifo_lots" ("principal_id","asset_id","remaining_amount");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_claims_type_value_unique" ON "principal_claims" ("claim_type","claim_value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_claims_request_type_unique" ON "principal_claims" ("request_id","claim_type");--> statement-breakpoint
CREATE INDEX "idx_principal_claims_principal_id" ON "principal_claims" ("principal_id");--> statement-breakpoint
CREATE INDEX "idx_principal_claims_source_id" ON "principal_claims" ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_user_unique" ON "principals" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_principals_kind" ON "principals" ("kind");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_principal_id" ON "processing_jobs" ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_principal_address_unique" ON "sources" ("principal_id","address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_principal_cex_account_unique" ON "sources" ("principal_id","cex_account_id");--> statement-breakpoint
CREATE INDEX "idx_sync_runs_principal_id" ON "sync_runs" ("principal_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_principal" ON "transaction_legs" ("principal_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_principal_timestamp" ON "transactions" ("principal_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_transfer_reconciliations_principal_status" ON "transfer_reconciliations" ("principal_id","status");--> statement-breakpoint
CREATE INDEX "idx_transfers_principal_timestamp" ON "transfers" ("principal_id","timestamp");--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cex_account" ADD CONSTRAINT "cex_account_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_claims" ADD CONSTRAINT "principal_claims_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_claims" ADD CONSTRAINT "principal_claims_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD CONSTRAINT "transaction_reviews_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;
