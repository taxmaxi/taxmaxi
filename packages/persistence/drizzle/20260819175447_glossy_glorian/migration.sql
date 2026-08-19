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
ALTER TABLE "asset_resolution_decisions" DROP COLUMN "chain_evidence";--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" DROP COLUMN "coingecko_evidence";--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_evidence_decision_authority_claim_unique" ON "asset_resolution_evidence" ("decision_id","authority","claim_kind");--> statement-breakpoint
CREATE INDEX "idx_asset_resolution_evidence_decision_id" ON "asset_resolution_evidence" ("decision_id");--> statement-breakpoint
ALTER TABLE "asset_resolution_evidence" ADD CONSTRAINT "asset_resolution_evidence_13op32dmB3hM_fkey" FOREIGN KEY ("decision_id") REFERENCES "asset_resolution_decisions"("id") ON DELETE CASCADE;