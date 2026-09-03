ALTER TABLE "provider_transfers" ADD COLUMN "source_representation_use_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "source_representation_use_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "provider_asset_row_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "source_representation_use_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "provider_asset_row_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_representation_use" ON "provider_transfers" ("source_representation_use_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_representation_uses_id_source_unique_idx" ON "source_representation_uses" ("id","source_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_representation_use" ON "transaction_legs" ("source_representation_use_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_provider_asset_row" ON "transaction_legs" ("provider_asset_row_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_representation_use" ON "transfers" ("source_representation_use_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_provider_asset_row" ON "transfers" ("provider_asset_row_id");--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_representation_use_source_fk" FOREIGN KEY ("source_representation_use_id","source_id") REFERENCES "source_representation_uses"("id","source_id");--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_provider_asset_row_id_provider_assets_id_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_representation_use_source_fk" FOREIGN KEY ("source_representation_use_id","source_id") REFERENCES "source_representation_uses"("id","source_id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_provider_asset_row_id_provider_assets_id_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_representation_use_source_fk" FOREIGN KEY ("source_representation_use_id","source_id") REFERENCES "source_representation_uses"("id","source_id");