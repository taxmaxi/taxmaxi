CREATE TABLE "principal_asset_override_applications" (
	"override_id" uuid,
	"source_id" uuid,
	"processing_job_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_asset_override_applications_pkey" PRIMARY KEY("override_id","source_id")
);
--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_source" ON "principal_asset_override_applications" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_job" ON "principal_asset_override_applications" ("processing_job_id");--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_0WXg3aRBVFsR_fkey" FOREIGN KEY ("override_id") REFERENCES "principal_asset_overrides"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_j1nbN1NiKOcf_fkey" FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;