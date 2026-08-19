CREATE TYPE "asset_resolution_decision_status" AS ENUM('active', 'superseded');--> statement-breakpoint
DROP INDEX "asset_resolution_decisions_observation_revision_unique";--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD COLUMN "status" "asset_resolution_decision_status" DEFAULT 'active'::"asset_resolution_decision_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD COLUMN "supersedes_decision_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_active_observation_revision_unique" ON "asset_resolution_decisions" ("provider_asset_row_id","evidence_revision") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_resolution_decisions_supersedes_unique" ON "asset_resolution_decisions" ("supersedes_decision_id") WHERE "supersedes_decision_id" is not null;--> statement-breakpoint
ALTER TABLE "asset_resolution_decisions" ADD CONSTRAINT "asset_resolution_decisions_supersedes_decision_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "asset_resolution_decisions"("id");