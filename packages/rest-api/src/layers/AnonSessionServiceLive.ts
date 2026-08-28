/**
 * AnonSessionServiceLive - HMAC-signed anonymous payer session tokens.
 *
 * @module AnonSessionServiceLive
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Config from "effect/Config"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
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
const MIN_ANON_SESSION_SECRET_LENGTH = 32
const MIN_ANON_SESSION_SECRET_UNIQUE_CHARACTERS = 12
const ANON_SESSION_SECRET_PLACEHOLDERS = new Set(["<generated-secret>"])
const ANON_SESSION_SECRET_ERROR_MESSAGE =
  "ANON_SESSION_SECRET must be a high-entropy value with at least 32 non-whitespace characters; generate it with openssl rand -base64 32"

const randomUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.provide(NodeCrypto.layer),
  Effect.orDie
)

const isValidAnonSessionSecret = (value: string): boolean => {
  if (value.length < MIN_ANON_SESSION_SECRET_LENGTH) return false
  if (new Set(value).size < MIN_ANON_SESSION_SECRET_UNIQUE_CHARACTERS) return false
  if (ANON_SESSION_SECRET_PLACEHOLDERS.has(value.toLowerCase())) return false
  return true
}

const AnonSessionSecret = Schema.Trimmed.check(
  Schema.makeFilter((secret) =>
    isValidAnonSessionSecret(secret) ? undefined : ANON_SESSION_SECRET_ERROR_MESSAGE
  )
)

const anonSessionSecretConfig = Config.string("ANON_SESSION_SECRET").pipe(
  Config.mapOrFail((value) =>
    Schema.decodeEffect(AnonSessionSecret)(value).pipe(
      Effect.mapError((error) => new Config.ConfigError(error))
    )
  ),
  Config.map(Redacted.make)
)

const AnonSessionPayload = Schema.Struct({
  kind: Schema.Literal("anon_session"),
  payerChainType: Schema.Literals(["evm", "solana", "bitcoin"]),
  payerWalletAddress: Schema.Trimmed.check(Schema.isNonEmpty()),
  expiresAt: Schema.Finite,
})

const AnonChallengePayload = Schema.Struct({
  kind: Schema.Literal("anon_challenge"),
  nonce: Schema.Trimmed.check(Schema.isNonEmpty()),
  expiresAt: Schema.Finite,
})

const tokenError = (message: string) => new AnonSessionTokenError({ message })
const JsonPayload = Schema.fromJsonString(Schema.Unknown)

const currentTimeMillis = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (millis) => Number(millis)
)

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
      return yield* tokenError("Invalid anon session token.")
    }
    const decoded = yield* base64UrlDecode(payload)
    const parsed = yield* Schema.decodeEffect(JsonPayload)(decoded).pipe(
      Effect.mapError(() => tokenError("Invalid anon session token."))
    )
    return { payload, signature, parsed }
  })

const make = Effect.gen(function* () {
  const secret = yield* anonSessionSecretConfig

  const createSignedToken = (payload: unknown): Effect.Effect<string, AnonSessionTokenError> =>
    Effect.gen(function* () {
      const serialized = yield* Schema.encodeUnknownEffect(JsonPayload)(payload).pipe(
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
        return yield* tokenError("Invalid anon session token.")
      }
      return parsedToken.parsed
    })

  const createSessionToken: AnonSessionServiceShape["createSessionToken"] = (subject) =>
    Effect.gen(function* () {
      const now = yield* currentTimeMillis
      return yield* createSignedToken({
        kind: "anon_session",
        payerChainType: subject.payerChainType,
        payerWalletAddress: subject.payerWalletAddress,
        expiresAt: now + SESSION_TTL_MILLIS,
      })
    })

  const verifySessionToken: AnonSessionServiceShape["verifySessionToken"] = (token) =>
    Effect.gen(function* () {
      const payload = yield* verifySignedPayload(token)
      const session = yield* Schema.decodeUnknownEffect(AnonSessionPayload)(payload).pipe(
        Effect.mapError(() => tokenError("Invalid anon session token."))
      )
      const now = yield* currentTimeMillis
      if (session.expiresAt <= now) {
        return yield* tokenError("Anon session expired.")
      }
      return {
        payerChainType: session.payerChainType,
        payerWalletAddress: session.payerWalletAddress,
      } satisfies AnonPayerSessionSubject
    })

  const createChallenge: AnonSessionServiceShape["createChallenge"] = Effect.gen(function* () {
    const nonce = yield* randomUuid
    const now = yield* currentTimeMillis
    const expiresAt = now + CHALLENGE_TTL_MILLIS
    const token = yield* createSignedToken({
      kind: "anon_challenge",
      nonce,
      expiresAt,
    })
    return {
      nonce,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
      token,
    }
  })

  const verifyChallengeToken: AnonSessionServiceShape["verifyChallengeToken"] = (token) =>
    Effect.gen(function* () {
      const payload = yield* verifySignedPayload(token)
      const challenge = yield* Schema.decodeUnknownEffect(AnonChallengePayload)(payload).pipe(
        Effect.mapError(() => tokenError("Invalid anon session challenge."))
      )
      const now = yield* currentTimeMillis
      if (challenge.expiresAt <= now) {
        return yield* tokenError("Anon session challenge expired.")
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
