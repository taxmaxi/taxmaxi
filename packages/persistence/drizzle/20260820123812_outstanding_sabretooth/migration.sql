CREATE TYPE "asset_resolution_decision_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "asset_resolution_outcome" AS ENUM('attach', 'pending', 'fail_closed');--> statement-breakpoint
CREATE TABLE "asset_representation_ownership_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"asset_representation_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"status" "asset_resolution_decision_status" DEFAULT 'active'::"asset_resolution_decision_status" NOT NULL,
	"supersedes_decision_id" uuid,
	"policy_revision" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_resolution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"evidence_revision" integer NOT NULL,
	"policy_revision" text NOT NULL,
	"outcome" "asset_resolution_outcome" NOT NULL,
	"status" "asset_resolution_decision_status" DEFAULT 'active'::"asset_resolution_decision_status" NOT NULL,
	"supersedes_decision_id" uuid,
	"asset_id" uuid,
	"asset_representation_id" uuid,
	"blockchain" text,
	"representation_type" text,
	"contract_address" text,
	"mint_address" text,
	"decimals" integer,
	"reason" text,
	"actor" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_resolution_decisions_evidence_revision_positive" CHECK ("evidence_revision" > 0),
	CONSTRAINT "asset_resolution_decisions_attach_requires_target" CHECK ("outcome" <> 'attach' or ("asset_id" is not null and "asset_representation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "asset_resolution_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"decision_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"claim_kind" text NOT NULL,
	"source_locator" text,
	"retrieved_at" timestamp NOT NULL,
	"evidence_revision" integer NOT NULL,
	"decoded_claim" jsonb,
	"raw_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_resolution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"evidence_revision" integer NOT NULL,
	"status" "job_status" DEFAULT 'pending'::"job_status" NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"started_at" timestamp,
	"heartbeat_at" timestamp,
	"next_retry_at" timestamp,
	"worker_id" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_resolution_jobs_evidence_revision_positive" CHECK ("evidence_revision" > 0),
	CONSTRAINT "asset_resolution_jobs_attempt_count_non_negative" CHECK ("attempt_count" >= 0),
	CONSTRAINT "asset_resolution_jobs_max_attempts_positive" CHECK ("max_attempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_assets" ADD COLUMN "evidence_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_active_unique" ON "asset_representation_ownership_decisions" ("asset_representation_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_supersedes_unique" ON "asset_representation_ownership_decisions" ("supersedes_decision_id") WHERE "supersedes_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_asset_representation_ownership_asset_id" ON "asset_representation_ownership_decisions" ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_active_observation_revision_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","evidence_revision") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_supersedes_unique" ON "asset_resolution_decisions" ("supersedes_decision_id") WHERE "supersedes_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_decisions_asset_id" ON "asset_resolution_decisions" ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_evidence_decision_authority_claim_unique" ON "asset_resolution_evidence" ("decision_id","authority","claim_kind");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_evidence_decision_id" ON "asset_resolution_evidence" ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_jobs_observation_revision_unique" ON "asset_resolution_jobs" ("provider_asset_row_id","evidence_revision");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_jobs_status" ON "asset_resolution_jobs" ("status");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_jobs_heartbeat_at" ON "asset_resolution_jobs" ("heartbeat_at");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_owner_matches_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_supersedes_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "asset_representation_ownership_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_z5wvnNDSeDWF_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_QbAUryyGxFkm_fkey" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_supersedes_decision_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "asset_resolution_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_evidence" ADD CONSTRAINT "asset_resolution_evidence_13op32dmB3hM_fkey" FOREIGN KEY ("decision_id") REFERENCES "asset_resolution_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD CONSTRAINT "asset_resolution_jobs_VHrqXS8DXhzo_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_assets" ADD CONSTRAINT "provider_assets_evidence_revision_positive" CHECK ("evidence_revision" > 0);