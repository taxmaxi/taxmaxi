/**
 * Provider-asset mapping lifecycle status.
 *
 * One source for the status values shared by the database enum, the
 * repository contract, and the REST API schema, so adding a status is one
 * edit instead of three coordinated ones.
 *
 * `excluded` is a final answer, not an open question: the observation never
 * maps to a canonical asset, its transactions stay stored and visible, and
 * the calculation is complete without them. `rejected` stays an open
 * question that keeps blocking the calculation.
 *
 * @module assets/ProviderAssetMappingStatus
 */

import * as Schema from "effect/Schema"

/** Every provider-asset mapping status, in one place. */
export const PROVIDER_ASSET_MAPPING_STATUSES = [
  "approved",
  "pending_review",
  "rejected",
  "excluded",
] as const

/** Schema for the provider-asset mapping lifecycle status. */
export const ProviderAssetMappingStatus = Schema.Literals(PROVIDER_ASSET_MAPPING_STATUSES).annotate(
  {
    identifier: "ProviderAssetMappingStatus",
    title: "Provider Asset Mapping Status",
    description: "Review lifecycle of one provider-asset mapping",
  }
)

/** The ProviderAssetMappingStatus type. */
export type ProviderAssetMappingStatus = typeof ProviderAssetMappingStatus.Type
