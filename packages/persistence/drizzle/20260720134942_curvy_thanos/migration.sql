CREATE TABLE "principal_replay_transfer_reconciliation_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"provider_source_id" uuid NOT NULL,
	"provider_transfer_identity" text NOT NULL,
	"canonical_transfer_source_id" uuid,
	"canonical_transfer_identity" text,
	"canonical_transaction_source_id" uuid,
	"canonical_transaction_identity" text,
	"status" "transfer_reconciliation_status" NOT NULL,
	"match_reason" text NOT NULL,
	"confidence" numeric(5,4) NOT NULL,
	"deterministic" boolean NOT NULL,
	"review_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_replay_transfer_reconciliation_snapshots_reviewed_status" CHECK ("status" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "principal_replay_transfer_reconciliation_snapshots_run_identity_unique" ON "principal_replay_transfer_reconciliation_snapshots" ("run_id","provider_source_id","provider_transfer_identity");--> statement-breakpoint
CREATE INDEX "idx_principal_replay_transfer_reconciliation_snapshots_run_id" ON "principal_replay_transfer_reconciliation_snapshots" ("run_id");--> statement-breakpoint
ALTER TABLE "principal_replay_transfer_reconciliation_snapshots" ADD CONSTRAINT "qwXM3iy8i0IL_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_replay_transfer_reconciliation_snapshots" ADD CONSTRAINT "2BlkKcazLvU5_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;