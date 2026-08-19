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
CREATE UNIQUE INDEX "asset_representation_ownership_active_unique" ON "asset_representation_ownership_decisions" ("asset_representation_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_representation_ownership_supersedes_unique" ON "asset_representation_ownership_decisions" ("supersedes_decision_id") WHERE "supersedes_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_asset_representation_ownership_asset_id" ON "asset_representation_ownership_decisions" ("asset_id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_owner_matches_fk" FOREIGN KEY ("asset_id","asset_representation_id") REFERENCES "asset_representations"("asset_id","id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "asset_representation_ownership_decisions" ADD CONSTRAINT "asset_representation_ownership_supersedes_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "asset_representation_ownership_decisions"("id");--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_QbAUryyGxFkm_fkey" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");