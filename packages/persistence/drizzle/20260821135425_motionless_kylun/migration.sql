CREATE TYPE "provider_asset_mapping_status" AS ENUM('approved', 'pending_review', 'rejected', 'excluded');--> statement-breakpoint
ALTER TYPE "asset_resolution_outcome" ADD VALUE 'excluded' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" DROP CONSTRAINT "provider_asset_mappings_kind_requires_target";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER COLUMN "mapping_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER COLUMN "mapping_status" SET DATA TYPE "provider_asset_mapping_status" USING "mapping_status"::text::"provider_asset_mapping_status";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ALTER COLUMN "mapping_status" SET DEFAULT 'pending_review'::"provider_asset_mapping_status";--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_kind_requires_target" CHECK ((
        "mapping_kind" = 'asset'
        and "canonical_asset_id" is not null
      ) or (
        "mapping_kind" = 'fiat'
        and "canonical_fiat_currency" is not null
      ) or "mapping_status" in ('pending_review', 'rejected', 'excluded'));
