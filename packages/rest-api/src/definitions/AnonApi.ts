/**
 * AnonApi - HTTP API group for scoped anonymous payer sessions.
 *
 * @module AnonApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { InternalServerError, UnauthorizedError } from "./ApiErrors.ts"
import { SourceSyncJobResponse } from "./SourcesApi.ts"

/**
 * AnonBadRequestError - Invalid anonymous session request.
 */
export class AnonBadRequestError extends Schema.TaggedError<AnonBadRequestError>()(
  "AnonBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {}

/**
 * AnonNotFoundError - Anonymous paid source or job is not visible to the payer session.
 */
export class AnonNotFoundError extends Schema.TaggedError<AnonNotFoundError>()(
  "AnonNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

/**
 * AnonSource - Anonymous paid source handle.
 */
export class AnonSource extends Schema.Class<AnonSource>("AnonSource")({
  sourceId: Schema.String,
  requestId: Schema.String,
  chainType: Schema.Literals(["evm", "solana", "bitcoin"]),
  walletAddress: Schema.String,
  year: Schema.Finite,
  jurisdiction: Schema.String,
}) {}

/**
 * AnonSourceListResponse - Anonymous paid source handles for the payer session.
 */
export class AnonSourceListResponse extends Schema.Class<AnonSourceListResponse>(
  "AnonSourceListResponse"
)({
  sources: Schema.Array(AnonSource),
}) {}

/**
 * AnonSessionChallengeResponse - SIWX recovery nonce.
 */
export class AnonSessionChallengeResponse extends Schema.Class<AnonSessionChallengeResponse>(
  "AnonSessionChallengeResponse"
)({
  nonce: Schema.String,
  expiresAt: Schema.String,
}) {}

/**
 * AnonSessionCreateRequest - SIWX recovery proof.
 */
export class AnonSessionCreateRequest extends Schema.Class<AnonSessionCreateRequest>(
  "AnonSessionCreateRequest"
)({
  siwxProof: Schema.Unknown,
}) {}

/**
 * AnonSessionResponse - Active anon payer session subject.
 */
export class AnonSessionResponse extends Schema.Class<AnonSessionResponse>("AnonSessionResponse")({
  payerChainType: Schema.Literals(["evm", "solana", "bitcoin"]),
  payerWalletAddress: Schema.String,
}) {}

/**
 * AnonSessionDeleteResponse - Logout result.
 */
export class AnonSessionDeleteResponse extends Schema.Class<AnonSessionDeleteResponse>(
  "AnonSessionDeleteResponse"
)({
  ok: Schema.Boolean,
}) {}

const listAnonSources = HttpApiEndpoint.get("listAnonSources", "/anon/sources", {
  success: AnonSourceListResponse,
  error: [UnauthorizedError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List anonymous paid sources",
    description: "Lists unclaimed anonymous paid sources for the anon payer session.",
  })
)

const getAnonSource = HttpApiEndpoint.get("getAnonSource", "/anon/sources/:sourceId", {
  params: Schema.Struct({ sourceId: Schema.String.check(Schema.isUUID()) }),
  success: AnonSource,
  error: [UnauthorizedError, AnonNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get anonymous paid source",
    description: "Returns one unclaimed anonymous paid source for the anon payer session.",
  })
)

const listAnonSourceJobs = HttpApiEndpoint.get(
  "listAnonSourceJobs",
  "/anon/sources/:sourceId/jobs",
  {
    params: Schema.Struct({ sourceId: Schema.String.check(Schema.isUUID()) }),
    success: Schema.Struct({ jobs: Schema.Array(SourceSyncJobResponse) }),
    error: [UnauthorizedError, AnonNotFoundError, InternalServerError],
  }
)

const getAnonSourceJob = HttpApiEndpoint.get(
  "getAnonSourceJob",
  "/anon/sources/:sourceId/jobs/:jobId",
  {
    params: Schema.Struct({
      sourceId: Schema.String.check(Schema.isUUID()),
      jobId: Schema.String.check(Schema.isUUID()),
    }),
    success: SourceSyncJobResponse,
    error: [UnauthorizedError, AnonNotFoundError, InternalServerError],
  }
)

const createAnonSessionChallenge = HttpApiEndpoint.post(
  "createAnonSessionChallenge",
  "/anon/session/challenge",
  {
    success: AnonSessionChallengeResponse,
    error: InternalServerError,
  }
)

const createAnonSession = HttpApiEndpoint.post("createAnonSession", "/anon/session", {
  payload: Schema.Struct(AnonSessionCreateRequest.fields),
  success: AnonSessionResponse,
  error: [AnonBadRequestError, InternalServerError],
})

const deleteAnonSession = HttpApiEndpoint.delete("deleteAnonSession", "/anon/session", {
  success: AnonSessionDeleteResponse,
  error: InternalServerError,
})

/**
 * AnonApi - Public anonymous payer-session endpoints.
 */
export class AnonApi extends HttpApiGroup.make("anon")
  .add(listAnonSources)
  .add(getAnonSource)
  .add(listAnonSourceJobs)
  .add(getAnonSourceJob)
  .add(createAnonSessionChallenge)
  .add(createAnonSession)
  .add(deleteAnonSession)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Anonymous payer session",
      description: "Scoped anonymous paid source access.",
    })
  ) {}
