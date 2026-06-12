ALTER TABLE "provider_transaction_type_mappings" ALTER COLUMN "resolution_strategy" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "provider_resolution_strategy";--> statement-breakpoint
UPDATE "provider_transaction_type_mappings" SET "resolution_strategy" = 'paired_spread_fee' WHERE "resolution_strategy" = 'amount_sign_fee';--> statement-breakpoint
CREATE TYPE "provider_resolution_strategy" AS ENUM('static', 'amount_sign', 'venue_side', 'paired_spread_fee', 'no_leg');--> statement-breakpoint
ALTER TABLE "provider_transaction_type_mappings" ALTER COLUMN "resolution_strategy" SET DATA TYPE "provider_resolution_strategy" USING "resolution_strategy"::"provider_resolution_strategy";