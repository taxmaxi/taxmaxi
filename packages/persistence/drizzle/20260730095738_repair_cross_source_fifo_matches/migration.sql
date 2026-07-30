CREATE TEMP TABLE "_invalid_cross_source_disposal_matches" ON COMMIT DROP AS
SELECT
	"disposal_matches"."id" AS "match_id",
	"disposal_matches"."disposal_leg_id",
	"disposal_matches"."fifo_lot_id",
	"disposal_matches"."matched_amount",
	"transactions"."id" AS "transaction_id",
	"transactions"."source_raw_record_id",
	"transactions"."principal_id",
	"transactions"."transaction_type"
FROM "disposal_matches"
INNER JOIN "fifo_lots"
	ON "fifo_lots"."id" = "disposal_matches"."fifo_lot_id"
INNER JOIN "transaction_legs"
	ON "transaction_legs"."id" = "disposal_matches"."disposal_leg_id"
INNER JOIN "transactions"
	ON "transactions"."id" = "transaction_legs"."transaction_id"
WHERE "fifo_lots"."source_id" <> "transaction_legs"."source_id";--> statement-breakpoint

CREATE TEMP TABLE "_invalid_cross_source_movement_allocations" ON COMMIT DROP AS
SELECT
	"inventory_movement_allocations"."id" AS "allocation_id",
	"inventory_movement_allocations"."inventory_movement_id",
	"inventory_movement_allocations"."fifo_lot_id",
	"inventory_movement_allocations"."matched_amount",
	"transactions"."id" AS "transaction_id",
	"transactions"."source_raw_record_id",
	"transactions"."principal_id",
	"transactions"."transaction_type"
FROM "inventory_movement_allocations"
INNER JOIN "fifo_lots"
	ON "fifo_lots"."id" = "inventory_movement_allocations"."fifo_lot_id"
INNER JOIN "inventory_movements"
	ON "inventory_movements"."id" = "inventory_movement_allocations"."inventory_movement_id"
INNER JOIN "transactions"
	ON "transactions"."id" = "inventory_movements"."transaction_id"
WHERE "fifo_lots"."source_id" <> "inventory_movements"."source_id";--> statement-breakpoint

CREATE TEMP TABLE "_disposal_matches_to_rebuild" ON COMMIT DROP AS
SELECT DISTINCT
	"disposal_matches"."id" AS "match_id",
	"disposal_matches"."fifo_lot_id",
	"disposal_matches"."matched_amount"
FROM "disposal_matches"
INNER JOIN "_invalid_cross_source_disposal_matches"
	ON "_invalid_cross_source_disposal_matches"."disposal_leg_id" = "disposal_matches"."disposal_leg_id";--> statement-breakpoint

CREATE TEMP TABLE "_movement_allocations_to_rebuild" ON COMMIT DROP AS
SELECT DISTINCT
	"inventory_movement_allocations"."id" AS "allocation_id",
	"inventory_movement_allocations"."fifo_lot_id",
	"inventory_movement_allocations"."matched_amount"
FROM "inventory_movement_allocations"
INNER JOIN "_invalid_cross_source_movement_allocations"
	ON "_invalid_cross_source_movement_allocations"."inventory_movement_id" = "inventory_movement_allocations"."inventory_movement_id";--> statement-breakpoint

UPDATE "fifo_lots"
SET
	"remaining_amount" = "fifo_lots"."remaining_amount" + "restored"."matched_amount",
	"updated_at" = now()
FROM (
	SELECT "fifo_lot_id", sum("matched_amount") AS "matched_amount"
	FROM (
		SELECT "fifo_lot_id", "matched_amount"
		FROM "_disposal_matches_to_rebuild"
		UNION ALL
		SELECT "fifo_lot_id", "matched_amount"
		FROM "_movement_allocations_to_rebuild"
	) AS "invalid_allocations"
	GROUP BY "fifo_lot_id"
) AS "restored"
WHERE "fifo_lots"."id" = "restored"."fifo_lot_id";--> statement-breakpoint

DELETE FROM "disposal_matches"
USING "_disposal_matches_to_rebuild"
WHERE "disposal_matches"."id" = "_disposal_matches_to_rebuild"."match_id";--> statement-breakpoint

DELETE FROM "inventory_movement_allocations"
USING "_movement_allocations_to_rebuild"
WHERE "inventory_movement_allocations"."id" = "_movement_allocations_to_rebuild"."allocation_id";--> statement-breakpoint

CREATE TEMP TABLE "_cross_source_fifo_repair_transactions" ON COMMIT DROP AS
SELECT DISTINCT
	"transaction_id",
	"source_raw_record_id",
	"principal_id",
	"transaction_type"
FROM (
	SELECT
		"transaction_id",
		"source_raw_record_id",
		"principal_id",
		"transaction_type"
	FROM "_invalid_cross_source_disposal_matches"
	UNION ALL
	SELECT
		"transaction_id",
		"source_raw_record_id",
		"principal_id",
		"transaction_type"
	FROM "_invalid_cross_source_movement_allocations"
) AS "affected_transactions";--> statement-breakpoint

UPDATE "source_records_raw"
SET
	"normalized_at" = NULL,
	"normalization_error" = NULL,
	"updated_at" = now()
FROM "_cross_source_fifo_repair_transactions"
WHERE "source_records_raw"."id" = "_cross_source_fifo_repair_transactions"."source_raw_record_id";--> statement-breakpoint

INSERT INTO "transaction_reviews" (
	"transaction_id",
	"principal_id",
	"review_status",
	"original_type_key",
	"current_type_key",
	"categorization_reason",
	"matched_layer",
	"needs_review",
	"reviewed_at",
	"created_at",
	"updated_at"
)
SELECT
	"transaction_id",
	"principal_id",
	'needs_review',
	"transaction_type",
	"transaction_type",
	'fifo_inventory: Review required because an earlier FIFO allocation consumed inventory from another source. The invalid allocation was removed and the source was marked for deterministic re-normalization.',
	'fifo_inventory',
	true,
	NULL,
	now(),
	now()
FROM "_cross_source_fifo_repair_transactions"
ON CONFLICT ("transaction_id") DO UPDATE
SET
	"review_status" = CASE
		WHEN "transaction_reviews"."review_status" IN ('approved', 'changed')
			THEN "transaction_reviews"."review_status"
		ELSE 'needs_review'
	END,
	"categorization_reason" = concat_ws(
		E'\n',
		"transaction_reviews"."categorization_reason",
		'fifo_inventory: Review required because an earlier FIFO allocation consumed inventory from another source. The invalid allocation was removed and the source was marked for deterministic re-normalization.'
	),
	"matched_layer" = CASE
		WHEN "transaction_reviews"."matched_layer" IS NULL OR btrim("transaction_reviews"."matched_layer") = ''
			THEN 'fifo_inventory'
		WHEN 'fifo_inventory' = ANY(string_to_array("transaction_reviews"."matched_layer", ','))
			THEN "transaction_reviews"."matched_layer"
		ELSE "transaction_reviews"."matched_layer" || ',fifo_inventory'
	END,
	"needs_review" = true,
	"reviewed_at" = CASE
		WHEN "transaction_reviews"."review_status" IN ('approved', 'changed')
			THEN "transaction_reviews"."reviewed_at"
		ELSE NULL
	END,
	"updated_at" = now();
