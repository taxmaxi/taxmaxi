ALTER TABLE "principal_asset_override_applications" ADD COLUMN "depends_on_source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;

CREATE FUNCTION "assert_cross_source_fifo_dependencies_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_source_ids uuid[];
  dependent_source_ids uuid[];
  active_override_cycle_exists boolean;
BEGIN
  IF TG_TABLE_NAME = 'disposal_matches' THEN
    SELECT
      array_agg(fifo_lot.source_id),
      array_agg(disposal_leg.source_id)
    INTO owner_source_ids, dependent_source_ids
    FROM new_dependency_rows new_match
    INNER JOIN fifo_lots fifo_lot ON fifo_lot.id = new_match.fifo_lot_id
    INNER JOIN transaction_legs disposal_leg ON disposal_leg.id = new_match.disposal_leg_id
    WHERE fifo_lot.source_id <> disposal_leg.source_id;
  ELSE
    SELECT
      array_agg(fifo_lot.source_id),
      array_agg(inventory_movement.source_id)
    INTO owner_source_ids, dependent_source_ids
    FROM new_dependency_rows new_allocation
    INNER JOIN fifo_lots fifo_lot ON fifo_lot.id = new_allocation.fifo_lot_id
    INNER JOIN inventory_movements inventory_movement
      ON inventory_movement.id = new_allocation.inventory_movement_id
    WHERE fifo_lot.source_id <> inventory_movement.source_id;
  END IF;

  IF owner_source_ids IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('cross-source-fifo-dependency-graph', 0)
  );

  WITH RECURSIVE new_dependency_edges(owner_source_id, dependent_source_id) AS (
    SELECT new_edge.owner_source_id, new_edge.dependent_source_id
    FROM unnest(owner_source_ids, dependent_source_ids)
      AS new_edge(owner_source_id, dependent_source_id)
  ),
  dependency_edges(owner_source_id, dependent_source_id) AS (
    SELECT fifo_lot.source_id, disposal_leg.source_id
    FROM disposal_matches disposal_match
    INNER JOIN fifo_lots fifo_lot ON fifo_lot.id = disposal_match.fifo_lot_id
    INNER JOIN transaction_legs disposal_leg ON disposal_leg.id = disposal_match.disposal_leg_id
    WHERE fifo_lot.source_id <> disposal_leg.source_id

    UNION

    SELECT fifo_lot.source_id, inventory_movement.source_id
    FROM inventory_movement_allocations allocation
    INNER JOIN fifo_lots fifo_lot ON fifo_lot.id = allocation.fifo_lot_id
    INNER JOIN inventory_movements inventory_movement
      ON inventory_movement.id = allocation.inventory_movement_id
    WHERE fifo_lot.source_id <> inventory_movement.source_id
  ),
  reachable(origin_source_id, source_id) AS (
    SELECT owner_source_id, dependent_source_id
    FROM dependency_edges

    UNION

    SELECT reachable.origin_source_id, dependency_edges.dependent_source_id
    FROM reachable
    INNER JOIN dependency_edges
      ON dependency_edges.owner_source_id = reachable.source_id
  )
  SELECT EXISTS (
    SELECT 1
    FROM new_dependency_edges new_edge
    INNER JOIN reachable
      ON reachable.origin_source_id = new_edge.dependent_source_id
      AND reachable.source_id = new_edge.owner_source_id
    WHERE EXISTS (
      SELECT 1
      FROM principal_asset_override_applications active_application
      INNER JOIN principal_asset_overrides active_override
        ON active_override.id = active_application.override_id
      WHERE active_application.superseded_at IS NULL
        AND active_override.action = 'set'
        AND (
          active_application.source_id = new_edge.dependent_source_id
          OR EXISTS (
            SELECT 1
            FROM reachable path_to_application
            WHERE path_to_application.origin_source_id = new_edge.dependent_source_id
              AND path_to_application.source_id = active_application.source_id
          )
        )
        AND (
          active_application.source_id = new_edge.owner_source_id
          OR EXISTS (
            SELECT 1
            FROM reachable path_to_owner
            WHERE path_to_owner.origin_source_id = active_application.source_id
              AND path_to_owner.source_id = new_edge.owner_source_id
          )
        )
    )
  )
  INTO active_override_cycle_exists;

  IF active_override_cycle_exists THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A cross-source FIFO dependency cycle cannot be added while an active asset override depends on it.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "disposal_matches_require_acyclic_source_dependencies"
AFTER INSERT ON "disposal_matches"
REFERENCING NEW TABLE AS new_dependency_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "assert_cross_source_fifo_dependencies_acyclic"();

CREATE TRIGGER "inventory_allocations_require_acyclic_source_dependencies"
AFTER INSERT ON "inventory_movement_allocations"
REFERENCING NEW TABLE AS new_dependency_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "assert_cross_source_fifo_dependencies_acyclic"();
