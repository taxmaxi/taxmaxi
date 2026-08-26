CREATE TABLE "provider_asset_transaction_uses" (
	"provider_asset_row_id" uuid,
	"transaction_id" uuid,
	"source_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_asset_transaction_uses_pkey" PRIMARY KEY("provider_asset_row_id","transaction_id")
);
--> statement-breakpoint
CREATE INDEX "idx_provider_asset_transaction_uses_transaction" ON "provider_asset_transaction_uses" ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_transaction_uses_source" ON "provider_asset_transaction_uses" ("source_id");--> statement-breakpoint
ALTER TABLE "provider_asset_transaction_uses" ADD CONSTRAINT "provider_asset_transaction_uses_sx1UgNJ7ia12_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_transaction_uses" ADD CONSTRAINT "provider_asset_transaction_uses_E1wZ83ePvlu9_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_asset_transaction_uses" ADD CONSTRAINT "provider_asset_transaction_uses_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;