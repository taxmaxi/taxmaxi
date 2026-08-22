ALTER TABLE "principal_asset_overrides" ADD COLUMN "inspected_inclusion_reason" text;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" DROP CONSTRAINT "principal_asset_overrides_inspected_conclusion_matches_kind", ADD CONSTRAINT "principal_asset_overrides_inspected_conclusion_matches_kind" CHECK ((
        "kind" = 'identity'
        and "inspected_identity_state" is not null
        and "inspected_inclusion_state" is null
        and "inspected_inclusion_reason" is null
      ) or (
        "kind" = 'inclusion'
        and "inspected_identity_state" is null
        and "inspected_inclusion_state" is not null
        and "inspected_asset_id" is null
      ));