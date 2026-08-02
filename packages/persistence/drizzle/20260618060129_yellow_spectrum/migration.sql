CREATE TYPE "protocol_mapping_evidence_kind" AS ENUM('sample_signature', 'normalized_fixture', 'dune_observation', 'review_note');--> statement-breakpoint
CREATE TYPE "protocol_movement_pattern" AS ENUM('token_out_and_token_in');--> statement-breakpoint
CREATE TABLE "protocol_mapping_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mapping_id" uuid NOT NULL,
	"candidate_observation_id" uuid,
	"evidence_kind" "protocol_mapping_evidence_kind" NOT NULL,
	"sample_signature" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_transaction_type_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"candidate_id" uuid,
	"blockchain_id" uuid NOT NULL,
	"subject_identifier" text NOT NULL,
	"protocol_name" text NOT NULL,
	"movement_pattern" "protocol_movement_pattern" NOT NULL,
	"transaction_type_key" text,
	"inventory_effect" "provider_inventory_effect" NOT NULL,
	"tax_treatment" "provider_tax_treatment" NOT NULL,
	"confidence" numeric(5,4) NOT NULL,
	"mapping_status" "provider_mapping_status" DEFAULT 'pending_review'::"provider_mapping_status" NOT NULL,
	"version" integer NOT NULL,
	"reviewer_notes" text,
	"source_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "protocol_transaction_type_mappings_approved_requires_type_key" CHECK ("mapping_status" in ('pending_review', 'rejected') or "transaction_type_key" is not null),
	CONSTRAINT "protocol_transaction_type_mappings_confidence_range" CHECK ("confidence" >= 0 and "confidence" <= 1)
);
--> statement-breakpoint
CREATE INDEX "idx_protocol_mapping_evidence_mapping" ON "protocol_mapping_evidence" ("mapping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_transaction_type_mappings_subject_pattern_version_unique" ON "protocol_transaction_type_mappings" ("blockchain_id","subject_identifier","movement_pattern","version");--> statement-breakpoint
CREATE INDEX "idx_protocol_transaction_type_mappings_blockchain_subject" ON "protocol_transaction_type_mappings" ("blockchain_id","subject_identifier");--> statement-breakpoint
CREATE INDEX "idx_protocol_transaction_type_mappings_mapping_status" ON "protocol_transaction_type_mappings" ("mapping_status");--> statement-breakpoint
ALTER TABLE "protocol_mapping_evidence" ADD CONSTRAINT "protocol_mapping_evidence_n1VJSCxTe9Nv_fkey" FOREIGN KEY ("mapping_id") REFERENCES "protocol_transaction_type_mappings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "protocol_mapping_evidence" ADD CONSTRAINT "protocol_mapping_evidence_Qx3cGe0oz1f5_fkey" FOREIGN KEY ("candidate_observation_id") REFERENCES "protocol_candidate_observations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "protocol_transaction_type_mappings" ADD CONSTRAINT "protocol_transaction_type_mappings_z2ZsJYAbplik_fkey" FOREIGN KEY ("candidate_id") REFERENCES "protocol_candidates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "protocol_transaction_type_mappings" ADD CONSTRAINT "protocol_transaction_type_mappings_eRAvAZmyZKBj_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "protocol_transaction_type_mappings" ADD CONSTRAINT "protocol_transaction_type_mappings_shs1CvnFjFtO_fkey" FOREIGN KEY ("transaction_type_key") REFERENCES "transaction_types"("type_key");
