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
