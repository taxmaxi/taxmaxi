/**
 * ProviderAssetReviewRepositoryLive - Provider asset review queue and decision persistence.
 *
 * @module ProviderAssetReviewRepositoryLive
 */

import { ProviderAssetReviewRepository } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { makeProviderAssetRepositories } from "./ProviderAssetRepositories.ts"

/** Live PostgreSQL adapter for provider asset review and replay associations. */
export const ProviderAssetReviewRepositoryLive = Layer.effect(
  ProviderAssetReviewRepository,
  Effect.map(
    makeProviderAssetRepositories,
    ({ providerAssetReviewRepository }) => providerAssetReviewRepository
  )
)
