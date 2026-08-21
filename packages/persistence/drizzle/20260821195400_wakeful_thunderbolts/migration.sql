CREATE TYPE "principal_asset_identity_state" AS ENUM('resolved', 'unresolved', 'excluded');--> statement-breakpoint
CREATE TYPE "principal_asset_inclusion_state" AS ENUM('included', 'excluded', 'blocked');--> statement-breakpoint
CREATE TYPE "principal_asset_override_action" AS ENUM('set', 'withdraw');--> statement-breakpoint
CREATE TYPE "principal_asset_override_kind" AS ENUM('identity', 'inclusion');--> statement-breakpoint
CREATE TYPE "principal_asset_override_target_kind" AS ENUM('representation', 'provider_asset');--> statement-breakpoint
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
CREATE UNIQUE INDEX "principal_asset_overrides_supersedes_unique" ON "principal_asset_overrides" ("supersedes_override_id") WHERE "supersedes_override_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_principal_asset_overrides_provider_target" ON "principal_asset_overrides" ("principal_id","kind","provider_asset_row_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_principal_asset_overrides_representation_target" ON "principal_asset_overrides" ("principal_id","kind","blockchain_id","representation_type","contract_address","mint_address","created_at");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_cS2sDYiBVOvP_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_inspected_asset_id_assets_id_fkey" FOREIGN KEY ("inspected_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_replacement_asset_id_assets_id_fkey" FOREIGN KEY ("replacement_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_actor_id_users_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id");