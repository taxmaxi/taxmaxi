CREATE TABLE "provider_asset_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid NOT NULL,
	"provider_asset_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_asset_observations_raw_asset_unique" ON "provider_asset_observations" ("source_raw_record_id","provider_asset_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_observations_provider_asset" ON "provider_asset_observations" ("provider_asset_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_observations_source" ON "provider_asset_observations" ("source_id");--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_rE3r8ohMCriT_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_xvbN3oHcGsuz_fkey" FOREIGN KEY ("provider_asset_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;