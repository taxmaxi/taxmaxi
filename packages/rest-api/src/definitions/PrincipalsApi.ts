/**
 * PrincipalsApi - HTTP API group for ownership principal operations.
 *
 * @module PrincipalsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

/**
 * PrincipalClaimBadRequestError - Invalid principal claim request.
 */
export class PrincipalClaimBadRequestError extends Schema.TaggedError<PrincipalClaimBadRequestError>()(
  "PrincipalClaimBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 })
) {}

/**
 * PrincipalClaimNotFoundError - Claim token did not match a stored claim.
 */
export class PrincipalClaimNotFoundError extends Schema.TaggedError<PrincipalClaimNotFoundError>()(
  "PrincipalClaimNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

/**
 * PrincipalClaimConflictError - Claim cannot be applied without merging existing data.
 */
export class PrincipalClaimConflictError extends Schema.TaggedError<PrincipalClaimConflictError>()(
  "PrincipalClaimConflictError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 409 })
) {}

/**
 * PrincipalClaimRequest - Claim token submitted by an authenticated user.
 */
export class PrincipalClaimRequest extends Schema.Class<PrincipalClaimRequest>(
  "PrincipalClaimRequest"
)({
  requestId: Schema.UUID,
  claimToken: Schema.NonEmptyTrimmedString,
  siwxProof: Schema.NullOr(Schema.Unknown),
}) {}

/**
 * PrincipalClaimResponse - Matched source claim.
 */
export class PrincipalClaimResponse extends Schema.Class<PrincipalClaimResponse>(
  "PrincipalClaimResponse"
)({
  sourceId: Schema.String,
}) {}

/**
 * POST /principals/claim - Claim an anonymous principal resource.
 */
const claimPrincipal = HttpApiEndpoint.post("claimPrincipal", "/principals/claim")
  .setPayload(PrincipalClaimRequest)
  .addSuccess(PrincipalClaimResponse)
  .addError(PrincipalClaimBadRequestError)
  .addError(PrincipalClaimNotFoundError)
  .addError(PrincipalClaimConflictError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Claim principal resource",
      description:
        "Validates an anonymous wallet source claim token and moves the claimed source to the authenticated user.",
    })
  )

/**
 * PrincipalsApi - Protected ownership principal endpoints.
 */
export class PrincipalsApi extends HttpApiGroup.make("principals")
  .add(claimPrincipal)
  .middlewareEndpoints(AuthMiddleware)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Principals",
      description: "Endpoints for claiming principal-owned resources.",
    })
  ) {}
