CREATE TYPE "asset_resolution_outcome" AS ENUM('attach', 'pending', 'fail_closed');--> statement-breakpoint
CREATE TABLE "asset_resolution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"evidence_revision" integer NOT NULL,
	"policy_revision" text NOT NULL,
	"outcome" "asset_resolution_outcome" NOT NULL,
	"asset_id" uuid,
	"asset_representation_id" uuid,
	"blockchain" text,
	"representation_type" text,
	"contract_address" text,
	"mint_address" text,
	"decimals" integer,
	"reason" text,
	"chain_evidence" jsonb,
	"coingecko_evidence" jsonb,
	"actor" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_resolution_decisions_evidence_revision_positive" CHECK ("evidence_revision" > 0),
	CONSTRAINT "asset_resolution_decisions_attach_requires_target" CHECK ("outcome" <> 'attach' or ("asset_id" is not null and "asset_representation_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_observation_revision_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","evidence_revision");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_decisions_asset_id" ON "asset_resolution_decisions" ("asset_id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_z5wvnNDSeDWF_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");