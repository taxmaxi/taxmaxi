CREATE TABLE "principal_asset_override_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"override_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"replay_job_id" uuid,
	"requires_replay" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_applications_override_source_unique" ON "principal_asset_override_applications" ("override_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_source_active" ON "principal_asset_override_applications" ("source_id","superseded_at");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_replay_job" ON "principal_asset_override_applications" ("replay_job_id");--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_0WXg3aRBVFsR_fkey" FOREIGN KEY ("override_id") REFERENCES "principal_asset_overrides"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_VvSwSMmYpRl5_fkey" FOREIGN KEY ("replay_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;