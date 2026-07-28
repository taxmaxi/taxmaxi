/**
 * ProviderAssetRepositoryLive - Provider asset identity and mapping persistence.
 *
 * @module ProviderAssetRepositoryLive
 */

import { ProviderAssetRepository } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { makeProviderAssetRepositories } from "./ProviderAssetRepositories.ts"

/** Live PostgreSQL adapter for provider asset ingestion and mapping resolution. */
export const ProviderAssetRepositoryLive = Layer.effect(
  ProviderAssetRepository,
  Effect.map(
    makeProviderAssetRepositories,
    ({ providerAssetRepository }) => providerAssetRepository
  )
)
