export const nextProviderAssetSelection = ({
  reviewedId,
  rowIds,
}: {
  readonly reviewedId: string
  readonly rowIds: ReadonlyArray<string>
}): { readonly remainingIds: ReadonlyArray<string>; readonly selectedId: string | null } => {
  const reviewedIndex = rowIds.indexOf(reviewedId)
  const remainingIds = rowIds.filter((id) => id !== reviewedId)
  const selectedId =
    remainingIds[Math.min(Math.max(reviewedIndex, 0), remainingIds.length - 1)] ?? null

  return { remainingIds, selectedId }
}

export const mergeProviderAssetReplayUpdates = <Replay extends { readonly sourceId: string }>({
  current,
  updates,
}: {
  readonly current: ReadonlyArray<Replay>
  readonly updates: ReadonlyArray<Replay>
}): ReadonlyArray<Replay> => {
  const updatesBySource = new Map(updates.map((replay) => [replay.sourceId, replay]))
  return current.map((replay) => updatesBySource.get(replay.sourceId) ?? replay)
}

export const appendUniqueProviderAssetReviews = <Row extends { readonly id: string }>({
  current,
  incoming,
}: {
  readonly current: ReadonlyArray<Row>
  readonly incoming: ReadonlyArray<Row>
}): ReadonlyArray<Row> => {
  const knownIds = new Set(current.map((row) => row.id))
  return [...current, ...incoming.filter((row) => !knownIds.has(row.id))]
}

export const providerAssetReviewFilterKey = ({
  provider,
  query,
  status,
}: {
  readonly provider?: string
  readonly query?: string
  readonly status: "approved" | "pending_review" | "rejected"
}): string => JSON.stringify([provider ?? null, query ?? null, status])
