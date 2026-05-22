/**
 * AnonSessionServiceLive - HMAC-signed anonymous payer session tokens.
 *
 * @module AnonSessionServiceLive
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  AnonSessionService,
  AnonSessionTokenError,
  type AnonPayerSessionSubject,
  type AnonSessionServiceShape,
} from "../services/AnonSessionService.ts"

const SESSION_TTL_MILLIS = 30 * 24 * 60 * 60 * 1000
const CHALLENGE_TTL_MILLIS = 10 * 60 * 1000

const anonSessionSecretConfig = Config.redacted("ANON_SESSION_SECRET")

const AnonSessionPayload = Schema.Struct({
  kind: Schema.Literal("anon_session"),
  payerChainType: Schema.Literal("evm", "solana", "bitcoin"),
  payerWalletAddress: Schema.NonEmptyTrimmedString,
  expiresAt: Schema.Number,
})

const AnonChallengePayload = Schema.Struct({
  kind: Schema.Literal("anon_challenge"),
  nonce: Schema.NonEmptyTrimmedString,
  expiresAt: Schema.Number,
})

const tokenError = (message: string) => new AnonSessionTokenError({ message })
const JsonPayload = Schema.parseJson()

const base64UrlEncode = (value: string): string => Buffer.from(value).toString("base64url")

const base64UrlDecode = (value: string): Effect.Effect<string, AnonSessionTokenError> =>
  Effect.try({
    try: () => Buffer.from(value, "base64url").toString("utf8"),
    catch: () => tokenError("Invalid anon session token."),
  })

const signPayload = ({
  payload,
  secret,
}: {
  readonly payload: string
  readonly secret: Redacted.Redacted<string>
}): string => createHmac("sha256", Redacted.value(secret)).update(payload).digest("base64url")

const verifySignature = ({
  payload,
  signature,
  secret,
}: {
  readonly payload: string
  readonly signature: string
  readonly secret: Redacted.Redacted<string>
}): boolean => {
  const expected = signPayload({ payload, secret })
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signature)
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  )
}

const parseToken = (token: string) =>
  Effect.gen(function* () {
    const [payload, signature] = token.split(".", 2)
    if (payload === undefined || signature === undefined || payload === "" || signature === "") {
      return yield* Effect.fail(tokenError("Invalid anon session token."))
    }
    const decoded = yield* base64UrlDecode(payload)
    const parsed = yield* Schema.decodeUnknown(JsonPayload)(decoded).pipe(
      Effect.mapError(() => tokenError("Invalid anon session token."))
    )
    return { payload, signature, parsed }
  })

const make = Effect.gen(function* () {
  const secret = yield* anonSessionSecretConfig

  const createSignedToken = (payload: unknown): Effect.Effect<string, AnonSessionTokenError> =>
    Effect.gen(function* () {
      const serialized = yield* Schema.encodeUnknown(JsonPayload)(payload).pipe(
        Effect.mapError(() => tokenError("Failed to create anon session token."))
      )
      const encodedPayload = base64UrlEncode(serialized)
      return `${encodedPayload}.${signPayload({ payload: encodedPayload, secret })}`
    })

  const verifySignedPayload = (token: string) =>
    Effect.gen(function* () {
      const parsedToken = yield* parseToken(token)
      if (
        !verifySignature({
          payload: parsedToken.payload,
          signature: parsedToken.signature,
          secret,
        })
      ) {
        return yield* Effect.fail(tokenError("Invalid anon session token."))
      }
      return parsedToken.parsed
    })

  const createSessionToken: AnonSessionServiceShape["createSessionToken"] = (subject) =>
    createSignedToken({
      kind: "anon_session",
      payerChainType: subject.payerChainType,
      payerWalletAddress: subject.payerWalletAddress,
      expiresAt: Date.now() + SESSION_TTL_MILLIS,
    })

  const verifySessionToken: AnonSessionServiceShape["verifySessionToken"] = (token) =>
    Effect.gen(function* () {
      const payload = yield* verifySignedPayload(token)
      const session = yield* Schema.decodeUnknown(AnonSessionPayload)(payload).pipe(
        Effect.mapError(() => tokenError("Invalid anon session token."))
      )
      if (session.expiresAt <= Date.now()) {
        return yield* Effect.fail(tokenError("Anon session expired."))
      }
      return {
        payerChainType: session.payerChainType,
        payerWalletAddress: session.payerWalletAddress,
      } satisfies AnonPayerSessionSubject
    })

  const createChallenge: AnonSessionServiceShape["createChallenge"] = () =>
    Effect.gen(function* () {
      const nonce = crypto.randomUUID()
      const expiresAt = Date.now() + CHALLENGE_TTL_MILLIS
      const token = yield* createSignedToken({
        kind: "anon_challenge",
        nonce,
        expiresAt,
      })
      return { nonce, expiresAt: new Date(expiresAt).toISOString(), token }
    })

  const verifyChallengeToken: AnonSessionServiceShape["verifyChallengeToken"] = (token) =>
    Effect.gen(function* () {
      const payload = yield* verifySignedPayload(token)
      const challenge = yield* Schema.decodeUnknown(AnonChallengePayload)(payload).pipe(
        Effect.mapError(() => tokenError("Invalid anon session challenge."))
      )
      if (challenge.expiresAt <= Date.now()) {
        return yield* Effect.fail(tokenError("Anon session challenge expired."))
      }
      return challenge.nonce
    })

  return AnonSessionService.of({
    createSessionToken,
    verifySessionToken,
    createChallenge,
    verifyChallengeToken,
  } satisfies AnonSessionServiceShape)
})

/**
 * AnonSessionServiceLive - Live anonymous payer session token layer.
 */
export const AnonSessionServiceLive = Layer.effect(AnonSessionService, make)
