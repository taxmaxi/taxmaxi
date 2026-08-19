CREATE TABLE "asset_resolution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"evidence_revision" integer NOT NULL,
	"status" "job_status" DEFAULT 'pending'::"job_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_resolution_jobs_evidence_revision_positive" CHECK ("evidence_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_assets" ADD COLUMN "evidence_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_jobs_observation_revision_unique" ON "asset_resolution_jobs" ("provider_asset_row_id","evidence_revision");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_jobs_status" ON "asset_resolution_jobs" ("status");--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD CONSTRAINT "asset_resolution_jobs_VHrqXS8DXhzo_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_assets" ADD CONSTRAINT "provider_assets_evidence_revision_positive" CHECK ("evidence_revision" > 0);