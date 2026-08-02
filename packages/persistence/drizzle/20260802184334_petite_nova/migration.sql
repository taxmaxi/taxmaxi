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
);--> statement-breakpoint
CREATE TEMPORARY TABLE "asset_migration_map" (
	"old_asset_id" uuid PRIMARY KEY,
	"canonical_asset_id" uuid NOT NULL,
	"asset_representation_id" uuid,
	"blockchain_id" uuid NOT NULL,
	"representation_key" text,
	"old_type" text NOT NULL
) ON COMMIT DROP;--> statement-breakpoint
INSERT INTO "asset_migration_map" (
	"old_asset_id",
	"canonical_asset_id",
	"blockchain_id",
	"representation_key",
	"old_type"
)
SELECT
	"id",
	first_value("id") OVER (
		PARTITION BY CASE
			WHEN "coingecko_coin_id" IS NOT NULL THEN 'coingecko:' || lower("coingecko_coin_id")
			ELSE 'asset:' || "id"::text
		END
		ORDER BY "created_at", "id"
	),
	"blockchain_id",
	CASE
		WHEN "type" = 'native' THEN "blockchain_id"::text || ':native'
		WHEN "contract_address" IS NOT NULL THEN "blockchain_id"::text || ':address:' || lower("contract_address")
		ELSE NULL
	END,
	"type"::text
FROM "assets";--> statement-breakpoint
WITH "representation_ids" AS (
	SELECT "representation_key", gen_random_uuid() AS "id"
	FROM "asset_migration_map"
	WHERE "representation_key" IS NOT NULL
	GROUP BY "representation_key"
)
UPDATE "asset_migration_map" AS "mapping"
SET "asset_representation_id" = "representation_ids"."id"
FROM "representation_ids"
WHERE "mapping"."representation_key" = "representation_ids"."representation_key";--> statement-breakpoint
INSERT INTO "asset_representations" (
	"id",
	"asset_id",
	"blockchain_id",
	"type",
	"contract_address",
	"mint_address",
	"decimals",
	"logo_url",
	"is_spam",
	"metadata",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON ("mapping"."asset_representation_id")
	"mapping"."asset_representation_id",
	"mapping"."canonical_asset_id",
	"asset"."blockchain_id",
	"asset"."type"::text::"asset_representation_type",
	CASE WHEN "blockchain"."chain_type" = 'solana' THEN NULL ELSE lower("asset"."contract_address") END,
	CASE WHEN "blockchain"."chain_type" = 'solana' THEN "asset"."contract_address" ELSE NULL END,
	"asset"."decimals",
	"asset"."logo_url",
	"asset"."is_spam",
	jsonb_build_object('source', 'asset-schema-roll-forward', 'previousAssetId', "asset"."id"),
	"asset"."created_at",
	"asset"."updated_at"
FROM "asset_migration_map" AS "mapping"
JOIN "assets" AS "asset" ON "asset"."id" = "mapping"."old_asset_id"
JOIN "blockchains" AS "blockchain" ON "blockchain"."id" = "asset"."blockchain_id"
WHERE "mapping"."asset_representation_id" IS NOT NULL
ORDER BY "mapping"."asset_representation_id", "asset"."created_at", "asset"."id";--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "asset_representation_id" uuid;--> statement-breakpoint
UPDATE "transfers" AS "transfer"
SET
	"asset_id" = "mapping"."canonical_asset_id",
	"asset_representation_id" = CASE
		WHEN "transfer"."blockchain_id" = "mapping"."blockchain_id" THEN "mapping"."asset_representation_id"
		ELSE NULL
	END
FROM "asset_migration_map" AS "mapping"
WHERE "transfer"."asset_id" = "mapping"."old_asset_id";--> statement-breakpoint
UPDATE "transaction_legs" AS "leg"
SET
	"asset_id" = "mapping"."canonical_asset_id",
	"asset_representation_id" = CASE
		WHEN "source"."sourceable_type" IN ('onchain', 'dex') THEN "mapping"."asset_representation_id"
		ELSE NULL
	END
FROM "asset_migration_map" AS "mapping", "sources" AS "source"
WHERE "leg"."asset_id" = "mapping"."old_asset_id"
	AND "leg"."source_id" = "source"."id";--> statement-breakpoint
UPDATE "fifo_lots" AS "lot"
SET
	"asset_id" = "mapping"."canonical_asset_id",
	"asset_representation_id" = CASE
		WHEN "source"."sourceable_type" IN ('onchain', 'dex') THEN "mapping"."asset_representation_id"
		ELSE NULL
	END
FROM "asset_migration_map" AS "mapping", "sources" AS "source"
WHERE "lot"."asset_id" = "mapping"."old_asset_id"
	AND "lot"."source_id" = "source"."id";--> statement-breakpoint
UPDATE "inventory_movements" AS "movement"
SET
	"asset_id" = "mapping"."canonical_asset_id",
	"asset_representation_id" = CASE
		WHEN "source"."sourceable_type" IN ('onchain', 'dex') THEN "mapping"."asset_representation_id"
		ELSE NULL
	END
FROM "asset_migration_map" AS "mapping", "sources" AS "source"
WHERE "movement"."asset_id" = "mapping"."old_asset_id"
	AND "movement"."source_id" = "source"."id";--> statement-breakpoint
UPDATE "provider_asset_mappings" AS "provider_mapping"
SET
	"canonical_asset_id" = "mapping"."canonical_asset_id",
	"asset_representation_id" = CASE
		WHEN "provider_asset"."provider" = 'helius-solana' THEN "mapping"."asset_representation_id"
		ELSE NULL
	END
FROM "asset_migration_map" AS "mapping", "provider_assets" AS "provider_asset"
WHERE "provider_mapping"."canonical_asset_id" = "mapping"."old_asset_id"
	AND "provider_mapping"."provider_asset_row_id" = "provider_asset"."id";--> statement-breakpoint
WITH "ranked_prices" AS (
	SELECT
		"price"."id",
		row_number() OVER (
			PARTITION BY "mapping"."canonical_asset_id", "price"."timestamp", "price"."currency"
			ORDER BY
				("price"."asset_id" = "mapping"."canonical_asset_id") DESC,
				"price"."updated_at" DESC,
				"price"."id"
		) AS "row_number"
	FROM "asset_prices" AS "price"
	JOIN "asset_migration_map" AS "mapping" ON "mapping"."old_asset_id" = "price"."asset_id"
)
DELETE FROM "asset_prices" AS "price"
USING "ranked_prices"
WHERE "price"."id" = "ranked_prices"."id"
	AND "ranked_prices"."row_number" > 1;--> statement-breakpoint
UPDATE "asset_prices" AS "price"
SET "asset_id" = "mapping"."canonical_asset_id"
FROM "asset_migration_map" AS "mapping"
WHERE "price"."asset_id" = "mapping"."old_asset_id";--> statement-breakpoint
UPDATE "transaction_onchain_context" AS "context"
SET "fee_asset_id" = "mapping"."canonical_asset_id"
FROM "asset_migration_map" AS "mapping"
WHERE "context"."fee_asset_id" = "mapping"."old_asset_id";--> statement-breakpoint
WITH "symbol_targets" AS (
	SELECT
		upper("asset"."symbol") AS "symbol",
		min("mapping"."canonical_asset_id"::text)::uuid AS "canonical_asset_id"
	FROM "assets" AS "asset"
	JOIN "asset_migration_map" AS "mapping" ON "mapping"."old_asset_id" = "asset"."id"
	GROUP BY upper("asset"."symbol")
	HAVING count(DISTINCT "mapping"."canonical_asset_id") = 1
)
UPDATE "provider_asset_mappings" AS "provider_mapping"
SET "canonical_asset_id" = "symbol_targets"."canonical_asset_id"
FROM "symbol_targets"
WHERE "provider_mapping"."canonical_asset_id" IS NULL
	AND upper("provider_mapping"."canonical_asset_symbol") = "symbol_targets"."symbol";--> statement-breakpoint
UPDATE "provider_asset_mappings"
SET
	"mapping_status" = 'pending_review',
	"source_notes" = concat_ws(' ', "source_notes", 'Existing asset symbol could not be matched to one economic asset during the asset schema migration.')
WHERE "mapping_kind" = 'asset'
	AND "canonical_asset_id" IS NULL
	AND "mapping_status" = 'approved';--> statement-breakpoint
DELETE FROM "assets" AS "asset"
USING "asset_migration_map" AS "mapping"
WHERE "asset"."id" = "mapping"."old_asset_id"
	AND "mapping"."old_asset_id" <> "mapping"."canonical_asset_id";--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_blockchain_id_blockchains_id_fkey";--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "unique_token_idx";--> statement-breakpoint
DROP INDEX "asset_coingecko_coin_id_idx";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
UPDATE "assets" SET "type" = 'fungible' WHERE "type" IN ('native', 'token');--> statement-breakpoint
DROP TYPE "asset_type";--> statement-breakpoint
CREATE TYPE "asset_type" AS ENUM('fungible', 'nft');--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE "asset_type" USING "type"::"asset_type";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DEFAULT 'fungible'::"asset_type";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" DROP CONSTRAINT "provider_asset_mappings_kind_requires_target";--> statement-breakpoint
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
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_representation_requires_asset" CHECK ("asset_representation_id" is null or "canonical_asset_id" is not null);--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_kind_requires_target" CHECK ((
        "mapping_kind" = 'asset'
        and "canonical_asset_id" is not null
      ) or (
        "mapping_kind" = 'fiat'
        and "canonical_fiat_currency" is not null
      ) or "mapping_status" in ('pending_review', 'rejected'));
