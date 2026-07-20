ALTER TABLE "provider_transfers" ADD COLUMN "source_record_position" integer DEFAULT 0 NOT NULL;

WITH ranked_provider_transfers AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "transaction_id"
      ORDER BY "created_at", "id"
    ) - 1 AS "source_record_position"
  FROM "provider_transfers"
)
UPDATE "provider_transfers"
SET "source_record_position" = ranked_provider_transfers."source_record_position"
FROM ranked_provider_transfers
WHERE "provider_transfers"."id" = ranked_provider_transfers."id";
