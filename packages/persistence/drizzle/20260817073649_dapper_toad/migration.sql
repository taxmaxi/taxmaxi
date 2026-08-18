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
CREATE UNIQUE INDEX "provider_asset_review_replays_asset_source_unique" ON "provider_asset_review_replays" ("provider_asset_row_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_review_replays_job" ON "provider_asset_review_replays" ("job_id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_reviewed_by_users_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD CONSTRAINT "provider_asset_review_replays_ak41kmSR0zhO_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;
