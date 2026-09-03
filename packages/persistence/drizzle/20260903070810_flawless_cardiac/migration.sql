ALTER TABLE "calculation_run_blockers" ADD COLUMN "provider_asset_row_id" uuid;--> statement-breakpoint
ALTER TABLE "calculation_run_blockers" ALTER COLUMN "asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_run_blockers" ADD CONSTRAINT "calculation_run_blockers_DSx7wqqyVAYZ_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_blockers" ADD CONSTRAINT "calculation_run_blockers_target_link_required" CHECK ("asset_id" is not null or "provider_asset_row_id" is not null);