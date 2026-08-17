CREATE TYPE "provider_asset_replay_dispatch_state" AS ENUM('queued', 'failed_to_queue');--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD COLUMN "dispatch_state" "provider_asset_replay_dispatch_state" DEFAULT 'queued'::"provider_asset_replay_dispatch_state" NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_asset_review_replays" ADD COLUMN "error_message" text;
