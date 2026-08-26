CREATE TYPE "asset_representation_type" AS ENUM('native', 'token', 'nft');--> statement-breakpoint
CREATE TABLE "asset_representations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"asset_id" uuid NOT NULL,
	"blockchain_id" uuid NOT NULL,
	"type" "asset_representation_type" NOT NULL,
	"contract_address" text,
	"mint_address" text,
	"decimals" integer NOT NULL,
	"logo_url" text,
	"is_spam" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_representations_decimals_non_negative" CHECK ("decimals" >= 0),
	CONSTRAINT "asset_representations_identity_matches_type" CHECK ((
        "type" = 'native'
        and "contract_address" is null
        and "mint_address" is null
      ) or (
        "type" in ('token', 'nft')
        and num_nonnulls("contract_address", "mint_address") = 1
      ))
);
--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_blockchain_id_blockchains_id_fkey";--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "unique_token_idx";--> statement-breakpoint
DROP INDEX "asset_coingecko_coin_id_idx";--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "asset_type";--> statement-breakpoint
CREATE TYPE "asset_type" AS ENUM('fungible', 'nft');--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE "asset_type" USING "type"::"asset_type";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DEFAULT 'fungible'::"asset_type";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" DROP COLUMN "canonical_asset_symbol";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "blockchain_id";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "contract_address";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "decimals";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "is_spam";--> statement-breakpoint
DROP INDEX "idx_transfers_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transfers_unique" ON "transfers" ("tx_hash","address_id","type","from_address","to_address","asset_id","asset_representation_id") WHERE "tx_hash" is not null and "address_id" is not null and "from_address" is not null and "to_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representations_native_blockchain_unique_idx" ON "asset_representations" ("blockchain_id") WHERE "type" = 'native';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representations_contract_unique_idx" ON "asset_representations" ("blockchain_id",lower("contract_address")) WHERE "contract_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representations_mint_unique_idx" ON "asset_representations" ("blockchain_id","mint_address") WHERE "mint_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representations_asset_id_id_unique_idx" ON "asset_representations" ("asset_id","id");--> statement-breakpoint
CREATE INDEX "idx_asset_representations_asset" ON "asset_representations" ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_asset_representations_blockchain" ON "asset_representations" ("blockchain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_coingecko_coin_id_unique_idx" ON "assets" ("coingecko_coin_id");--> statement-breakpoint
ALTER TABLE "asset_representations" ADD CONSTRAINT "asset_representations_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "asset_representations" ADD CONSTRAINT "asset_representations_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_representation_matches_asset_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_representation_matches_asset_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_representation_matches_asset_fk" FOREIGN KEY ("canonical_asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_representation_matches_asset_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_representation_matches_asset_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_kind_requires_target" CHECK ((
        "mapping_kind" = 'asset'
        and "canonical_asset_id" is not null
      ) or (
        "mapping_kind" = 'fiat'
        and "canonical_fiat_currency" is not null
      ) or "mapping_status" in ('pending_review', 'rejected'));--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_representation_requires_asset" CHECK ("asset_representation_id" is null or "canonical_asset_id" is not null);