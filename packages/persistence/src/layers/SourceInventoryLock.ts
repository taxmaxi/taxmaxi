/**
 * SourceInventoryLock - Shared ordering for source-owned FIFO mutations.
 *
 * @module SourceInventoryLock
 */

import { sql, type SQL } from "drizzle-orm"

/**
 * Lock source inventories in one deterministic order.
 *
 * Every transaction that validates or changes FIFO relationships must acquire
 * this advisory lock before reading allocations or matches. Advisory locks do
 * not interfere with foreign keys that only reference a source row.
 */
export const sourceInventoryLockQuery = (sourceIds: ReadonlyArray<string>): SQL => {
  const sortedSourceIds = [...new Set(sourceIds)].sort()
  return sql`
    select pg_advisory_xact_lock(hashtextextended('source-inventory:' || source_id::text, 0))
    from (
      select source_id
      from unnest(array[${sql.join(
        sortedSourceIds.map((sourceId) => sql`${sourceId}::uuid`),
        sql`, `
      )}]) as source_inventory(source_id)
      order by source_id
    ) ordered_source_inventory
  `
}
