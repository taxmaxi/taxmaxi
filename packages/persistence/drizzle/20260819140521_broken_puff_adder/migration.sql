ALTER TYPE "job_status" ADD VALUE 'credit_required';--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "credit_reason_code" text;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "credits_available" integer;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "credits_consumed" integer;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "additional_credits_required" integer;