CREATE TYPE "protocol_candidate_observation_onchain_data_source" AS ENUM('dune');--> statement-breakpoint
CREATE TABLE "dune_protocol_candidate_observations" (
	"observation_id" uuid PRIMARY KEY,
	"query_id" integer NOT NULL,
	"query_name" text NOT NULL,
	"query_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_candidate_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"candidate_id" uuid NOT NULL,
	"onchain_data_source" "protocol_candidate_observation_onchain_data_source" NOT NULL,
	"onchain_data_source_observation_key" text NOT NULL,
	"observed_window_start" timestamp NOT NULL,
	"observed_window_end" timestamp NOT NULL,
	"interaction_count" numeric(78,0) NOT NULL,
	"transaction_count" numeric(78,0),
	"unique_actor_count" numeric(78,0),
	"sample_transaction_hashes" jsonb NOT NULL,
	"retrieved_at" timestamp NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"blockchain_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_identifier" text NOT NULL,
	"protocol_name_hint" text,
	"category_hint" text,
	"mapping_status" "provider_mapping_status" DEFAULT 'pending_review'::"provider_mapping_status" NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_candidate_observations_onchain_data_source_period_unique" ON "protocol_candidate_observations" ("candidate_id","onchain_data_source","onchain_data_source_observation_key");--> statement-breakpoint
CREATE INDEX "idx_protocol_candidate_observations_candidate" ON "protocol_candidate_observations" ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_candidates_blockchain_subject_unique" ON "protocol_candidates" ("blockchain_id","subject_kind","subject_identifier");--> statement-breakpoint
CREATE INDEX "idx_protocol_candidates_mapping_status" ON "protocol_candidates" ("mapping_status");--> statement-breakpoint
ALTER TABLE "dune_protocol_candidate_observations" ADD CONSTRAINT "dune_protocol_candidate_observations_6fVTEm5envHJ_fkey" FOREIGN KEY ("observation_id") REFERENCES "protocol_candidate_observations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "protocol_candidate_observations" ADD CONSTRAINT "protocol_candidate_observations_jXDjBJXsnfVQ_fkey" FOREIGN KEY ("candidate_id") REFERENCES "protocol_candidates"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "protocol_candidates" ADD CONSTRAINT "protocol_candidates_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");