/**
 * SourceCreationServiceLive - Live source creation application workflow.
 *
 * @module SourceCreationServiceLive
 */

import type { PrincipalId } from "@my/core/ownership"
import { parseCryptoAddress, SourceId, type ChainType } from "@my/core/source"
import {
  PrincipalClaimRepository,
  PrincipalRepository,
  SourceRepository,
  type AnonymousSourceEntitlement,
} from "@my/persistence/services"
import { SourceSyncService } from "@my/sync-engine/services"
import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Option } from "effect"
import * as Redacted from "effect/Redacted"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { claimTokenPepperConfig, hashAnonymousSourceClaimToken } from "../helpers/ClaimTokenHash.ts"
import type { User } from "../definitions/AuthMiddleware.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"
import {
  SourceCreationBadRequestError,
  SourceCreationInternalError,
  SourceCreationPaymentRequiredError,
  SourceCreationService,
  type SourceCreationServiceShape,
} from "../services/SourceCreationService.ts"
import {
  X402PaymentValidator,
  type X402PaymentSettlement,
  type X402VerifiedPayment,
} from "../services/X402PaymentValidator.ts"

const ANONYMOUS_SOURCE_CLAIM_TOKEN_BYTES = 32
const ANONYMOUS_SOURCE_CLAIM_TTL_MILLIS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_CLAIM_JURISDICTION = "germany"

const toBadRequestError = (message: string) => new SourceCreationBadRequestError({ message })
const toInternalError = (message: string) => new SourceCreationInternalError({ message })
const toPaymentRequiredError = ({
  message,
  paymentRequired,
  paymentRequiredHeader,
}: {
  readonly message: string
  readonly paymentRequired?: unknown
  readonly paymentRequiredHeader?: string | undefined
}) => new SourceCreationPaymentRequiredError({ message, paymentRequired, paymentRequiredHeader })

const generateClaimToken = (): string => {
  const bytes = new Uint8Array(ANONYMOUS_SOURCE_CLAIM_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

const hashReceiptValue = (receiptValue: string): string =>
  createHash("sha256").update("x402_receipt").update("\0").update(receiptValue).digest("hex")

export const SourceCreationServiceLive = Layer.effect(
  SourceCreationService,
  Effect.gen(function* () {
    const principalRepository = yield* PrincipalRepository
    const principalClaimRepository = yield* PrincipalClaimRepository
    const sourceRepository = yield* SourceRepository
    const sourceSyncService = yield* SourceSyncService
    const x402PaymentValidator = yield* X402PaymentValidator
    const principalResolutionService = yield* PrincipalResolutionService

    const resolveCreatePrincipal = (currentUser: Option.Option<User>) =>
      Effect.gen(function* () {
        if (Option.isSome(currentUser)) {
          const principal = yield* principalResolutionService
            .resolveUserPrincipal(currentUser.value)
            .pipe(Effect.mapError((error) => toInternalError(error.message)))
          return { principal, isAnonymous: false } as const
        }

        const principal = yield* principalRepository
          .createAnonymousWalletPrincipal()
          .pipe(Effect.mapError(() => toInternalError("Failed to create anonymous principal.")))

        return { principal, isAnonymous: true } as const
      })

    const createOnchainSource = ({
      principalId,
      parsedAddress,
      name,
    }: {
      readonly principalId: PrincipalId
      readonly parsedAddress: NonNullable<ReturnType<typeof parseCryptoAddress>>
      readonly name?: string | undefined
    }) =>
      Effect.gen(function* () {
        const sourceName =
          name ?? `${parsedAddress.address.slice(0, 5)}...${parsedAddress.address.slice(-5)}`

        const created = yield* sourceRepository
          .createOrReuseOnchainSource({
            principalId,
            chainType: parsedAddress.chainType,
            walletAddress: parsedAddress.address,
            name: sourceName,
          })
          .pipe(Effect.mapError(() => toInternalError("Failed to create or reuse source.")))

        return { ...created, parsedAddress }
      })

    const parseWalletAddress = (walletAddress: string) =>
      Effect.gen(function* () {
        const parsedAddress = parseCryptoAddress(walletAddress)
        if (parsedAddress === null) {
          return yield* Effect.fail(toBadRequestError("Invalid crypto address."))
        }

        return parsedAddress
      })

    const findExistingAnonymousPaidSource = ({
      anonPayerSession,
      chainType,
      walletAddress,
      year,
      jurisdiction,
    }: {
      readonly anonPayerSession: Option.Option<{
        readonly payerChainType: ChainType
        readonly payerWalletAddress: string
      }>
      readonly chainType: ChainType
      readonly walletAddress: string
      readonly year: number
      readonly jurisdiction: string
    }) =>
      Effect.gen(function* () {
        if (Option.isNone(anonPayerSession)) {
          return Option.none<AnonymousSourceEntitlement>()
        }

        const entitlements = yield* principalClaimRepository
          .findAnonymousSourceEntitlementsByPayer({
            payerChainType: anonPayerSession.value.payerChainType,
            payerWalletAddress: anonPayerSession.value.payerWalletAddress,
          })
          .pipe(Effect.mapError(() => toInternalError("Failed to list anonymous sources.")))

        return Option.fromNullable(
          entitlements.find(
            (entitlement) =>
              entitlement.chainType === chainType &&
              entitlement.walletAddress === walletAddress &&
              entitlement.year === year &&
              entitlement.jurisdiction === jurisdiction
          )
        )
      })

    const validateAnonymousPayment = ({
      paymentHeader,
      parsedAddress,
      year,
      jurisdiction,
    }: {
      readonly paymentHeader: Option.Option<string>
      readonly parsedAddress: NonNullable<ReturnType<typeof parseCryptoAddress>>
      readonly year: number
      readonly jurisdiction: string
    }): Effect.Effect<X402VerifiedPayment, SourceCreationPaymentRequiredError> =>
      x402PaymentValidator
        .validateAnonymousSourceCreation({
          paymentHeader,
          chainType: parsedAddress.chainType,
          walletAddress: parsedAddress.address,
          year,
          jurisdiction,
        })
        .pipe(
          Effect.mapError((error) =>
            toPaymentRequiredError({
              message: error.message,
              paymentRequired: error.paymentRequired,
              paymentRequiredHeader: error.paymentRequiredHeader,
            })
          )
        )

    const loadClaimTokenPepper = Effect.gen(function* () {
      const pepper = yield* Effect.configProviderWith((provider) =>
        provider
          .load(claimTokenPepperConfig)
          .pipe(Effect.mapError(() => toInternalError("Missing claim token pepper.")))
      )
      if (Redacted.value(pepper).trim() === "") {
        return yield* Effect.fail(toInternalError("Missing claim token pepper."))
      }
      return pepper
    })

    const createAnonymousSourceClaim = ({
      principalId,
      sourceId,
      requestId,
      chainType,
      walletAddress,
      year,
      jurisdiction,
      pepper,
    }: {
      readonly principalId: PrincipalId
      readonly sourceId: SourceId
      readonly requestId: string
      readonly chainType: ChainType
      readonly walletAddress: string
      readonly year: number
      readonly jurisdiction: string
      readonly pepper: Redacted.Redacted<string>
    }) =>
      Effect.gen(function* () {
        const claimToken = generateClaimToken()
        const expiresAt = Timestamp.addMillis(
          Timestamp.now(),
          ANONYMOUS_SOURCE_CLAIM_TTL_MILLIS
        ).toDate()

        yield* principalClaimRepository
          .create({
            principalId,
            sourceId,
            requestId,
            claimType: "anonymous_source_claim_token",
            claimValueHash: hashAnonymousSourceClaimToken({ claimToken, pepper }),
            chainType,
            walletAddress,
            payerChainType: null,
            payerWalletAddress: null,
            year,
            jurisdiction,
            expiresAt,
          })
          .pipe(Effect.mapError(() => toInternalError("Failed to create claim token.")))

        return {
          requestId,
          claimToken,
          expiresAt: expiresAt.toISOString(),
        }
      })

    const createX402ReceiptClaim = ({
      principalId,
      sourceId,
      requestId,
      chainType,
      walletAddress,
      year,
      jurisdiction,
      settlement,
    }: {
      readonly principalId: PrincipalId
      readonly sourceId: SourceId
      readonly requestId: string
      readonly chainType: ChainType
      readonly walletAddress: string
      readonly year: number
      readonly jurisdiction: string
      readonly settlement: X402PaymentSettlement
    }) =>
      principalClaimRepository
        .create({
          principalId,
          sourceId,
          requestId,
          claimType: "x402_receipt",
          claimValueHash: hashReceiptValue(settlement.receiptValue),
          chainType,
          walletAddress,
          payerChainType: settlement.payerChainType,
          payerWalletAddress: settlement.payerWalletAddress,
          year,
          jurisdiction,
          expiresAt: null,
        })
        .pipe(Effect.mapError(() => toInternalError("Failed to create x402 receipt claim.")))

    const startSync = ({
      principalId,
      sourceId,
    }: {
      readonly principalId: string
      readonly sourceId: string
    }) =>
      sourceSyncService
        .startSourceSyncJob({
          principalId,
          sourceId,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "UnsupportedProviderError":
                return toBadRequestError(`Unsupported provider: ${error.provider}`)
              case "SourceNotFoundError":
                return toBadRequestError("No source found. Connect a source first.")
              case "SourceSyncQueueError":
                return toInternalError("Failed to enqueue source sync job.")
              default:
                return toInternalError("Failed to start source sync.")
            }
          })
        )

    const createSource: SourceCreationServiceShape["createSource"] = ({
      anonPayerSession,
      currentUser,
      paymentHeader,
      payload,
    }) =>
      Effect.gen(function* () {
        const parsedAddress = yield* parseWalletAddress(payload.walletAddress)
        const year = payload.year ?? new Date().getUTCFullYear()
        const jurisdiction = payload.jurisdiction ?? DEFAULT_CLAIM_JURISDICTION
        const maybeExistingAnonymousSource: Option.Option<AnonymousSourceEntitlement> =
          Option.isNone(currentUser)
            ? yield* findExistingAnonymousPaidSource({
                anonPayerSession,
                chainType: parsedAddress.chainType,
                walletAddress: parsedAddress.address,
                year,
                jurisdiction,
              })
            : Option.none()

        if (Option.isSome(maybeExistingAnonymousSource)) {
          const maybeSource = yield* sourceRepository
            .findById(maybeExistingAnonymousSource.value.sourceId)
            .pipe(Effect.mapError(() => toInternalError("Failed to load anonymous source.")))

          if (Option.isNone(maybeSource)) {
            return yield* Effect.fail(toInternalError("Anonymous source not found."))
          }

          return {
            source: maybeSource.value,
            created: false,
            syncJob: null,
            claim: null,
            paymentResponseHeader: null,
            anonPayerSession: Option.getOrNull(anonPayerSession),
          }
        }

        const maybeVerifiedPayment = Option.isNone(currentUser)
          ? Option.some(
              yield* validateAnonymousPayment({
                paymentHeader,
                parsedAddress,
                year,
                jurisdiction,
              })
            )
          : Option.none<X402VerifiedPayment>()

        const { principal, isAnonymous } = yield* resolveCreatePrincipal(currentUser)
        const created = yield* createOnchainSource({
          principalId: principal.id,
          parsedAddress,
          name: payload.name,
        })

        const shouldStartSync = isAnonymous || payload.sync === true
        if (!shouldStartSync) {
          return {
            source: created.source,
            created: created.created,
            syncJob: null,
            claim: null,
            paymentResponseHeader: null,
            anonPayerSession: null,
          }
        }

        const maybeClaimTokenPepper = isAnonymous
          ? Option.some(yield* loadClaimTokenPepper)
          : Option.none<Redacted.Redacted<string>>()

        const requestId = crypto.randomUUID()

        const syncJob = yield* startSync({
          principalId: principal.id,
          sourceId: created.source.id,
        })

        const maybeSettlement =
          Option.isSome(maybeVerifiedPayment) && isAnonymous
            ? Option.some(
                yield* maybeVerifiedPayment.value.settle().pipe(
                  Effect.mapError((error) =>
                    toPaymentRequiredError({
                      message: error.message,
                      paymentRequired: error.paymentRequired,
                      paymentRequiredHeader: error.paymentRequiredHeader,
                    })
                  )
                )
              )
            : Option.none<X402PaymentSettlement>()

        if (Option.isSome(maybeSettlement)) {
          yield* createX402ReceiptClaim({
            principalId: principal.id,
            sourceId: created.source.id,
            requestId,
            chainType: created.parsedAddress.chainType,
            walletAddress: created.parsedAddress.address,
            year,
            jurisdiction,
            settlement: maybeSettlement.value,
          })
        }

        const claim = Option.isSome(maybeClaimTokenPepper)
          ? yield* createAnonymousSourceClaim({
              principalId: principal.id,
              sourceId: created.source.id,
              requestId,
              chainType: created.parsedAddress.chainType,
              walletAddress: created.parsedAddress.address,
              year,
              jurisdiction,
              pepper: maybeClaimTokenPepper.value,
            })
          : null

        const paymentResponseHeader = Option.isSome(maybeSettlement)
          ? maybeSettlement.value.paymentResponseHeader
          : null

        const resultAnonPayerSession =
          Option.isSome(maybeSettlement) &&
          maybeSettlement.value.payerChainType !== null &&
          maybeSettlement.value.payerWalletAddress !== null
            ? {
                payerChainType: maybeSettlement.value.payerChainType,
                payerWalletAddress: maybeSettlement.value.payerWalletAddress,
              }
            : null

        return {
          source: created.source,
          created: created.created,
          syncJob,
          claim,
          paymentResponseHeader,
          anonPayerSession: resultAnonPayerSession,
        }
      })

    return SourceCreationService.of({
      createSource,
    } satisfies SourceCreationServiceShape)
  })
)
