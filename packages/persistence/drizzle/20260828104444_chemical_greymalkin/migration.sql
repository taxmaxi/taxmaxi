DROP INDEX "idx_processing_jobs_queue_job";--> statement-breakpoint
DROP INDEX "processing_jobs_queue_job_unique";--> statement-breakpoint
ALTER TABLE "processing_jobs" DROP COLUMN "queue_name";--> statement-breakpoint
ALTER TABLE "processing_jobs" DROP COLUMN "queue_job_id";--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_pending_next_retry" ON "processing_jobs" ("status","next_retry_at") WHERE "status" = 'pending';