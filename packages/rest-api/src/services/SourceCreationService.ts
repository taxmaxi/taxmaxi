/**
 * SourceCreationService - Application workflow for source creation.
 *
 * @module SourceCreationService
 */

import type { Source } from "@my/core/source";
import type { SourceSyncJobSummary } from "@my/sync-engine/services";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { User } from "../definitions/AuthMiddleware.ts";
import type { SourceCreateRequest } from "../definitions/SourcesApi.ts";

/**
 * SourceCreationBadRequestError - Caller supplied invalid source input.
 */
export class SourceCreationBadRequestError extends Schema.TaggedError<SourceCreationBadRequestError>()(
  "SourceCreationBadRequestError",
  {
    message: Schema.String,
  },
) {}

/**
 * SourceCreationInternalError - Source creation failed after request validation.
 */
export class SourceCreationInternalError extends Schema.TaggedError<SourceCreationInternalError>()(
  "SourceCreationInternalError",
  {
    message: Schema.String,
  },
) {}

/**
 * SourceCreationPaymentRequiredError - Anonymous source creation requires x402 payment.
 */
export class SourceCreationPaymentRequiredError extends Schema.TaggedError<SourceCreationPaymentRequiredError>()(
  "SourceCreationPaymentRequiredError",
  {
    message: Schema.String,
  },
) {}

/**
 * SourceCreationClaimMetadata - Anonymous source claim handle.
 */
export interface SourceCreationClaimMetadata {
  readonly requestId: string;
  readonly claimToken: string;
  readonly expiresAt: string;
}

/**
 * SourceCreationResult - Created or reused source plus optional side effects.
 */
export interface SourceCreationResult {
  readonly source: Source;
  readonly created: boolean;
  readonly syncJob: SourceSyncJobSummary | null;
  readonly claim: SourceCreationClaimMetadata | null;
}

/**
 * CreateSourceParams - Inputs for optional-auth source creation.
 */
export interface CreateSourceParams {
  readonly currentUser: Option.Option<User>;
  readonly paymentHeader: Option.Option<string>;
  readonly payload: SourceCreateRequest;
}

/**
 * SourceCreationError - Typed failures from source creation orchestration.
 */
export type SourceCreationError =
  | SourceCreationBadRequestError
  | SourceCreationInternalError
  | SourceCreationPaymentRequiredError;

/**
 * SourceCreationServiceShape - Optional-auth source creation use case.
 */
export interface SourceCreationServiceShape {
  /**
   * Create or reuse a source for an authenticated user, or create an anonymous
   * claimable source when no user is present.
   */
  readonly createSource: (
    params: CreateSourceParams,
  ) => Effect.Effect<SourceCreationResult, SourceCreationError>;
}

/**
 * SourceCreationService - Context tag for source creation orchestration.
 */
export class SourceCreationService extends Context.Tag("@my/rest-api/SourceCreationService")<
  SourceCreationService,
  SourceCreationServiceShape
>() {}
