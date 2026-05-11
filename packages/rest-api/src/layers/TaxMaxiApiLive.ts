/**
 * TaxMaxiApiLive - Live implementation layer for the TaxMaxi API
 *
 * Combines all API group implementations into a complete API layer that can be served.
 *
 * @module TaxMaxiApiLive
 */

import { HttpApiBuilder, type HttpApi } from "@effect/platform"
import type { PasswordHasher, AuthService } from "@my/core/authentication"
import type { LegalReferenceRepository } from "@my/core/legal"
import type {
  CexAccountRepository,
  IdentityRepository,
  OAuthStateStore,
  SessionRepository,
  SourceRepository as PersistenceSourceRepository,
  TaxCalculationService,
  UserRepository,
} from "@my/persistence/services"
import type {
  SourceRepository as SyncEngineSourceRepository,
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import type * as ConfigError from "effect/ConfigError"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TaxMaxiApi, HealthCheckResponse } from "../definitions/TaxMaxiApi.ts"
import { TokenValidator } from "../definitions/AuthMiddleware.ts"
import { AuthMiddlewareLive } from "./AuthMiddlewareLive.ts"
import { AuthApiLive, AuthSessionApiLive, CoinbaseCompatApiLive } from "./AuthApiLive.ts"
import { LegalReferenceApiLive } from "./LegalReferenceApiLive.ts"
import { SourcesApiLive } from "./SourcesApiLive.ts"
import { SyncRunsApiLive } from "./SyncRunsApiLive.ts"

// =============================================================================
// Health API Implementation
// =============================================================================

/**
 * HealthApiLive - Health check endpoint implementation
 *
 * Simple handler that returns the current health status.
 * This endpoint is not protected by authentication.
 */
const HealthApiLive = HttpApiBuilder.group(TaxMaxiApi, "health", (handlers) =>
  Effect.succeed(
    handlers.handle("healthCheck", () =>
      Effect.succeed(
        HealthCheckResponse.make({
          status: "ok",
          timestamp: new Date().toISOString(),
          version: Option.some("0.0.1"),
        })
      )
    )
  )
)

/**
 * CoreApiGroup - First group of core API implementations
 *
 * Merged to reduce the number of Layer.provide calls in the main chain
 * (TypeScript has a limit of ~20 arguments in pipe).
 */
const CoreApiGroup = Layer.mergeAll(
  HealthApiLive,
  AuthApiLive,
  CoinbaseCompatApiLive,
  AuthSessionApiLive,
  LegalReferenceApiLive,
  SourcesApiLive,
  SyncRunsApiLive,
)

type TaxMaxiApiLiveContext =
  | AuthService
  | CexAccountRepository
  | IdentityRepository
  | LegalReferenceRepository
  | OAuthStateStore
  | PasswordHasher
  | PersistenceSourceRepository
  | SessionRepository
  | SourceSyncRunService
  | SourceSyncService
  | SyncEngineSourceRepository
  | TaxCalculationService
  | TokenValidator
  | TransferReconciliationService
  | UserRepository

/**
 * MasterDataApiGroup - Master data API implementations
 */
// const MasterDataApiGroup = Layer.mergeAll(UserWorkspacesApiLive)

// =============================================================================
// Complete API Layer
// =============================================================================

/**
 * TaxMaxiApiLive - Complete API layer combining all implementations
 *
 * Provides:
 * - Health check (unprotected)
 * - Legal references API (unprotected)
 *
 * Dependencies (required from consumer):
 * - Auth, source sync, legal reference, and tax calculation services
 */
export const TaxMaxiApiLive: Layer.Layer<
  HttpApi.Api,
  ConfigError.ConfigError,
  TaxMaxiApiLiveContext
> = HttpApiBuilder.api(TaxMaxiApi).pipe(
  // Core API group (merged to reduce pipe arguments)
  Layer.provide(CoreApiGroup),
  // Layer.provide(MasterDataApiGroup),
  // Feature-specific APIs with dependencies
  // TODO: Layer.provide(MembershipPolicyApiGroup),
  // Authorization infrastructure
  // AuthorizationServiceWithDependencies provides ABAC+RBAC permission checking
  // Uses ABAC when policies exist, falls back to RBAC when no policies
  // Includes PolicyEngineLive for ABAC policy evaluation
  // TODO: Layer.provide(AuthorizationServiceWithDependencies),
  // AuthorizationConfigLive provides AUTHORIZATION_ENFORCEMENT env var
  // Set to false for grace period (skip membership checks), true for strict enforcement
  // TODO: Layer.provide(AuthorizationConfigLive),
  // AuthMiddlewareLive requires TokenValidator to be provided externally
  // - For production: use SessionTokenValidatorLive (validates against database)
  // - For testing: use SimpleTokenValidatorLive (user_<id>_<role> format)
  Layer.provide(AuthMiddlewareLive),
)
