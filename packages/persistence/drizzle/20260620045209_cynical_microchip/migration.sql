ALTER TABLE "protocol_candidate_observations" ADD COLUMN "related_subject_identifiers" jsonb;--> statement-breakpoint
UPDATE "protocol_candidate_observations"
SET "related_subject_identifiers" = CASE
	WHEN jsonb_typeof("raw_payload" -> 'canonicalProgramIds') = 'array'
		THEN "raw_payload" -> 'canonicalProgramIds'
	ELSE '[]'::jsonb
END;--> statement-breakpoint
ALTER TABLE "protocol_candidate_observations" ALTER COLUMN "related_subject_identifiers" SET NOT NULL;
