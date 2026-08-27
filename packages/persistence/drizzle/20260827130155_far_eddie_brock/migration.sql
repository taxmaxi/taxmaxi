CREATE TABLE "source_representation_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"blockchain_id" uuid NOT NULL,
	"representation_type" "asset_representation_type" NOT NULL,
	"contract_address" text,
	"mint_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_representation_uses_identity_matches_type" CHECK ((
        "representation_type" = 'native'
        and "contract_address" is null
        and "mint_address" is null
      ) or (
        "representation_type" in ('token', 'nft')
        and num_nonnulls("contract_address", "mint_address") = 1
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_native_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id") WHERE "representation_type" = 'native';--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_contract_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id","representation_type","contract_address") WHERE "contract_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_mint_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id","representation_type","mint_address") WHERE "mint_address" is not null;--> statement-breakpoint
CREATE INDEX "idx_source_representation_uses_source" ON "source_representation_uses" ("source_id");--> statement-breakpoint
INSERT INTO "source_representation_uses" (
	"source_id",
	"blockchain_id",
	"representation_type",
	"contract_address",
	"mint_address"
)
SELECT DISTINCT
	"source_id",
	"observed_blockchain_id",
	"observed_representation_type",
	CASE
		WHEN "observed_contract_address" ~ '^0x[0-9a-fA-F]{40}$'
			THEN lower("observed_contract_address")
		ELSE "observed_contract_address"
	END,
	CASE
		WHEN "observed_mint_address" ~ '^0x[0-9a-fA-F]{40}$'
			THEN lower("observed_mint_address")
		ELSE "observed_mint_address"
	END
FROM "provider_transfers"
WHERE "observed_blockchain_id" IS NOT NULL
	AND "observed_representation_type" IS NOT NULL
	AND (
		(
			"observed_representation_type" = 'native'
			AND "observed_contract_address" IS NULL
			AND "observed_mint_address" IS NULL
		) OR (
			"observed_representation_type" IN ('token', 'nft')
			AND num_nonnulls("observed_contract_address", "observed_mint_address") = 1
		)
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "source_representation_uses" ADD CONSTRAINT "source_representation_uses_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_representation_uses" ADD CONSTRAINT "source_representation_uses_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");
