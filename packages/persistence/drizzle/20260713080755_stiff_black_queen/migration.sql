ALTER TABLE "assets" ADD COLUMN "coingecko_coin_id" text;--> statement-breakpoint
CREATE INDEX "asset_coingecko_coin_id_idx" ON "assets" ("coingecko_coin_id");