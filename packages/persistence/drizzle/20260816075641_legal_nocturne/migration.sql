CREATE TABLE "provider_asset_source_uses" (
	"provider_asset_row_id" uuid,
	"source_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_asset_source_uses_pkey" PRIMARY KEY("provider_asset_row_id","source_id")
);
--> statement-breakpoint
CREATE INDEX "idx_provider_asset_source_uses_source" ON "provider_asset_source_uses" ("source_id");--> statement-breakpoint
ALTER TABLE "provider_asset_source_uses" ADD CONSTRAINT "provider_asset_source_uses_QG8VOjaj7Uvp_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_source_uses" ADD CONSTRAINT "provider_asset_source_uses_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "provider_asset_source_uses" ("provider_asset_row_id", "source_id")
SELECT DISTINCT "provider_asset_id", "source_id"
FROM "provider_transfers"
WHERE "provider_asset_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "provider_asset_source_uses" ("provider_asset_row_id", "source_id")
SELECT DISTINCT "provider_assets"."id", "transactions"."source_id"
FROM "provider_assets"
INNER JOIN "provider_asset_mappings"
	ON "provider_asset_mappings"."provider_asset_row_id" = "provider_assets"."id"
INNER JOIN "sources"
	ON "sources"."provider_key" = 'coinbase'
INNER JOIN "transactions"
	ON "transactions"."source_id" = "sources"."id"
INNER JOIN "transaction_reviews"
	ON "transaction_reviews"."transaction_id" = "transactions"."id"
WHERE "provider_assets"."provider" = 'coinbase'
	AND "provider_asset_mappings"."mapping_status" = 'pending_review'
	AND "transaction_reviews"."categorization_reason" LIKE '%provider_asset_mapping:%'
	AND upper("provider_assets"."currency_code") = ANY(
		string_to_array(
			upper(trim(trailing '.' FROM split_part(
				split_part("transaction_reviews"."categorization_reason", 'provider_asset_mapping:', 2),
				' for ',
				2
			))),
			', '
		)
	)
ON CONFLICT DO NOTHING;
