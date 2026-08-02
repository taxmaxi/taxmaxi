ALTER TABLE "processing_jobs" ADD COLUMN "follow_up_mode" "job_mode";--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "follow_up_job_id" uuid;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_follow_up_job_id_fk" FOREIGN KEY ("follow_up_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;