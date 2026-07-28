CREATE TABLE "provider_asset_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid NOT NULL,
	"provider_asset_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_asset_review_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_native_blockchain_unique" ON "assets" ("blockchain_id") WHERE "contract_address" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_asset_observations_raw_asset_unique" ON "provider_asset_observations" ("source_raw_record_id","provider_asset_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_observations_provider_asset" ON "provider_asset_observations" ("provider_asset_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_observations_source" ON "provider_asset_observations" ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_asset_review_replays_asset_source_unique" ON "provider_asset_review_replays" ("provider_asset_row_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_review_replays_job" ON "provider_asset_review_replays" ("job_id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_reviewed_by_users_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_rE3r8ohMCriT_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_observations" ADD CONSTRAINT "provider_asset_observations_xvbN3oHcGsuz_fkey" FOREIGN KEY ("provider_asset_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD CONSTRAINT "provider_asset_review_replays_ak41kmSR0zhO_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD CONSTRAINT "provider_asset_review_replays_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD CONSTRAINT "provider_asset_review_replays_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD CONSTRAINT "provider_asset_review_replays_job_id_processing_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id") ON DELETE CASCADE;