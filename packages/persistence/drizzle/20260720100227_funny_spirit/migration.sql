ALTER TABLE "provider_asset_mappings" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_reviewed_by_users_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id");