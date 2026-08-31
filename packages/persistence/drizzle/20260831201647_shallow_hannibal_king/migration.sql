CREATE TYPE "principal_asset_identity_conclusion" AS ENUM('resolved', 'unresolved');--> statement-breakpoint
CREATE TYPE "principal_asset_inclusion_conclusion" AS ENUM('included', 'excluded');--> statement-breakpoint
CREATE TYPE "principal_asset_override_kind" AS ENUM('identity', 'inclusion');--> statement-breakpoint
CREATE TYPE "principal_asset_override_operation" AS ENUM('create', 'replace', 'withdraw');--> statement-breakpoint
CREATE TYPE "principal_asset_override_target_kind" AS ENUM('representation', 'provider_asset');--> statement-breakpoint
CREATE TABLE "principal_asset_override_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"target_kind" "principal_asset_override_target_kind" NOT NULL,
	"blockchain_id" uuid,
	"representation_type" "asset_representation_type",
	"contract_address" text,
	"mint_address" text,
	"provider_asset_row_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_asset_override_targets_shape" CHECK ((
        "target_kind" = 'representation'
        and "provider_asset_row_id" is null
        and "blockchain_id" is not null
        and "representation_type" is not null
        and (
          (
            "representation_type" = 'native'
            and "contract_address" is null
            and "mint_address" is null
          ) or (
            "representation_type" in ('token', 'nft')
            and num_nonnulls("contract_address", "mint_address") = 1
            and coalesce(
              length(btrim("contract_address", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0,
              length(btrim("mint_address", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0,
              false
            )
          )
        )
      ) or (
        "target_kind" = 'provider_asset'
        and "provider_asset_row_id" is not null
        and num_nonnulls(
          "blockchain_id",
          "representation_type",
          "contract_address",
          "mint_address"
        ) = 0
      ))
);
--> statement-breakpoint
CREATE TABLE "principal_asset_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" "principal_asset_override_kind" NOT NULL,
	"operation" "principal_asset_override_operation" NOT NULL,
	"inspected_system_revision" text NOT NULL,
	"inspected_system_identity" "principal_asset_identity_conclusion",
	"inspected_system_asset_id" uuid,
	"inspected_system_inclusion" "principal_asset_inclusion_conclusion",
	"replacement_asset_id" uuid,
	"replacement_inclusion" "principal_asset_inclusion_conclusion",
	"actor_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"supersedes_override_id" uuid,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_asset_overrides_system_conclusion_shape" CHECK ((
        "kind" = 'identity'
        and "inspected_system_identity" is not null
        and "inspected_system_inclusion" is null
        and (
          (
            "inspected_system_identity" = 'resolved'
            and "inspected_system_asset_id" is not null
          ) or (
            "inspected_system_identity" = 'unresolved'
            and "inspected_system_asset_id" is null
          )
        )
      ) or (
        "kind" = 'inclusion'
        and "inspected_system_identity" is null
        and "inspected_system_asset_id" is null
        and "inspected_system_inclusion" is not null
      )),
	CONSTRAINT "principal_asset_overrides_replacement_shape" CHECK ((
        "operation" in ('create', 'replace')
        and (
          (
            "kind" = 'identity'
            and "replacement_asset_id" is not null
            and "replacement_inclusion" is null
          ) or (
            "kind" = 'inclusion'
            and "replacement_asset_id" is null
            and "replacement_inclusion" is not null
          )
        )
      ) or (
        "operation" = 'withdraw'
        and "replacement_asset_id" is null
        and "replacement_inclusion" is null
      )),
	CONSTRAINT "principal_asset_overrides_supersession_shape" CHECK ((
        "operation" = 'create'
      ) or (
        "operation" in ('replace', 'withdraw')
        and "supersedes_override_id" is not null
      )),
	CONSTRAINT "principal_asset_overrides_no_self_supersession" CHECK ("supersedes_override_id" is null or "id" <> "supersedes_override_id"),
	CONSTRAINT "principal_asset_overrides_revision_required" CHECK (length(btrim("inspected_system_revision", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0),
	CONSTRAINT "principal_asset_overrides_reason_required" CHECK (length(btrim("reason", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_targets_principal_id_unique" ON "principal_asset_override_targets" ("principal_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_targets_native_unique" ON "principal_asset_override_targets" ("principal_id","blockchain_id") WHERE "target_kind" = 'representation' and "representation_type" = 'native';--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_targets_contract_unique" ON "principal_asset_override_targets" ("principal_id","blockchain_id","representation_type","contract_address") WHERE "target_kind" = 'representation' and "contract_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_targets_mint_unique" ON "principal_asset_override_targets" ("principal_id","blockchain_id","representation_type","mint_address") WHERE "target_kind" = 'representation' and "mint_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_override_targets_provider_asset_unique" ON "principal_asset_override_targets" ("principal_id","provider_asset_row_id") WHERE "target_kind" = 'provider_asset';--> statement-breakpoint
CREATE INDEX "idx_principal_asset_override_targets_principal" ON "principal_asset_override_targets" ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_overrides_stream_record_unique" ON "principal_asset_overrides" ("principal_id","target_id","kind","id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_overrides_supersedes_unique" ON "principal_asset_overrides" ("supersedes_override_id") WHERE "supersedes_override_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_asset_overrides_root_unique" ON "principal_asset_overrides" ("principal_id","target_id","kind") WHERE "supersedes_override_id" is null;--> statement-breakpoint
CREATE INDEX "idx_principal_asset_overrides_principal_target_kind" ON "principal_asset_overrides" ("principal_id","target_id","kind","recorded_at");--> statement-breakpoint
ALTER TABLE "principal_asset_override_targets" ADD CONSTRAINT "principal_asset_override_targets_mE6FwGQyCAG4_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_override_targets" ADD CONSTRAINT "principal_asset_override_targets_dW2pt7dMn0oQ_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_override_targets" ADD CONSTRAINT "principal_asset_override_targets_sYfyxIvtTVhx_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_ZSEGAGoKWNPy_fkey" FOREIGN KEY ("inspected_system_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_replacement_asset_id_assets_id_fkey" FOREIGN KEY ("replacement_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_target_principal_fk" FOREIGN KEY ("principal_id","target_id") REFERENCES "principal_asset_override_targets"("principal_id","id");--> statement-breakpoint
ALTER TABLE "principal_asset_overrides" ADD CONSTRAINT "principal_asset_overrides_supersedes_fk" FOREIGN KEY ("principal_id","target_id","kind","supersedes_override_id") REFERENCES "principal_asset_overrides"("principal_id","target_id","kind","id");--> statement-breakpoint
CREATE FUNCTION reject_principal_asset_override_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'principal asset override audit records are append-only'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER principal_asset_override_targets_append_only
BEFORE UPDATE OR DELETE ON principal_asset_override_targets
FOR EACH ROW EXECUTE FUNCTION reject_principal_asset_override_mutation();--> statement-breakpoint
CREATE TRIGGER principal_asset_overrides_append_only
BEFORE UPDATE OR DELETE ON principal_asset_overrides
FOR EACH ROW EXECUTE FUNCTION reject_principal_asset_override_mutation();--> statement-breakpoint
CREATE FUNCTION validate_principal_asset_override_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	superseded_operation principal_asset_override_operation;
BEGIN
	PERFORM 1
	FROM principals
	WHERE id = NEW.principal_id
		AND kind = 'user'
		AND user_id = NEW.actor_user_id;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'principal asset override actor must own the user-backed principal'
			USING ERRCODE = '23503';
	END IF;

	IF NEW.supersedes_override_id IS NULL THEN
		IF NEW.operation <> 'create' THEN
			RAISE EXCEPTION 'an initial principal asset override must use create'
				USING ERRCODE = '23514';
		END IF;

		RETURN NEW;
	END IF;

	SELECT operation
	INTO superseded_operation
	FROM principal_asset_overrides
	WHERE id = NEW.supersedes_override_id
		AND principal_id = NEW.principal_id
		AND target_id = NEW.target_id
		AND kind = NEW.kind;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'superseded principal asset override must already exist in the same history'
			USING ERRCODE = '23503';
	END IF;

	IF NEW.operation = 'create' AND superseded_operation <> 'withdraw' THEN
		RAISE EXCEPTION 'create may supersede only a withdrawal'
			USING ERRCODE = '23514';
	END IF;

	IF NEW.operation IN ('replace', 'withdraw') AND superseded_operation = 'withdraw' THEN
		RAISE EXCEPTION 'an inactive principal asset override must be created before replacement or withdrawal'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER principal_asset_overrides_validate_insert
BEFORE INSERT ON principal_asset_overrides
FOR EACH ROW EXECUTE FUNCTION validate_principal_asset_override_insert();
