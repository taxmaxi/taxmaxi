CREATE TYPE "principal_asset_identity_state" AS ENUM('resolved', 'unresolved', 'excluded');--> statement-breakpoint
CREATE TYPE "principal_asset_inclusion_state" AS ENUM('included', 'excluded', 'blocked');--> statement-breakpoint
CREATE TYPE "principal_asset_override_action" AS ENUM('set', 'withdraw');--> statement-breakpoint
CREATE TYPE "principal_asset_override_kind" AS ENUM('identity', 'inclusion');--> statement-breakpoint
CREATE TYPE "principal_asset_override_target_kind" AS ENUM('representation', 'provider_asset');--> statement-breakpoint
CREATE TABLE "principal_asset_override_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"override_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"replay_job_id" uuid,
	"requires_replay" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal_asset_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"kind" "principal_asset_override_kind" NOT NULL,
	"target_kind" "principal_asset_override_target_kind" NOT NULL,
	"blockchain_id" uuid,
	"representation_type" "asset_representation_type",
	"contract_address" text,
	"mint_address" text,
	"provider_asset_row_id" uuid,
	"action" "principal_asset_override_action" NOT NULL,
	"inspected_system_revision" text NOT NULL,
	"inspected_identity_state" "principal_asset_identity_state",
	"inspected_inclusion_state" "principal_asset_inclusion_state",
	"inspected_inclusion_reason" text,
	"inspected_asset_id" uuid,
	"replacement_asset_id" uuid,
	"replacement_inclusion_state" "principal_asset_inclusion_state",
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"supersedes_override_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_asset_overrides_target_complete" CHECK ((
        "target_kind" = 'provider_asset'
        and "provider_asset_row_id" is not null
        and "blockchain_id" is null
        and "representation_type" is null
        and "contract_address" is null
        and "mint_address" is null
      ) or (
        "target_kind" = 'representation'
        and "provider_asset_row_id" is null
        and "blockchain_id" is not null
        and "representation_type" is not null
        and (
          ("representation_type" = 'native' and "contract_address" is null and "mint_address" is null)
          or ("representation_type" in ('token', 'nft') and num_nonnulls("contract_address", "mint_address") = 1)
        )
      )),
	CONSTRAINT "principal_asset_overrides_inspected_conclusion_matches_kind" CHECK ((
        "kind" = 'identity'
        and "inspected_identity_state" is not null
        and "inspected_inclusion_state" is null
        and "inspected_inclusion_reason" is null
      ) or (
        "kind" = 'inclusion'
        and "inspected_identity_state" is null
        and "inspected_inclusion_state" is not null
        and "inspected_asset_id" is null
      )),
	CONSTRAINT "principal_asset_overrides_replacement_matches_action_and_kind" CHECK ((
        "action" = 'withdraw'
        and "replacement_asset_id" is null
        and "replacement_inclusion_state" is null
      ) or (
        "action" = 'set'
        and "kind" = 'identity'
        and "replacement_asset_id" is not null
        and "replacement_inclusion_state" is null
      ) or (
        "action" = 'set'
        and "kind" = 'inclusion'
        and "replacement_asset_id" is null
        and "replacement_inclusion_state" in ('included', 'excluded')
      )),
	CONSTRAINT "principal_asset_overrides_reason_present" CHECK (length(trim("reason")) > 0),
	CONSTRAINT "principal_asset_overrides_not_self_superseding" CHECK ("supersedes_override_id" is null or "supersedes_override_id" <> "id")
);
--> statement-breakpoint
CREATE TABLE "source_representation_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"blockchain_id" uuid NOT NULL,
	"representation_type" "asset_representation_type" NOT NULL,
	"contract_address" text,
	"mint_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_representation_uses_identity_matches_type" CHECK ((
        "representation_type" = 'native'
        and "contract_address" is null
        and "mint_address" is null
      ) or (
        "representation_type" in ('token', 'nft')
        and num_nonnulls("contract_address", "mint_address") = 1
      ))
);
--> statement-breakpoint
ALTER TABLE "provider_asset_source_uses" ADD COLUMN "has_chainless_observation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "provider_asset_source_uses" source_use
SET "has_chainless_observation" = true
WHERE EXISTS (
	SELECT 1
	FROM "provider_transfers" provider_transfer
	WHERE provider_transfer."source_id" = source_use."source_id"
		AND provider_transfer."provider_asset_id" = source_use."provider_asset_row_id"
		AND (
			provider_transfer."observed_blockchain_id" IS NULL
			OR provider_transfer."observed_representation_type" IS NULL
		)
	) OR EXISTS (
		SELECT 1
		FROM "provider_asset_transaction_uses" transaction_use
		WHERE transaction_use."source_id" = source_use."source_id"
			AND transaction_use."provider_asset_row_id" = source_use."provider_asset_row_id"
			AND NOT EXISTS (
				SELECT 1
				FROM "provider_transfers" exact_transfer
				WHERE exact_transfer."transaction_id" = transaction_use."transaction_id"
					AND exact_transfer."provider_asset_id" = transaction_use."provider_asset_row_id"
					AND exact_transfer."observed_blockchain_id" IS NOT NULL
					AND exact_transfer."observed_representation_type" IS NOT NULL
			)
	) OR NOT EXISTS (
		SELECT 1
		FROM "provider_transfers" any_transfer
		WHERE any_transfer."source_id" = source_use."source_id"
			AND any_transfer."provider_asset_id" = source_use."provider_asset_row_id"
	);--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_applications_override_source_unique" ON "principal_asset_override_applications" ("override_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_source_active" ON "principal_asset_override_applications" ("source_id","superseded_at");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_applications_replay_job" ON "principal_asset_override_applications" ("replay_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_overrides_supersedes_unique" ON "principal_asset_overrides" ("supersedes_override_id") WHERE "supersedes_override_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_principal_asset_overrides_provider_target" ON "principal_asset_overrides" ("principal_id","kind","provider_asset_row_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_overrides_representation_target" ON "principal_asset_overrides" ("principal_id","kind","blockchain_id","representation_type","contract_address","mint_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_native_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id") WHERE "representation_type" = 'native';--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_contract_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id","representation_type",lower("contract_address")) WHERE "contract_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_mint_unique_idx" ON "source_representation_uses" ("source_id","blockchain_id","representation_type","mint_address") WHERE "mint_address" is not null;--> statement-breakpoint
CREATE INDEX "idx_source_representation_uses_source" ON "source_representation_uses" ("source_id");--> statement-breakpoint
INSERT INTO "source_representation_uses" (
	"source_id",
	"blockchain_id",
	"representation_type",
	"contract_address",
	"mint_address"
)
SELECT DISTINCT
	provider_transfer."source_id",
	provider_transfer."observed_blockchain_id",
	provider_transfer."observed_representation_type",
	provider_transfer."observed_contract_address",
	provider_transfer."observed_mint_address"
FROM "provider_transfers" provider_transfer
WHERE provider_transfer."observed_blockchain_id" IS NOT NULL
	AND provider_transfer."observed_representation_type" IS NOT NULL
	AND (
		(
			provider_transfer."observed_representation_type" = 'native'
			AND provider_transfer."observed_contract_address" IS NULL
			AND provider_transfer."observed_mint_address" IS NULL
		) OR (
			provider_transfer."observed_representation_type" IN ('token', 'nft')
			AND num_nonnulls(
				provider_transfer."observed_contract_address",
				provider_transfer."observed_mint_address"
			) = 1
		)
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_0WXg3aRBVFsR_fkey" FOREIGN KEY ("override_id") REFERENCES "principal_asset_overrides"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_override_applications" ADD CONSTRAINT "principal_asset_override_applications_VvSwSMmYpRl5_fkey" FOREIGN KEY ("replay_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_cS2sDYiBVOvP_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_inspected_asset_id_assets_id_fkey" FOREIGN KEY ("inspected_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_replacement_asset_id_assets_id_fkey" FOREIGN KEY ("replacement_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_actor_id_users_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_supersedes_fk" FOREIGN KEY ("supersedes_override_id") REFERENCES "principal_asset_overrides"("id");--> statement-breakpoint
ALTER TABLE "source_representation_uses" ADD CONSTRAINT "source_representation_uses_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_representation_uses" ADD CONSTRAINT "source_representation_uses_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");
