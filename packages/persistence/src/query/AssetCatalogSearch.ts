/**
 * AssetCatalogSearch - Shared search-token handling for public asset catalog queries.
 *
 * @module AssetCatalogSearch
 */

const escapeLikeToken = (token: string): string =>
  token.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")

/** Split a catalog query into literal PostgreSQL ILIKE patterns. */
export function getAssetCatalogSearchPatterns(query: string): ReadonlyArray<string> {
  const trimmedQuery = query.trim()

  if (trimmedQuery.length === 0) {
    return []
  }

  return trimmedQuery.split(/\s+/).map((token) => `%${escapeLikeToken(token)}%`)
}
