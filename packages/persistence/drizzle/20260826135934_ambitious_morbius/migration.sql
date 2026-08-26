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
ALTER TABLE "asset_representation_ownership_decisions" DROP COLUMN "status";--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_record_unique" ON "asset_representation_ownership_decisions" ("asset_representation_id","asset_id","policy_revision") WHERE "supersedes_decision_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_policy_evaluation_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","evidence_revision","policy_revision") WHERE "human_claim" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_provider_id_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_decisions_9YVjItPMGEXN_fkey" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_lrqfOBAPkLcX_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_Kdbpd4S2hgX1_fkey" FOREIGN KEY ("current_conclusion_id") REFERENCES "asset_resolution_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_state_fXBYBFHYv8zf_fkey" FOREIGN KEY ("current_policy_evaluation_id") REFERENCES "asset_resolution_decisions"("id");--> statement-breakpoint
INSERT INTO "asset_resolution_current_state" (
  "provider_asset_row_id",
  "current_conclusion_id",
  "current_policy_evaluation_id"
)
SELECT
  provider_asset.id,
  coalesce(human_conclusion.id, automatic_conclusion.id),
  policy_evaluation.id
FROM "provider_assets" provider_asset
LEFT JOIN LATERAL (
  SELECT decision.id
  FROM "asset_resolution_decisions" decision
  WHERE decision.provider_asset_row_id = provider_asset.id
    AND decision.status = 'active'
    AND decision.human_claim IS NOT NULL
  ORDER BY decision.created_at DESC, decision.id DESC
  LIMIT 1
) human_conclusion ON true
LEFT JOIN LATERAL (
  SELECT decision.id
  FROM "asset_resolution_decisions" decision
  WHERE decision.provider_asset_row_id = provider_asset.id
    AND decision.status = 'active'
    AND decision.human_claim IS NULL
    AND decision.outcome NOT IN ('pending', 'fail_closed')
  ORDER BY decision.evidence_revision DESC, decision.created_at DESC, decision.id DESC
  LIMIT 1
) automatic_conclusion ON true
LEFT JOIN LATERAL (
  SELECT decision.id
  FROM "asset_resolution_decisions" decision
  WHERE decision.provider_asset_row_id = provider_asset.id
    AND decision.human_claim IS NULL
    AND decision.evidence_revision = provider_asset.evidence_revision
  ORDER BY decision.created_at DESC, decision.id DESC
  LIMIT 1
) policy_evaluation ON true
WHERE human_conclusion.id IS NOT NULL
   OR automatic_conclusion.id IS NOT NULL
   OR policy_evaluation.id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_conclusion_observation_fk" FOREIGN KEY ("provider_asset_row_id","current_conclusion_id") REFERENCES "asset_resolution_decisions"("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "asset_resolution_current_state" ADD CONSTRAINT "asset_resolution_current_policy_evaluation_observation_fk" FOREIGN KEY ("provider_asset_row_id","current_policy_evaluation_id") REFERENCES "asset_resolution_decisions"("provider_asset_row_id","id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER CONSTRAINT "provider_asset_mappings_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;
