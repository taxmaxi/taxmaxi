WITH RECURSIVE ranked_transfer_matches AS (
	SELECT
		transfer_match.disposal_leg_id,
		transfer_match.fifo_lot_id,
		row_number() OVER (
			PARTITION BY transfer_match.disposal_leg_id
			ORDER BY source_lot.acquired_at, source_lot.created_at, source_lot.id
		) - 1 AS source_leg_sequence
	FROM disposal_matches transfer_match
	INNER JOIN fifo_lots source_lot
		ON source_lot.id = transfer_match.fifo_lot_id
),
pending_lots (id) AS (
	SELECT lot.id
	FROM fifo_lots lot
	WHERE lot.cost_basis_status = 'pending_review'

	UNION

	SELECT lot.id
	FROM fifo_lots lot
	INNER JOIN transaction_legs source_leg ON source_leg.id = lot.source_leg_id
	WHERE source_leg.kind IN ('acquisition', 'income')
		AND source_leg.derivation_rule IS DISTINCT FROM 'internal_transfer_in'
		AND (source_leg.fiat_amount IS NULL OR source_leg.fiat_currency IS NULL)

	UNION

	SELECT destination_lot.id
	FROM pending_lots pending_lot
	INNER JOIN ranked_transfer_matches transfer_match
		ON transfer_match.fifo_lot_id = pending_lot.id
	INNER JOIN transaction_legs origin_leg
		ON origin_leg.id = transfer_match.disposal_leg_id
		AND origin_leg.derivation_rule = 'internal_transfer_out'
	INNER JOIN transaction_legs destination_leg
		ON destination_leg.derivation_rule = 'internal_transfer_in'
		AND origin_leg.metadata #>> '{reconciliation,providerTransferId}' IS NOT NULL
		AND destination_leg.metadata #>> '{reconciliation,providerTransferId}'
			= origin_leg.metadata #>> '{reconciliation,providerTransferId}'
		AND destination_leg.metadata #>> '{reconciliation,canonicalTransferId}'
			IS NOT DISTINCT FROM origin_leg.metadata #>> '{reconciliation,canonicalTransferId}'
	INNER JOIN fifo_lots destination_lot
		ON destination_lot.source_leg_id = destination_leg.id
		AND destination_lot.source_leg_sequence = transfer_match.source_leg_sequence
)
UPDATE fifo_lots lot
SET
	cost_basis_status = 'pending_review',
	updated_at = now()
WHERE lot.id IN (SELECT id FROM pending_lots)
	AND lot.cost_basis_status = 'known';
