CREATE TABLE "processing_job_dependencies" (
	"job_id" uuid,
	"prerequisite_job_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "processing_job_dependencies_pkey" PRIMARY KEY("job_id","prerequisite_job_id"),
	CONSTRAINT "processing_job_dependencies_not_self_referencing" CHECK ("job_id" <> "prerequisite_job_id")
);
--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "rebuild_from" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_processing_job_dependencies_prerequisite" ON "processing_job_dependencies" ("prerequisite_job_id");--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_job_id_processing_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_kAPD04USFjJR_fkey" FOREIGN KEY ("prerequisite_job_id") REFERENCES "processing_jobs"("id") ON DELETE CASCADE;