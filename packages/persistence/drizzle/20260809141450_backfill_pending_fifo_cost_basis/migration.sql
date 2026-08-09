WITH RECURSIVE pending_lots (id) AS (
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
	INNER JOIN fifo_lots pending_source_lot
		ON pending_source_lot.id = pending_lot.id
	INNER JOIN disposal_matches transfer_match
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
		AND destination_lot.asset_id = pending_source_lot.asset_id
		AND destination_lot.acquired_at IS NOT DISTINCT FROM pending_source_lot.acquired_at
		AND destination_lot.original_amount IS NOT DISTINCT FROM transfer_match.matched_amount
		AND destination_lot.cost_basis_per_token IS NOT DISTINCT FROM pending_source_lot.cost_basis_per_token
		AND destination_lot.cost_basis_currency IS NOT DISTINCT FROM pending_source_lot.cost_basis_currency
)
UPDATE fifo_lots lot
SET
	cost_basis_status = 'pending_review',
	updated_at = now()
WHERE lot.id IN (SELECT id FROM pending_lots)
	AND lot.cost_basis_status = 'known';
