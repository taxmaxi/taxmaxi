/**
 * AssetOverrideApplicationReadiness - Causal completion for override replays.
 *
 * @module AssetOverrideApplicationReadiness
 */

/** The durable replay state needed to decide whether one application is settled. */
export interface AssetOverrideApplicationReadinessRow {
  readonly overrideId: string
  readonly sourceId: string
  readonly replayJobId: string | null
  readonly dependsOnSourceIds: ReadonlyArray<string>
  readonly jobStatus: "pending" | "processing" | "completed" | "failed" | "credit_required" | null
  readonly failedRecords: number
}

/**
 * Resolve replay readiness over the downstream dependency closure of the roots.
 *
 * Applications for the same override are related only when a dependent names
 * an owner source. This keeps unrelated sibling applications from blocking one
 * another while ensuring every direct and transitive FIFO consumer settles
 * before an owner's tax inputs are considered stable.
 */
export const resolveAssetOverrideApplicationReadiness = ({
  rows,
  rootSourceIds,
  requiredOverrideIds = [],
}: {
  readonly rows: ReadonlyArray<AssetOverrideApplicationReadinessRow>
  readonly rootSourceIds: ReadonlyArray<string>
  readonly requiredOverrideIds?: ReadonlyArray<string>
}): "updating" | "complete" | "failed" => {
  const rootSourceIdSet = new Set(rootSourceIds)
  const requiredOverrideIdSet = new Set(requiredOverrideIds)
  const candidates =
    requiredOverrideIdSet.size === 0
      ? rows
      : rows.filter((row) => requiredOverrideIdSet.has(row.overrideId))

  if (
    requiredOverrideIds.some((overrideId) =>
      rootSourceIds.some(
        (sourceId) =>
          !candidates.some((row) => row.overrideId === overrideId && row.sourceId === sourceId)
      )
    )
  ) {
    return "updating"
  }

  const closure = candidates.filter((row) => rootSourceIdSet.has(row.sourceId))
  const visited = new Set(closure.map((row) => `${row.overrideId}:${row.sourceId}`))

  for (let index = 0; index < closure.length; index += 1) {
    const owner = closure[index]
    if (owner === undefined) continue
    for (const dependent of candidates) {
      const key = `${dependent.overrideId}:${dependent.sourceId}`
      if (
        dependent.overrideId === owner.overrideId &&
        dependent.dependsOnSourceIds.includes(owner.sourceId) &&
        !visited.has(key)
      ) {
        visited.add(key)
        closure.push(dependent)
      }
    }
  }

  if (
    closure.some(
      (row) =>
        row.jobStatus === "failed" ||
        row.jobStatus === "credit_required" ||
        (row.jobStatus === "completed" && row.failedRecords > 0)
    )
  ) {
    return "failed"
  }

  return closure.some(
    (row) => row.replayJobId === null || row.jobStatus !== "completed" || row.failedRecords !== 0
  )
    ? "updating"
    : "complete"
}
