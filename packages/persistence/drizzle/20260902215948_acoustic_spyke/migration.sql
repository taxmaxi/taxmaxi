ALTER TABLE "transaction_legs" DROP CONSTRAINT "transaction_legs_representation_matches_asset_fk";--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_representation_matches_asset_fk";--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_asset_representation_fk" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_asset_representation_fk" FOREIGN KEY ("asset_representation_id") REFERENCES "asset_representations"("id");