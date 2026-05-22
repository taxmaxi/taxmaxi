/**
 * AnonApiLive - Live implementation of anonymous payer-session endpoints.
 *
 * @module AnonApiLive
 */

import { HttpApiBuilder, HttpApp, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SourceId } from "@my/core/source"
import { PrincipalClaimRepository } from "@my/persistence/services"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { InternalServerError, UnauthorizedError } from "../definitions/ApiErrors.ts"
import {
  AnonBadRequestError,
  AnonNotFoundError,
  AnonSessionChallengeResponse,
  AnonSessionDeleteResponse,
  AnonSessionResponse,
  AnonSource,
  AnonSourceListResponse,
} from "../definitions/AnonApi.ts"
import { SourceSyncJobResponse } from "../definitions/SourcesApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { AnonSessionService } from "../services/AnonSessionService.ts"
import {
  SIWXProofVerifier,
  type SIWXProofVerificationError,
} from "../services/SIWXProofVerifier.ts"

export const ANON_SESSION_COOKIE_NAME = "taxmaxi_anon_session"
export const ANON_CHALLENGE_COOKIE_NAME = "taxmaxi_anon_challenge"
export const ANON_SESSION_COOKIE_MAX_AGE = Duration.days(30)
const ANON_CHALLENGE_COOKIE_MAX_AGE = Duration.minutes(10)

const cookieOptionsForEnv = (environment: string, path = "/") => ({
  httpOnly: true,
  secure: environment === "production",
  sameSite: "lax" as const,
  path,
})

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const toAnonSource = (source: {
  readonly sourceId: string
  readonly requestId: string
  readonly chainType: "evm" | "solana" | "bitcoin"
  readonly walletAddress: string
  readonly year: number
  readonly jurisdiction: string
}) =>
  AnonSource.make({
    sourceId: source.sourceId,
    requestId: source.requestId,
    chainType: source.chainType,
    walletAddress: source.walletAddress,
    year: source.year,
    jurisdiction: source.jurisdiction,
  })

const toSyncJobResponse = (job: {
  readonly sourceId: string
  readonly jobId: string
  readonly status: "queued" | "running" | "completed" | "failed"
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
  readonly message: string | null
}) => SourceSyncJobResponse.make(job)

const mapSiwxVerificationError = (error: SIWXProofVerificationError) =>
  new AnonBadRequestError({ message: error.message })

const setCookie = ({
  name,
  value,
  maxAge,
  baseCookieOptions,
}: {
  readonly name: string
  readonly value: string
  readonly maxAge: Duration.Duration
  readonly baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
}) =>
  HttpApp.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, name, value, {
        ...baseCookieOptions,
        maxAge,
      })
    )
  )

const clearCookie = ({
  name,
  baseCookieOptions,
}: {
  readonly name: string
  readonly baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
}) =>
  HttpApp.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, name, "", {
        ...baseCookieOptions,
        expires: new Date(0),
      })
    )
  )

export const AnonApiLive = HttpApiBuilder.group(TaxMaxiApi, "anon", (handlers) =>
  Effect.gen(function* () {
    const principalClaimRepository = yield* PrincipalClaimRepository
    const anonSessionService = yield* AnonSessionService
    const siwxProofVerifier = yield* SIWXProofVerifier
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const baseCookieOptions = cookieOptionsForEnv(environment)

    const resolveSession = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = request.cookies[ANON_SESSION_COOKIE_NAME]
      if (token === undefined || token.trim() === "") {
        return yield* Effect.fail(new UnauthorizedError({ message: "Anon session required." }))
      }
      return yield* anonSessionService
        .verifySessionToken(token)
        .pipe(Effect.mapError(() => new UnauthorizedError({ message: "Anon session required." })))
    })

    const findSource = (sourceId: string) =>
      Effect.gen(function* () {
        const session = yield* resolveSession
        const decodedSourceId = yield* Schema.decodeUnknown(SourceId)(sourceId).pipe(
          Effect.mapError(() => new AnonNotFoundError({ message: "Anonymous source not found." }))
        )
        const maybeSource = yield* principalClaimRepository
          .findAnonymousSourceEntitlementByPayer({
            sourceId: decodedSourceId,
            payerChainType: session.payerChainType,
            payerWalletAddress: session.payerWalletAddress,
          })
          .pipe(Effect.mapError(() => toInternalServerError("Failed to load anonymous source.")))

        if (Option.isNone(maybeSource)) {
          return yield* Effect.fail(
            new AnonNotFoundError({ message: "Anonymous source not found." })
          )
        }

        return { session, source: maybeSource.value }
      })

    return handlers
      .handle("listAnonSources", () =>
        Effect.gen(function* () {
          const session = yield* resolveSession
          const sources = yield* principalClaimRepository
            .findAnonymousSourceEntitlementsByPayer({
              payerChainType: session.payerChainType,
              payerWalletAddress: session.payerWalletAddress,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list anonymous sources.")))
          return AnonSourceListResponse.make({ sources: sources.map(toAnonSource) })
        })
      )
      .handle("getAnonSource", ({ path }) =>
        Effect.gen(function* () {
          const { source } = yield* findSource(path.sourceId)
          return toAnonSource(source)
        })
      )
      .handle("listAnonSourceJobs", ({ path }) =>
        Effect.gen(function* () {
          const { session, source } = yield* findSource(path.sourceId)
          const jobs = yield* principalClaimRepository
            .listAnonymousSourceSyncJobsByPayer({
              sourceId: source.sourceId,
              payerChainType: session.payerChainType,
              payerWalletAddress: session.payerWalletAddress,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to list anonymous jobs.")))
          return { jobs: jobs.map(toSyncJobResponse) }
        })
      )
      .handle("getAnonSourceJob", ({ path }) =>
        Effect.gen(function* () {
          const { session, source } = yield* findSource(path.sourceId)
          const maybeJob = yield* principalClaimRepository
            .findAnonymousSourceSyncJobByPayer({
              sourceId: source.sourceId,
              payerChainType: session.payerChainType,
              payerWalletAddress: session.payerWalletAddress,
              jobId: path.jobId,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to load anonymous job.")))

          if (Option.isNone(maybeJob)) {
            return yield* Effect.fail(new AnonNotFoundError({ message: "Sync job not found." }))
          }

          return toSyncJobResponse(maybeJob.value)
        })
      )
      .handle("createAnonSessionChallenge", () =>
        Effect.gen(function* () {
          const challenge = yield* anonSessionService
            .createChallenge()
            .pipe(Effect.mapError(() => toInternalServerError("Failed to create SIWX challenge.")))
          yield* setCookie({
            name: ANON_CHALLENGE_COOKIE_NAME,
            value: challenge.token,
            maxAge: ANON_CHALLENGE_COOKIE_MAX_AGE,
            baseCookieOptions,
          })
          return AnonSessionChallengeResponse.make({
            nonce: challenge.nonce,
            expiresAt: challenge.expiresAt,
          })
        })
      )
      .handle("createAnonSession", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const challengeToken = request.cookies[ANON_CHALLENGE_COOKIE_NAME]
          if (challengeToken === undefined || challengeToken.trim() === "") {
            return yield* Effect.fail(
              new AnonBadRequestError({ message: "SIWX challenge required." })
            )
          }

          const expectedNonce = yield* anonSessionService
            .verifyChallengeToken(challengeToken)
            .pipe(Effect.mapError((error) => new AnonBadRequestError({ message: error.message })))

          const verified = yield* siwxProofVerifier
            .verify({ proof: payload.siwxProof, expectedNonce })
            .pipe(Effect.mapError(mapSiwxVerificationError))

          const sessionToken = yield* anonSessionService
            .createSessionToken({
              payerChainType: verified.chainType,
              payerWalletAddress: verified.walletAddress,
            })
            .pipe(Effect.mapError(() => toInternalServerError("Failed to create anon session.")))

          yield* setCookie({
            name: ANON_SESSION_COOKIE_NAME,
            value: sessionToken,
            maxAge: ANON_SESSION_COOKIE_MAX_AGE,
            baseCookieOptions,
          })
          yield* clearCookie({ name: ANON_CHALLENGE_COOKIE_NAME, baseCookieOptions })

          return AnonSessionResponse.make({
            payerChainType: verified.chainType,
            payerWalletAddress: verified.walletAddress,
          })
        })
      )
      .handle("deleteAnonSession", () =>
        Effect.gen(function* () {
          yield* clearCookie({ name: ANON_SESSION_COOKIE_NAME, baseCookieOptions })
          yield* clearCookie({ name: ANON_CHALLENGE_COOKIE_NAME, baseCookieOptions })
          return AnonSessionDeleteResponse.make({ ok: true })
        })
      )
  })
)
