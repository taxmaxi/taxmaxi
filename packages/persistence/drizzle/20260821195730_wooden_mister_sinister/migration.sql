CREATE TYPE "asset_rematerialization_status" AS ENUM('pending', 'running', 'complete', 'operator_attention');--> statement-breakpoint
ALTER TYPE "asset_resolution_outcome" ADD VALUE 'identity' BEFORE 'excluded';--> statement-breakpoint
CREATE TABLE "asset_decision_rematerializations" (
	"decision_id" uuid,
	"source_id" uuid,
	"processing_job_id" uuid,
	"status" "asset_rematerialization_status" DEFAULT 'pending'::"asset_rematerialization_status" NOT NULL,
	"failure_code" text,
	"last_failure_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_decision_rematerializations_pkey" PRIMARY KEY("decision_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "asset_resolution_decision_evidence_links" (
	"decision_id" uuid,
	"evidence_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_resolution_decision_evidence_links_pkey" PRIMARY KEY("decision_id","evidence_id")
);
--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD COLUMN "human_claim" jsonb;--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD COLUMN "rationale" text;--> statement-breakpoint
CREATE INDEX "idx_asset_decision_rematerializations_source" ON "asset_decision_rematerializations" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_asset_decision_rematerializations_status" ON "asset_decision_rematerializations" ("status");--> statement-breakpoint
ALTER TABLE "asset_decision_rematerializations" ADD CONSTRAINT "asset_decision_rematerializations_YSjlTCEOr6u4_fkey" FOREIGN KEY ("decision_id") REFERENCES "asset_resolution_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_decision_rematerializations" ADD CONSTRAINT "asset_decision_rematerializations_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_decision_rematerializations" ADD CONSTRAINT "asset_decision_rematerializations_7CJWRfWydXy0_fkey" FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "asset_resolution_decision_evidence_links" ADD CONSTRAINT "asset_resolution_decision_evidence_links_BBxNJFzQqlEL_fkey" FOREIGN KEY ("decision_id") REFERENCES "asset_resolution_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_decision_evidence_links" ADD CONSTRAINT "asset_resolution_decision_evidence_links_9d1io6Eys9OC_fkey" FOREIGN KEY ("evidence_id") REFERENCES "asset_resolution_evidence"("id");