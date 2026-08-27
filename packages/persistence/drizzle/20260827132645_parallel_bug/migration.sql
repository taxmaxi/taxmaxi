CREATE TABLE "asset_resolution_current_state" (
	"provider_asset_row_id" uuid PRIMARY KEY,
	"current_conclusion_id" uuid,
	"current_policy_evaluation_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" DROP CONSTRAINT "asset_representation_ownership_owner_matches_fk";--> statement-breakpoint
DROP INDEX "asset_representation_ownership_active_unique";--> statement-breakpoint
DROP INDEX "asset_resolution_decisions_active_observation_revision_unique";--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ADD COLUMN "policy_revision" text;--> statement-breakpoint
-- Every existing job was scheduled under the only resolution policy
-- revision that has existed so far.
UPDATE "asset_resolution_jobs" SET "policy_revision" = '2026-08-26.standalone-positive-signal.1';--> statement-breakpoint
ALTER TABLE "asset_resolution_jobs" ALTER COLUMN "policy_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" DROP COLUMN "status";--> statement-breakpoint
DROP INDEX "asset_resolution_jobs_observation_revision_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_jobs_observation_revision_unique" ON "asset_resolution_jobs" ("provider_asset_row_id","evidence_revision","policy_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_record_unique" ON "asset_representation_ownership_decisions" ("asset_representation_id") WHERE "supersedes_decision_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_representation_id_unique" ON "asset_representation_ownership_decisions" ("asset_representation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_policy_evaluation_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","evidence_revision","policy_revision") WHERE "human_claim" is null and "supersedes_decision_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_provider_id_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_decisions_9YVjItPMGEXN_fkey" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_lrqfOBAPkLcX_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_Kdbpd4S2hgX1_fkey" FOREIGN KEY ("current_conclusion_id") REFERENCES "asset_resolution_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_fXBYBFHYv8zf_fkey" FOREIGN KEY ("current_policy_evaluation_id") REFERENCES "asset_resolution_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_conclusion_observation_fk" FOREIGN KEY ("provider_asset_row_id","current_conclusion_id") REFERENCES "asset_resolution_decisions"("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_policy_evaluation_observation_fk" FOREIGN KEY ("provider_asset_row_id","current_policy_evaluation_id") REFERENCES "asset_resolution_decisions"("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" DROP CONSTRAINT "asset_representation_ownership_supersedes_fk", ADD CONSTRAINT "asset_representation_ownership_supersedes_fk" FOREIGN KEY ("asset_representation_id","supersedes_decision_id") REFERENCES "asset_representation_ownership_decisions"("asset_representation_id","id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" DROP CONSTRAINT "asset_resolution_decisions_supersedes_decision_id_fk", ADD CONSTRAINT "asset_resolution_decisions_supersedes_decision_id_fk" FOREIGN KEY ("provider_asset_row_id","supersedes_decision_id") REFERENCES "asset_resolution_decisions"("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" DROP CONSTRAINT "asset_resolution_decisions_approval_requires_target", ADD CONSTRAINT "asset_resolution_decisions_approval_requires_target" CHECK ("outcome"::text not in ('attach', 'create_standalone') or ("asset_id" is not null and ("blockchain" is null or "asset_representation_id" is not null)) or ("human_claim" is null and "actor" = 'system:asset-resolution-policy'));--> statement-breakpoint
DROP TYPE "asset_resolution_decision_status";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER CONSTRAINT "provider_asset_mappings_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transfers" ALTER CONSTRAINT "transfers_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transaction_legs" ALTER CONSTRAINT "transaction_legs_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER CONSTRAINT "inventory_movements_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "fifo_lots" ALTER CONSTRAINT "fifo_lots_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;
