CREATE TYPE "sync_run_mode" AS ENUM('sync', 'replay');--> statement-breakpoint
CREATE TABLE "principal_replay_review_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"transaction_identity" text NOT NULL,
	"review_status" "review_status" NOT NULL,
	"original_type_key" text,
	"original_confidence" numeric(3,2),
	"current_type_key" text,
	"legal_rule_set_version" text,
	"categorization_reason" text,
	"matched_layer" text,
	"needs_review" boolean NOT NULL,
	"user_notes" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "is_coordinator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "mode" "sync_run_mode" DEFAULT 'sync'::"sync_run_mode" NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_replay_review_snapshots_run_identity_unique" ON "principal_replay_review_snapshots" ("run_id","source_id","transaction_identity");--> statement-breakpoint
CREATE INDEX "idx_principal_replay_review_snapshots_run_id" ON "principal_replay_review_snapshots" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_active_principal_replay_unique" ON "sync_runs" ("principal_id") WHERE "mode" = 'replay' and "status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "principal_replay_review_snapshots" ADD CONSTRAINT "principal_replay_review_snapshots_run_id_sync_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_replay_review_snapshots" ADD CONSTRAINT "principal_replay_review_snapshots_vnkUxGYvntFC_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;