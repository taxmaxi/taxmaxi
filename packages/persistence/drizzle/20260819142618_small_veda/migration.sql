ALTER TABLE "asset_resolution_jobs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "next_retry_at" timestamp;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "error_message" text;--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_jobs_heartbeat_at" ON "asset_resolution_jobs" ("heartbeat_at");--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD CONSTRAINT "asset_resolution_jobs_attempt_count_non_negative" CHECK ("attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD CONSTRAINT "asset_resolution_jobs_max_attempts_positive" CHECK ("max_attempts" > 0);