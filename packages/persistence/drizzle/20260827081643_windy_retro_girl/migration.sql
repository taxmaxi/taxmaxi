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
ALTER TABLE "asset_resolution_decisions" DROP COLUMN "status";--> statement-breakpoint
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
INSERT INTO "asset_resolution_decisions" (
  "provider_asset_row_id",
  "evidence_revision",
  "policy_revision",
  "outcome",
  "asset_id",
  "asset_representation_id",
  "reason",
  "actor"
)
SELECT
  provider_asset.id,
  provider_asset.evidence_revision,
  'legacy.trusted-provider-mapping.1',
  CASE
    WHEN mapping.mapping_status = 'excluded' THEN 'excluded'::asset_resolution_outcome
    ELSE 'attach'::asset_resolution_outcome
  END,
  mapping.canonical_asset_id,
  mapping.asset_representation_id,
  CASE
    WHEN mapping.mapping_status = 'excluded' THEN 'trusted_provider_exclusion'
    ELSE NULL
  END,
  'system:trusted-provider-mapping-backfill'
FROM "provider_asset_mappings" mapping
INNER JOIN "provider_assets" provider_asset
  ON provider_asset.id = mapping.provider_asset_row_id
WHERE mapping.mapping_kind = 'asset'
  AND (
    mapping.mapping_status = 'excluded'
    OR (mapping.mapping_status = 'approved' AND mapping.canonical_asset_id IS NOT NULL)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "asset_resolution_decisions" decision
    WHERE decision.provider_asset_row_id = mapping.provider_asset_row_id
      AND decision.outcome NOT IN ('pending', 'fail_closed')
  );--> statement-breakpoint
INSERT INTO "asset_resolution_evidence" (
  "decision_id",
  "authority",
  "claim_kind",
  "source_locator",
  "retrieved_at",
  "evidence_revision",
  "decoded_claim",
  "raw_payload"
)
SELECT
  decision.id,
  'trusted_provider_mapping',
  'mapping_conclusion',
  'taxmaxi://provider-assets/' || provider_asset.id::text || '/trusted-mapping',
  provider_asset.retrieved_at,
  provider_asset.evidence_revision,
  jsonb_build_object(
    'mappingKind', mapping.mapping_kind,
    'mappingStatus', mapping.mapping_status,
    'canonicalAssetId', mapping.canonical_asset_id,
    'assetRepresentationId', mapping.asset_representation_id,
    'sourceNotes', mapping.source_notes
  ),
  to_jsonb(mapping)
FROM "asset_resolution_decisions" decision
INNER JOIN "provider_assets" provider_asset
  ON provider_asset.id = decision.provider_asset_row_id
INNER JOIN "provider_asset_mappings" mapping
  ON mapping.provider_asset_row_id = decision.provider_asset_row_id
WHERE decision.policy_revision = 'legacy.trusted-provider-mapping.1'
  AND decision.actor = 'system:trusted-provider-mapping-backfill'
  AND NOT EXISTS (
    SELECT 1
    FROM "asset_resolution_evidence" evidence
    WHERE evidence.decision_id = decision.id
  );--> statement-breakpoint
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
    AND decision.human_claim IS NOT NULL
  ORDER BY decision.created_at DESC, decision.id DESC
  LIMIT 1
) human_conclusion ON true
LEFT JOIN LATERAL (
  SELECT decision.id
  FROM "asset_resolution_decisions" decision
  WHERE decision.provider_asset_row_id = provider_asset.id
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
    AND decision.supersedes_decision_id IS NULL
    AND decision.evidence_revision = provider_asset.evidence_revision
  ORDER BY
    CASE WHEN decision.policy_revision = 'legacy.trusted-provider-mapping.1' THEN 1 ELSE 0 END,
    decision.created_at DESC,
    decision.id DESC
  LIMIT 1
) policy_evaluation ON true
WHERE human_conclusion.id IS NOT NULL
   OR automatic_conclusion.id IS NOT NULL
   OR policy_evaluation.id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER CONSTRAINT "provider_asset_mappings_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transfers" ALTER CONSTRAINT "transfers_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transaction_legs" ALTER CONSTRAINT "transaction_legs_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER CONSTRAINT "inventory_movements_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "fifo_lots" ALTER CONSTRAINT "fifo_lots_representation_matches_asset_fk" DEFERRABLE INITIALLY DEFERRED;