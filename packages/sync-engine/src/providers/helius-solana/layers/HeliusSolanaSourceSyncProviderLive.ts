/**
 * HeliusSolanaSourceSyncProviderLive - Helius Solana raw-history ingestion provider.
 *
 * @module HeliusSolanaSourceSyncProviderLive
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import {
  ActivityEvidence,
  ActivityFacts,
  ActivityMovementFacts,
  ActivityOnchainEntrypointFacts,
  ActivityOnchainFacts,
} from "../../../services/ActivityClassificationService.ts"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import type { ResolvedProviderTransactionTypeMapping } from "../../../services/ProviderReferenceRepository.ts"
import type {
  SourceTransactionDraft,
  SourceOnchainContextDraft,
  SourceProviderTransferDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncCursorDecodeError,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
  type FetchProviderRawBatchParams,
  type SourceSyncProviderError,
} from "../../../shared/SourceProviderRawBatch.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
  HeliusSolanaCursorDecodeError,
  HeliusSolanaNormalizationDecodeError,
  HeliusSolanaNormalizationNotImplementedError,
  HeliusSolanaNormalizationReferenceError,
  HeliusSolanaPayloadDecodeError,
  HeliusSolanaSourceSyncProvider,
  type HeliusSolanaNormalizationLookups,
  type HeliusSolanaReferenceDataRefreshResult,
  type HeliusSolanaSourceSyncProviderShape,
} from "../services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientError,
} from "../services/HeliusSolanaSyncClient.ts"
import {
  HeliusSolanaAssetResolutionService,
  SOLANA_BLOCKCHAIN_NAME,
  SOLANA_WRAPPED_NATIVE_MINT,
  type HeliusSolanaResolvedAsset,
} from "../services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaAssetResolutionServiceLive,
  toHeliusSolanaReferenceDataRefreshResult,
} from "./HeliusSolanaAssetResolutionServiceLive.ts"
import { HeliusSolanaSyncClientLive } from "./HeliusSolanaSyncClientLive.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

const HELIUS_SOLANA_NORMALIZATION_MESSAGE = "Helius Solana normalization is not implemented yet."

const emptyReferenceDataRefresh = {
  transactionTypeCatalogCount: 0,
  providerAssetCatalogCount: 0,
  defaultTransactionMappingCount: 0,
  defaultProviderAssetMappingCount: 0,
} satisfies HeliusSolanaReferenceDataRefreshResult

const SOLANA_EXPLORER_SIGNATURE_URL = "https://explorer.solana.com/tx/"
const SOLANA_TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFvcsdN5kh5qMJ2AKU9FK",
])
const SOLANA_TOKEN_PROGRAM_NAMES = new Set(["spl-token", "spl-token-2022"])

const HeliusSolanaCursorPayloadSchema = Schema.Struct({
  paginationToken: Schema.NullOr(Schema.String),
  resumeBoundaryActive: Schema.optional(Schema.Boolean),
  resumeCheckpointExternalId: Schema.optional(Schema.NullOr(Schema.String)),
  resumeHighWatermarkIso: Schema.optional(Schema.NullOr(Schema.String)),
})

const HeliusSolanaTransactionsPageSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  paginationToken: Schema.NullOr(Schema.String),
})

const HeliusSolanaFullTransactionEntrySchema = Schema.Struct({
  slot: Schema.Number,
  transactionIndex: Schema.Number,
  transaction: Schema.Struct({
    signatures: Schema.Array(Schema.String),
  }),
  meta: Schema.NullOr(Schema.Unknown),
  blockTime: Schema.NullOr(Schema.Number),
})

const HeliusSolanaAccountKeySchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    pubkey: Schema.String,
    signer: Schema.optional(Schema.Boolean),
    writable: Schema.optional(Schema.Boolean),
  })
)

const HeliusSolanaInstructionSchema = Schema.Struct({
  programId: Schema.optional(Schema.String),
  program: Schema.optional(Schema.String),
  parsed: Schema.optional(Schema.Unknown),
})

const HeliusSolanaInnerInstructionsSchema = Schema.Struct({
  index: Schema.Number,
  instructions: Schema.Array(HeliusSolanaInstructionSchema),
})

const HeliusSolanaCloseAccountParsedInstructionSchema = Schema.Struct({
  type: Schema.Literal("closeAccount"),
})

const SolanaTokenDecimalsSchema = Schema.Int.pipe(Schema.between(0, 255))

const HeliusSolanaTokenBalanceSchema = Schema.Struct({
  accountIndex: Schema.Number,
  mint: Schema.String,
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  programId: Schema.optional(Schema.NullOr(Schema.String)),
  uiTokenAmount: Schema.Struct({
    amount: Schema.String,
    decimals: SolanaTokenDecimalsSchema,
    uiAmountString: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const HeliusSolanaDecimalStringSchema = Schema.transformOrFail(
  Schema.Union(Schema.String, Schema.Number),
  Schema.String,
  {
    strict: true,
    decode: (value, _, ast) => {
      const amount = typeof value === "number" ? String(value) : value.trim()
      return Option.match(BigDecimal.fromString(amount), {
        onNone: () =>
          Effect.fail(
            new ParseResult.Type(ast, value, "Expected a decimal token amount string or number.")
          ),
        onSome: () => Effect.succeed(amount),
      })
    },
    encode: (value) => Effect.succeed(value),
  }
)

const HeliusSolanaParsedTokenTransferSchema = Schema.Struct({
  mint: Schema.optional(Schema.String),
  tokenAmount: Schema.optional(HeliusSolanaDecimalStringSchema),
  fromUserAccount: Schema.optional(Schema.String),
  toUserAccount: Schema.optional(Schema.String),
  fromTokenAccount: Schema.optional(Schema.String),
  toTokenAccount: Schema.optional(Schema.String),
})

const HeliusSolanaWalletTransferSchema = Schema.Struct({
  signature: Schema.String,
  timestamp: Schema.Number,
  direction: Schema.Literal("in", "out"),
  counterparty: Schema.String,
  mint: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  amount: Schema.Union(Schema.Number, Schema.NumberFromString),
  amountRaw: Schema.String,
  decimals: SolanaTokenDecimalsSchema,
})

const HeliusSolanaWalletTransfersPageSchema = Schema.Struct({
  data: Schema.Array(HeliusSolanaWalletTransferSchema),
  pagination: Schema.Struct({
    hasMore: Schema.Boolean,
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const HeliusSolanaFullTransactionPayloadSchema = Schema.Struct({
  slot: Schema.Number,
  transactionIndex: Schema.optional(Schema.Number),
  transaction: Schema.Struct({
    signatures: Schema.Array(Schema.String),
    message: Schema.Struct({
      accountKeys: Schema.Array(HeliusSolanaAccountKeySchema),
      instructions: Schema.optional(Schema.Array(HeliusSolanaInstructionSchema)),
    }),
  }),
  meta: Schema.NullOr(
    Schema.Struct({
      err: Schema.NullOr(Schema.Unknown),
      fee: Schema.optional(Schema.Number),
      preBalances: Schema.optional(Schema.Array(Schema.Number)),
      postBalances: Schema.optional(Schema.Array(Schema.Number)),
      preTokenBalances: Schema.optional(Schema.Array(HeliusSolanaTokenBalanceSchema)),
      postTokenBalances: Schema.optional(Schema.Array(HeliusSolanaTokenBalanceSchema)),
      innerInstructions: Schema.optional(Schema.Array(HeliusSolanaInnerInstructionsSchema)),
    })
  ),
  blockTime: Schema.NullOr(Schema.Number),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  tokenTransfers: Schema.optional(Schema.Array(HeliusSolanaParsedTokenTransferSchema)),
})

interface HeliusSolanaCursorPayload {
  readonly paginationToken: string | null
  readonly resumeBoundaryActive: boolean
  readonly resumeCheckpointExternalId: string | null
  readonly resumeHighWatermark: Date | null
}

interface HeliusSolanaEncodedCursorPayload {
  readonly paginationToken: string | null
  readonly resumeBoundaryActive?: boolean
  readonly resumeCheckpointExternalId?: string | null
  readonly resumeHighWatermarkIso?: string | null
}

interface DecodedHeliusSolanaTransactionEntry {
  readonly signature: string
  readonly blockTime: number
  readonly payload: unknown
}

type HeliusSolanaFullTransactionPayload = Schema.Schema.Type<
  typeof HeliusSolanaFullTransactionPayloadSchema
>
type HeliusSolanaAccountKey = Schema.Schema.Type<typeof HeliusSolanaAccountKeySchema>
type HeliusSolanaInstruction = Schema.Schema.Type<typeof HeliusSolanaInstructionSchema>
type HeliusSolanaTokenBalance = Schema.Schema.Type<typeof HeliusSolanaTokenBalanceSchema>
type HeliusSolanaParsedTokenTransfer = Schema.Schema.Type<
  typeof HeliusSolanaParsedTokenTransferSchema
>
type HeliusSolanaWalletTransfer = Schema.Schema.Type<typeof HeliusSolanaWalletTransferSchema>

interface SolanaBalanceMovement {
  readonly asset: HeliusSolanaResolvedAsset
  readonly amount: string
  readonly rawUnits: string
  readonly observedDecimals: number | null
  readonly matchCounterparty: string | null
  readonly direction: "inbound" | "outbound"
  readonly fromAddress: string
  readonly toAddress: string
  readonly role: "principal" | "fee" | "rent"
  readonly position: number
  readonly evidenceKind:
    | "balance_delta"
    | "token_balance_delta"
    | "parsed_transfer"
    | "transfer_row"
  readonly supplementalTransferRow: HeliusSolanaWalletTransfer | null
}

interface MovementContradiction {
  readonly reason: string
  readonly evidence: unknown
}

const decodeUnknownCursorPayload = Schema.decodeUnknown(HeliusSolanaCursorPayloadSchema)
const decodeUnknownTransactionsPage = Schema.decodeUnknown(HeliusSolanaTransactionsPageSchema)
const decodeUnknownFullTransactionEntry = Schema.decodeUnknown(
  HeliusSolanaFullTransactionEntrySchema
)
const decodeUnknownFullTransactionPayload = Schema.decodeUnknown(
  HeliusSolanaFullTransactionPayloadSchema
)
const decodeUnknownWalletTransfersPage = Schema.decodeUnknown(HeliusSolanaWalletTransfersPageSchema)
const decodeCloseAccountParsedInstruction = Schema.decodeUnknownOption(
  HeliusSolanaCloseAccountParsedInstructionSchema
)

const toCursorDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaCursorDecodeError({ message })
    : new HeliusSolanaCursorDecodeError({ message, cause })

const toPayloadDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaPayloadDecodeError({ message })
    : new HeliusSolanaPayloadDecodeError({ message, cause })

const decodeCursorPayload = (
  payload: unknown
): Effect.Effect<HeliusSolanaCursorPayload, HeliusSolanaCursorDecodeError> => {
  if (payload === null || payload === undefined) {
    return Effect.succeed({
      paginationToken: null,
      resumeBoundaryActive: false,
      resumeCheckpointExternalId: null,
      resumeHighWatermark: null,
    })
  }

  return Effect.gen(function* () {
    const decoded = yield* decodeUnknownCursorPayload(payload).pipe(
      Effect.mapError((cause) =>
        toCursorDecodeError(
          `Invalid persisted Helius Solana cursor payload: ${cause.message}`,
          cause
        )
      )
    )
    const resumeHighWatermarkIso = decoded.resumeHighWatermarkIso ?? null
    const resumeHighWatermark =
      resumeHighWatermarkIso === null
        ? null
        : yield* Timestamp.fromString(resumeHighWatermarkIso).pipe(
            Effect.map((timestamp) => timestamp.toDate()),
            Effect.mapError((cause) =>
              toCursorDecodeError(
                `Invalid persisted Helius Solana resume high watermark: ${resumeHighWatermarkIso}`,
                cause
              )
            )
          )

    return {
      paginationToken: decoded.paginationToken,
      resumeBoundaryActive: decoded.resumeBoundaryActive ?? false,
      resumeCheckpointExternalId: decoded.resumeCheckpointExternalId ?? null,
      resumeHighWatermark,
    }
  })
}

const encodeCursorPayload = (payload: HeliusSolanaCursorPayload): unknown => {
  const encoded: HeliusSolanaEncodedCursorPayload =
    payload.resumeBoundaryActive ||
    payload.resumeCheckpointExternalId !== null ||
    payload.resumeHighWatermark !== null
      ? {
          paginationToken: payload.paginationToken,
          resumeBoundaryActive: payload.resumeBoundaryActive,
          resumeCheckpointExternalId: payload.resumeCheckpointExternalId,
          resumeHighWatermarkIso:
            payload.resumeHighWatermark === null
              ? null
              : Timestamp.fromDate(payload.resumeHighWatermark).toISOString(),
        }
      : {
          paginationToken: payload.paginationToken,
        }

  return encoded
}

const decodeTransactionsPage = (
  payload: unknown
): Effect.Effect<
  { readonly data: ReadonlyArray<unknown>; readonly paginationToken: string | null },
  HeliusSolanaPayloadDecodeError
> =>
  decodeUnknownTransactionsPage(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana transactions page: ${cause.message}`, cause)
    )
  )

const decodeTransactionEntry = (
  payload: unknown
): Effect.Effect<DecodedHeliusSolanaTransactionEntry, HeliusSolanaPayloadDecodeError> =>
  decodeUnknownFullTransactionEntry(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana full transaction entry: ${cause.message}`, cause)
    ),
    Effect.flatMap((decoded) => {
      const signature = decoded.transaction.signatures[0]

      if (signature === undefined || signature.trim() === "") {
        return Effect.fail(
          toPayloadDecodeError("Invalid Helius Solana full transaction entry: missing signature")
        )
      }

      if (decoded.blockTime === null) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}: missing blockTime`
          )
        )
      }

      if (!Number.isFinite(decoded.blockTime)) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}`
          )
        )
      }

      return Effect.succeed({
        signature,
        blockTime: decoded.blockTime,
        payload,
      })
    })
  )

const occurredAtFromBlockTime = (blockTime: number): Date => new Date(blockTime * 1_000)

const makeRawRecord = ({
  walletAddress,
  entry,
}: {
  readonly walletAddress: string
  readonly entry: DecodedHeliusSolanaTransactionEntry
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    recordType: HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
    externalRecordId: entry.signature,
    externalAccountId: walletAddress,
    externalParentId: null,
    occurredAt: occurredAtFromBlockTime(entry.blockTime),
    payload: entry.payload,
  })

const maxOccurredAt = (records: ReadonlyArray<ProviderRawRecord>): Date | null =>
  records.reduce<Date | null>(
    (current, record) => Timestamp.maxNullableDate(current, record.occurredAt),
    null
  )

interface IncrementalBoundaryScanResult {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly reachedBoundary: boolean
}

const inactiveCursorPayload = (paginationToken: string | null): HeliusSolanaCursorPayload => ({
  paginationToken,
  resumeBoundaryActive: false,
  resumeCheckpointExternalId: null,
  resumeHighWatermark: null,
})

const makeNextCursorPayload = ({
  paginationToken,
  isIncrementalBoundaryScan,
  reachedBoundary,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly paginationToken: string | null
  readonly isIncrementalBoundaryScan: boolean
  readonly reachedBoundary: boolean
  readonly resumeHighWatermark: Date | null
  readonly resumeCheckpointExternalId: string | null
}): HeliusSolanaCursorPayload => {
  if (reachedBoundary || paginationToken === null) {
    return inactiveCursorPayload(null)
  }

  if (isIncrementalBoundaryScan && resumeHighWatermark !== null) {
    return {
      paginationToken,
      resumeBoundaryActive: true,
      resumeCheckpointExternalId,
      resumeHighWatermark,
    }
  }

  return inactiveCursorPayload(paginationToken)
}

const scanIncrementalBoundary = ({
  records,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly resumeHighWatermark: Date
  readonly resumeCheckpointExternalId: string | null
}): IncrementalBoundaryScanResult => {
  const watermark = Timestamp.fromDate(resumeHighWatermark)
  const boundaryIndex = records.findIndex((record) => {
    const occurredAt = Timestamp.fromDate(record.occurredAt)
    const isAtWatermark = Timestamp.equals(occurredAt, watermark)

    return (
      Timestamp.isBefore(occurredAt, watermark) ||
      (isAtWatermark &&
        resumeCheckpointExternalId !== null &&
        record.externalRecordId === resumeCheckpointExternalId)
    )
  })

  return {
    records: boundaryIndex === -1 ? records : records.slice(0, boundaryIndex),
    reachedBoundary: boundaryIndex !== -1,
  }
}

const toSharedCursorDecodeError = (error: HeliusSolanaCursorDecodeError) =>
  new SourceSyncCursorDecodeError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
  })

const toProviderFailureError = (
  error: HeliusSolanaSyncClientError | HeliusSolanaPayloadDecodeError
): SourceSyncProviderFailureError => {
  if (error instanceof HeliusSolanaAuthError) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: false,
    })
  }

  if (error instanceof HeliusSolanaProviderError) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: error.retryable,
    })
  }

  return new SourceSyncProviderFailureError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
    retryable: false,
  })
}

const normalizationNotImplemented = (cause: unknown) =>
  new HeliusSolanaNormalizationNotImplementedError({
    message: HELIUS_SOLANA_NORMALIZATION_MESSAGE,
    cause,
  })

const isRetryableFailure = (error: SourceSyncProviderError): boolean =>
  error._tag === "SourceSyncProviderFailureError" && error.retryable

const toReferenceRefreshStorageError = (cause: unknown): SyncEngineStorageError =>
  cause instanceof SyncEngineStorageError
    ? cause
    : new SyncEngineStorageError({
        operation: "heliusSolanaSourceSyncProvider.refreshReferenceData",
        cause,
      })

const toNormalizationDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaNormalizationDecodeError({ message })
    : new HeliusSolanaNormalizationDecodeError({ message, cause })

const accountKeyAddress = (accountKey: HeliusSolanaAccountKey): string =>
  typeof accountKey === "string" ? accountKey : accountKey.pubkey

const lamportsToSol = (lamports: bigint): string => {
  const sign = lamports < 0n ? "-" : ""
  const absolute = lamports < 0n ? -lamports : lamports
  const whole = absolute / 1_000_000_000n
  const fractional = String(absolute % 1_000_000_000n)
    .padStart(9, "0")
    .replace(/0+$/, "")
  return fractional === "" ? `${sign}${whole}` : `${sign}${whole}.${fractional}`
}

const rawTokenAmountToDecimal = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number
}) => {
  const raw = BigInt(amount)
  const sign = raw < 0n ? "-" : ""
  const absolute = raw < 0n ? -raw : raw
  const divisor = 10n ** BigInt(decimals)
  const whole = absolute / divisor
  const fractional = String(absolute % divisor)
    .padStart(decimals, "0")
    .replace(/0+$/, "")
  return fractional === "" ? `${sign}${whole}` : `${sign}${whole}.${fractional}`
}

const isDecimalZero = (amount: string): boolean =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => false,
    onSome: BigDecimal.isZero,
  })

const decimalAmountToExactRawUnits = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number
}): string | null =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => null,
    onSome: (decimal) => {
      const rawUnits = BigDecimal.scale(decimal, decimals).value.toString()
      const roundTripAmount = rawTokenAmountToDecimal({ amount: rawUnits, decimals })
      return movementAmountStringsEqual(amount, roundTripAmount) ? rawUnits : null
    },
  })

const movementAmountStringsEqual = (left: string, right: string): boolean => {
  const leftAmount = BigDecimal.fromString(left)
  const rightAmount = BigDecimal.fromString(right)
  return (
    Option.isSome(leftAmount) &&
    Option.isSome(rightAmount) &&
    BigDecimal.equals(leftAmount.value, rightAmount.value)
  )
}

const subtractBigIntStrings = (left: string, right: string): bigint => BigInt(left) - BigInt(right)

const stableMapping = (transactionType: string | null): ResolvedProviderTransactionTypeMapping => ({
  providerTransactionType: transactionType ?? "unknown",
  transactionType,
  inventoryEffect: transactionType === "gas_fee" ? "non_inventory" : "unknown",
  taxTreatment: "requires_additional_rule_logic",
  resolutionStrategy: "no_leg",
  pairedRecordRequired: false,
  mappingStatus: transactionType === null ? "pending_review" : "approved",
})

const buildReview = ({
  principalId,
  reason,
  matchedLayer,
}: {
  readonly principalId: string
  readonly reason: string
  readonly matchedLayer: string
}): SourceTransactionReviewDraft => ({
  principalId,
  reviewStatus: "needs_review",
  originalTypeKey: "unknown",
  originalConfidence: "0.40",
  currentTypeKey: "unknown",
  legalRuleSetVersion: null,
  categorizationReason: reason,
  matchedLayer,
  needsReview: true,
  userNotes: null,
  reviewedAt: null,
})

const toProviderTransactionType = (payload: HeliusSolanaFullTransactionPayload): string =>
  payload.meta?.err === null ? (payload.type ?? payload.source ?? "solana_transaction") : "failed"

const firstSignerOrFallback = ({
  payload,
  fallback,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly fallback: string
}): string => {
  const signer = payload.transaction.message.accountKeys.find(
    (accountKey) => typeof accountKey !== "string" && accountKey.signer === true
  )
  if (signer !== undefined) {
    return accountKeyAddress(signer)
  }

  const feePayer = payload.transaction.message.accountKeys[0]
  return feePayer === undefined ? fallback : accountKeyAddress(feePayer)
}

const inferCounterparty = ({
  direction,
  walletAddress,
  accountKeys,
}: {
  readonly direction: "inbound" | "outbound"
  readonly walletAddress: string
  readonly accountKeys: ReadonlyArray<HeliusSolanaAccountKey>
}): string => {
  const other = accountKeys.map(accountKeyAddress).find((address) => address !== walletAddress)
  if (other !== undefined) {
    return other
  }
  return direction === "inbound" ? "solana:unknown_sender" : "solana:unknown_recipient"
}

const isTokenProgramInstruction = (instruction: HeliusSolanaInstruction): boolean =>
  (instruction.program !== undefined && SOLANA_TOKEN_PROGRAM_NAMES.has(instruction.program)) ||
  (instruction.programId !== undefined && SOLANA_TOKEN_PROGRAM_IDS.has(instruction.programId))

const isTokenAccountCloseInstruction = (instruction: HeliusSolanaInstruction): boolean =>
  isTokenProgramInstruction(instruction) &&
  Option.isSome(decodeCloseAccountParsedInstruction(instruction.parsed))

const hasTokenAccountCloseInstruction = (payload: HeliusSolanaFullTransactionPayload): boolean =>
  [
    ...(payload.transaction.message.instructions ?? []),
    ...(payload.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions),
  ].some(isTokenAccountCloseInstruction)

const buildTransferDraft = ({
  source,
  sourceRecord,
  blockchainId,
  movement,
  signature,
  timestamp,
}: {
  readonly source: {
    readonly id: string
    readonly principalId: string
    readonly addressId: string | null
  }
  readonly sourceRecord: { readonly id: string }
  readonly blockchainId: string
  readonly movement: SolanaBalanceMovement
  readonly signature: string
  readonly timestamp: Date
}): SourceTransferDraft | null => {
  if (movement.asset.canonicalAssetId === null || source.addressId === null) {
    return null
  }

  const assetId = movement.asset.canonicalAssetId

  return {
    sourceId: source.id,
    principalId: source.principalId,
    sourceRawRecordId: sourceRecord.id,
    externalId: `${signature}:${movement.role}:${movement.position}`,
    externalGroupId: signature,
    addressId: source.addressId,
    blockchainId,
    txHash: signature,
    timestamp,
    type:
      movement.role === "fee" ? "fee" : movement.asset.assetKind === "native" ? "native" : "spl",
    fromAddress: movement.fromAddress,
    toAddress: movement.toAddress,
    fromAccountRef: null,
    toAccountRef: null,
    fromPartyType: "address",
    fromPartyResourcePath: null,
    toPartyType: "address",
    toPartyResourcePath: null,
    assetId,
    assetRepresentationId: movement.asset.assetRepresentationId,
    amount: movement.amount,
    tokenId: null,
    notes: movement.role === "rent" ? "Solana account close or rent refund balance effect" : null,
    metadata: {
      provider: HELIUS_SOLANA_PROVIDER_KEY,
      role: movement.role,
      evidenceKind: movement.evidenceKind,
      rawUnits: movement.rawUnits,
      mintAddress: movement.asset.mintAddress,
      providerAssetRowId: movement.asset.providerAssetRowId,
      supplementalTransferRow: movement.supplementalTransferRow,
    },
  }
}

const buildProviderTransferDraft = ({
  sourceId,
  sourceRawRecordId,
  blockchainId,
  signature,
  timestamp,
  movement,
  externalId,
  canonicalTransferExternalId,
  evidenceOnly,
  accountingOnly,
}: {
  readonly sourceId: string
  readonly sourceRawRecordId: string
  readonly blockchainId: string
  readonly signature: string
  readonly timestamp: Date
  readonly movement: SolanaBalanceMovement
  readonly externalId: string
  readonly canonicalTransferExternalId: string | null
  readonly evidenceOnly: boolean
  readonly accountingOnly: boolean
}): SourceProviderTransferDraft => ({
  sourceId,
  sourceRawRecordId,
  externalId,
  externalGroupId: signature,
  providerAssetId: movement.asset.providerAssetRowId,
  timestamp,
  direction: movement.direction,
  fromAccountRef: null,
  toAccountRef: null,
  fromAddress: movement.fromAddress,
  toAddress: movement.toAddress,
  networkName: SOLANA_BLOCKCHAIN_NAME,
  networkHash: signature,
  observedBlockchainId: accountingOnly ? null : blockchainId,
  observedRepresentationType:
    accountingOnly || movement.asset.representationTypeObserved === false
      ? null
      : movement.asset.assetKind,
  observedContractAddress: null,
  observedMintAddress: accountingOnly ? null : movement.asset.mintAddress,
  observedDecimals: accountingOnly ? null : movement.observedDecimals,
  amount: movement.amount,
  metadata: {
    provider: HELIUS_SOLANA_PROVIDER_KEY,
    role: movement.role,
    canonicalTransferExternalId,
    evidenceOnly,
    accountingOnly,
    evidenceKind: movement.evidenceKind,
    rawUnits: movement.rawUnits,
    mintAddress: movement.asset.mintAddress,
    supplementalTransferRow: movement.supplementalTransferRow,
  },
})

const resolveWalletAddress = ({
  sourceId,
  sourceWalletAddress,
  sourceRecordExternalAccountId,
}: {
  readonly sourceId: string
  readonly sourceWalletAddress: string | null
  readonly sourceRecordExternalAccountId: string | null
}) => {
  const walletAddress = sourceWalletAddress ?? sourceRecordExternalAccountId

  if (walletAddress === null || walletAddress.trim() === "") {
    return Effect.fail(
      new HeliusSolanaNormalizationReferenceError({
        message: `Solana source ${sourceId} has no wallet address for normalization.`,
      })
    )
  }

  return Effect.succeed(walletAddress)
}

const requirePayloadSignature = (payload: HeliusSolanaFullTransactionPayload) => {
  const signature = payload.transaction.signatures[0]

  if (signature === undefined || signature.trim() === "") {
    return Effect.fail(
      toNormalizationDecodeError(
        "Invalid Helius Solana full transaction payload: missing signature"
      )
    )
  }

  return Effect.succeed(signature)
}

const timestampFromPayload = ({
  payload,
  fallback,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly fallback: Date
}): Date => {
  if (payload.blockTime === null) {
    return fallback
  }

  return occurredAtFromBlockTime(payload.blockTime)
}

const collectSplTokenMints = ({
  payload,
  walletTransferEvidence,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly walletTransferEvidence: ReadonlyArray<HeliusSolanaWalletTransfer>
}): ReadonlyArray<string> =>
  Array.from(
    new Set([
      ...(payload.meta?.preTokenBalances ?? []).map((balance) => balance.mint),
      ...(payload.meta?.postTokenBalances ?? []).map((balance) => balance.mint),
      ...(payload.tokenTransfers ?? []).flatMap((transfer) =>
        transfer.mint === undefined ? [] : [transfer.mint]
      ),
      ...walletTransferEvidence.map((transfer) => transfer.mint),
    ])
  )

const mapAssetsByMint = (
  requestedMints: ReadonlyArray<string>,
  resolvedTokens: ReadonlyArray<HeliusSolanaResolvedAsset>
): ReadonlyMap<string, HeliusSolanaResolvedAsset> =>
  new Map(
    requestedMints.flatMap((mintAddress, index) => {
      const asset = resolvedTokens[index]
      return asset === undefined ? [] : [[mintAddress, asset]]
    })
  )

const make = ({
  refreshReferenceData,
}: {
  readonly refreshReferenceData: HeliusSolanaSourceSyncProviderShape["refreshReferenceData"]
}) =>
  Effect.gen(function* () {
    const heliusSyncClient = yield* HeliusSolanaSyncClient
    const assetRepository = yield* AssetRepository
    const assetResolutionService = yield* HeliusSolanaAssetResolutionService

    const fetchHeliusRawBatch = ({
      sourceId,
      walletAddress,
      cursorPayload,
      resumeHighWatermark,
      resumeCheckpointExternalId,
      pageSize,
    }: {
      readonly sourceId: string
      readonly walletAddress: string | null
      readonly cursorPayload: unknown
      readonly resumeHighWatermark: Date | null
      readonly resumeCheckpointExternalId: string | null
      readonly pageSize: number
    }) =>
      Effect.gen(function* () {
        const cursor = yield* decodeCursorPayload(cursorPayload).pipe(
          Effect.mapError(toSharedCursorDecodeError)
        )

        if (walletAddress === null || walletAddress.trim() === "") {
          return yield* Effect.fail(
            new SourceSyncProviderFailureError({
              providerKey: HELIUS_SOLANA_PROVIDER_KEY,
              message: `Helius Solana source ${sourceId} has no wallet address`,
              retryable: false,
            })
          )
        }

        const page = yield* heliusSyncClient
          .fetchTransactionsForAddress({
            walletAddress,
            config: {
              limit: pageSize,
              paginationToken: cursor.paginationToken,
              transactionDetails: "full",
              sortOrder: "desc",
              filters: {
                status: "any",
                tokenAccounts: "balanceChanged",
              },
            },
          })
          .pipe(Effect.mapError(toProviderFailureError))

        const decodedPage = yield* decodeTransactionsPage(page).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const entries = yield* Effect.forEach(decodedPage.data, decodeTransactionEntry).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const records = entries.map((entry) => makeRawRecord({ walletAddress, entry }))
        const activeResumeHighWatermark = cursor.resumeHighWatermark ?? resumeHighWatermark
        const activeResumeCheckpointExternalId =
          cursor.resumeCheckpointExternalId ?? resumeCheckpointExternalId
        const isIncrementalBoundaryScan =
          activeResumeHighWatermark !== null &&
          (cursor.resumeBoundaryActive || cursor.paginationToken === null)
        const boundaryScan = isIncrementalBoundaryScan
          ? scanIncrementalBoundary({
              records,
              resumeHighWatermark: activeResumeHighWatermark,
              resumeCheckpointExternalId: activeResumeCheckpointExternalId,
            })
          : {
              records,
              reachedBoundary: false,
            }
        const filteredRecords = boundaryScan.records
        const nextCursor = makeNextCursorPayload({
          paginationToken: decodedPage.paginationToken,
          isIncrementalBoundaryScan,
          reachedBoundary: boundaryScan.reachedBoundary,
          resumeHighWatermark: activeResumeHighWatermark,
          resumeCheckpointExternalId: activeResumeCheckpointExternalId,
        })

        yield* Effect.logInfo(
          {
            sourceId,
            provider: HELIUS_SOLANA_PROVIDER_KEY,
            pageSize,
            hasPaginationToken: cursor.paginationToken !== null,
            resumeBoundaryActive: isIncrementalBoundaryScan,
            reachedResumeBoundary: boundaryScan.reachedBoundary,
            recordCount: filteredRecords.length,
            retryable: false,
          },
          "helius-solana:raw-batch"
        )

        return FetchProviderRawBatchResult.make({
          records: filteredRecords,
          cursorPayload: encodeCursorPayload(nextCursor),
          highWatermark: maxOccurredAt(filteredRecords),
          done: boundaryScan.reachedBoundary || decodedPage.paginationToken === null,
        })
      })

    const fetchRawBatch: HeliusSolanaSourceSyncProviderShape["fetchRawBatch"] = (
      params: FetchProviderRawBatchParams
    ) => {
      if (params.providerKey !== HELIUS_SOLANA_PROVIDER_KEY) {
        return Effect.fail(new UnsupportedSyncProviderError({ providerKey: params.providerKey }))
      }

      return fetchHeliusRawBatch({
        sourceId: params.sourceId,
        walletAddress: params.walletAddress,
        cursorPayload: params.cursorPayload,
        resumeHighWatermark: params.resumeHighWatermark,
        resumeCheckpointExternalId: params.resumeCheckpointExternalId,
        pageSize: params.pageSize,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            {
              sourceId: params.sourceId,
              provider: HELIUS_SOLANA_PROVIDER_KEY,
              pageSize: params.pageSize,
              hasPaginationToken:
                params.cursorPayload !== null && params.cursorPayload !== undefined,
              recordCount: 0,
              retryable: isRetryableFailure(error),
            },
            "helius-solana:raw-batch-failed"
          )
        )
      )
    }

    const loadNormalizationLookups: HeliusSolanaSourceSyncProviderShape["loadNormalizationLookups"] =
      () =>
        assetRepository.listBlockchains().pipe(
          Effect.map((blockchains) => {
            const solana = blockchains.find(
              (blockchain) => blockchain.name.toLowerCase() === SOLANA_BLOCKCHAIN_NAME
            )
            return solana?.id ?? null
          }),
          Effect.map((solanaBlockchainId) => ({
            providerKey: HELIUS_SOLANA_PROVIDER_KEY,
            solanaBlockchainId,
          }))
        )

    const requireSolanaBlockchainId = (lookups: HeliusSolanaNormalizationLookups) =>
      lookups.solanaBlockchainId === null
        ? Effect.fail(
            new HeliusSolanaNormalizationReferenceError({
              message: "Missing seeded Solana blockchain row.",
            })
          )
        : Effect.succeed(lookups.solanaBlockchainId)

    const resolveNativeSol = assetResolutionService.resolveAsset({
      kind: "native",
      mintAddress: null,
    })

    const decodeNormalizationPayload = (payload: unknown) =>
      decodeUnknownFullTransactionPayload(payload).pipe(
        Effect.mapError((cause) =>
          toNormalizationDecodeError(
            `Invalid Helius Solana full transaction payload: ${cause.message}`,
            cause
          )
        )
      )

    const fetchWalletTransferEvidence = ({
      walletAddress,
      signature,
    }: {
      readonly walletAddress: string
      readonly signature: string
    }) => {
      const fetchPage = (
        cursor: string | null,
        pagesRemaining: number,
        foundOnEarlierPage: boolean
      ): Effect.Effect<ReadonlyArray<HeliusSolanaWalletTransfer>, HeliusSolanaPayloadDecodeError> =>
        heliusSyncClient
          .fetchTransfersForAddress({
            walletAddress,
            limit: 100,
            cursor,
          })
          .pipe(
            Effect.mapError((cause) =>
              toPayloadDecodeError("Helius Solana wallet transfer evidence is unavailable", cause)
            ),
            Effect.flatMap((payload) =>
              decodeUnknownWalletTransfersPage(payload).pipe(
                Effect.mapError((cause) =>
                  toPayloadDecodeError(
                    `Invalid Helius Solana wallet transfers page: ${cause.message}`,
                    cause
                  )
                )
              )
            ),
            Effect.flatMap((page) => {
              const matches = page.data.filter((transfer) => transfer.signature === signature)
              const canFetchNextPage =
                page.pagination.hasMore &&
                pagesRemaining > 1 &&
                page.pagination.nextCursor !== null &&
                page.pagination.nextCursor !== undefined
              if (!canFetchNextPage || (foundOnEarlierPage && matches.length === 0)) {
                return Effect.succeed(matches)
              }

              return fetchPage(
                page.pagination.nextCursor,
                pagesRemaining - 1,
                foundOnEarlierPage || matches.length > 0
              ).pipe(Effect.map((nextMatches) => [...matches, ...nextMatches]))
            })
          )

      return fetchPage(null, 10, false).pipe(
        Effect.catchAll((error) =>
          Effect.logInfo(
            {
              provider: HELIUS_SOLANA_PROVIDER_KEY,
              signature,
              walletAddress,
              error,
            },
            "helius-solana:transfer-evidence-unavailable"
          ).pipe(Effect.as<ReadonlyArray<HeliusSolanaWalletTransfer>>([]))
        )
      )
    }

    const buildSolMovements = ({
      payload,
      nativeAsset,
      walletAddress,
    }: {
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly nativeAsset: HeliusSolanaResolvedAsset
      readonly walletAddress: string
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const meta = payload.meta
      if (meta === null) {
        return []
      }

      const preBalances = meta.preBalances ?? []
      const postBalances = meta.postBalances ?? []
      const walletIndex = payload.transaction.message.accountKeys
        .map(accountKeyAddress)
        .findIndex((address) => address === walletAddress)
      const walletDelta =
        walletIndex === -1
          ? 0n
          : BigInt(postBalances[walletIndex] ?? 0) - BigInt(preBalances[walletIndex] ?? 0)
      const fee = BigInt(meta.fee ?? 0)
      const counterparty = inferCounterparty({
        direction: walletDelta >= 0n ? "inbound" : "outbound",
        walletAddress,
        accountKeys: payload.transaction.message.accountKeys,
      })
      const feePayer = firstSignerOrFallback({ payload, fallback: walletAddress })
      const principalDelta =
        meta.err === null && fee > 0n && feePayer === walletAddress
          ? walletDelta + fee
          : walletDelta
      const isRentRefund = principalDelta > 0n && hasTokenAccountCloseInstruction(payload)
      const transfers =
        meta.err === null && principalDelta !== 0n
          ? [
              {
                asset: nativeAsset,
                amount: lamportsToSol(principalDelta < 0n ? -principalDelta : principalDelta),
                rawUnits: String(principalDelta < 0n ? -principalDelta : principalDelta),
                observedDecimals: nativeAsset.decimals,
                matchCounterparty: null,
                direction: principalDelta > 0n ? "inbound" : "outbound",
                fromAddress: principalDelta > 0n ? counterparty : walletAddress,
                toAddress: principalDelta > 0n ? walletAddress : counterparty,
                role: isRentRefund ? "rent" : "principal",
                position: 0,
                evidenceKind: "balance_delta",
                supplementalTransferRow: null,
              } satisfies SolanaBalanceMovement,
            ]
          : []

      if (fee === 0n || feePayer !== walletAddress) {
        return transfers
      }

      return [
        ...transfers,
        {
          asset: nativeAsset,
          amount: lamportsToSol(fee),
          rawUnits: String(fee),
          observedDecimals: nativeAsset.decimals,
          matchCounterparty: null,
          direction: "outbound",
          fromAddress: walletAddress,
          toAddress: "solana:fee",
          role: "fee",
          position: 1,
          evidenceKind: "balance_delta",
          supplementalTransferRow: null,
        },
      ]
    }

    const refineNativeSolEvidence = ({
      transfers,
      nativeMovements,
      nativeAsset,
      walletAddress,
      payload,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly nativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly nativeAsset: HeliusSolanaResolvedAsset
      readonly walletAddress: string
      readonly payload: HeliusSolanaFullTransactionPayload
    }): {
      readonly nativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly splTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly ambiguousTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
    } => {
      const nativeMovement = nativeMovements.find(
        (movement) => movement.role !== "fee" && movement.asset.assetKind === "native"
      )
      const sentinelTransfers = transfers.filter(
        (transfer) => transfer.mint === SOLANA_WRAPPED_NATIVE_MINT
      )
      if (sentinelTransfers.length === 0) {
        return { nativeMovements, splTransfers: transfers, ambiguousTransfers: [] }
      }

      const explicitWrappedSolTransfers = (payload.tokenTransfers ?? []).filter(
        (transfer) => transfer.mint === SOLANA_WRAPPED_NATIVE_MINT
      )
      const matchedWrappedSolRows = new Set<HeliusSolanaWalletTransfer>()
      for (const parsedTransfer of explicitWrappedSolTransfers) {
        const tokenAmount = parsedTransfer.tokenAmount
        const fromAddress =
          parsedTransfer.fromUserAccount ?? parsedTransfer.fromTokenAccount ?? null
        const toAddress = parsedTransfer.toUserAccount ?? parsedTransfer.toTokenAccount ?? null
        const direction =
          toAddress === walletAddress ? "in" : fromAddress === walletAddress ? "out" : null
        const counterparty =
          direction === "in"
            ? (parsedTransfer.fromUserAccount ?? null)
            : direction === "out"
              ? (parsedTransfer.toUserAccount ?? null)
              : null
        if (tokenAmount === undefined || direction === null) {
          continue
        }

        const matchingRow = sentinelTransfers.find(
          (row) =>
            !matchedWrappedSolRows.has(row) &&
            row.direction === direction &&
            /^\d+$/.test(row.amountRaw) &&
            (counterparty === null || row.counterparty === counterparty) &&
            movementAmountStringsEqual(
              rawTokenAmountToDecimal({ amount: row.amountRaw, decimals: row.decimals }),
              tokenAmount
            )
        )
        if (matchingRow !== undefined) {
          matchedWrappedSolRows.add(matchingRow)
        }
      }
      const candidateNativeTransfers = sentinelTransfers.filter(
        (transfer) => !matchedWrappedSolRows.has(transfer)
      )

      const signedRawAmount = (transfer: HeliusSolanaWalletTransfer): bigint | null => {
        if (!/^\d+$/.test(transfer.amountRaw)) {
          return null
        }

        const amount = BigInt(transfer.amountRaw)
        return transfer.direction === "in" ? amount : -amount
      }

      const targetNativeRawAmount =
        nativeMovement === undefined
          ? 0n
          : BigInt(nativeMovement.rawUnits) * (nativeMovement.direction === "inbound" ? 1n : -1n)

      const findUniqueNativeSubset = (
        candidateTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      ): ReadonlyArray<HeliusSolanaWalletTransfer> | null => {
        if (
          candidateTransfers.length > 20 ||
          candidateTransfers.some(
            (transfer) =>
              signedRawAmount(transfer) === null || transfer.decimals !== nativeAsset.decimals
          )
        ) {
          return null
        }

        const solutions = new Map<bigint, ReadonlyArray<number> | null>([[0n, []]])
        candidateTransfers.forEach((transfer, index) => {
          const amount = signedRawAmount(transfer)
          if (amount === null) {
            return
          }

          const additions = Array.from(solutions.entries()).map(
            ([total, selected]) =>
              [total + amount, selected === null ? null : [...selected, index]] as const
          )
          for (const [total, selected] of additions) {
            if (solutions.has(total)) {
              solutions.set(total, null)
            } else {
              solutions.set(total, selected)
            }
          }
        })

        const selected = solutions.get(targetNativeRawAmount)
        return selected === undefined || selected === null
          ? null
          : selected.map((index) => candidateTransfers[index]).filter((row) => row !== undefined)
      }

      const nativeWalletTransfers = findUniqueNativeSubset(candidateNativeTransfers)

      if (nativeWalletTransfers === null) {
        return {
          nativeMovements,
          splTransfers: transfers.filter(
            (transfer) =>
              !candidateNativeTransfers.includes(transfer) || matchedWrappedSolRows.has(transfer)
          ),
          ambiguousTransfers: candidateNativeTransfers,
        }
      }

      const splTransfers = transfers.filter((transfer) => !nativeWalletTransfers.includes(transfer))

      const refinedNativeMovements = nativeWalletTransfers.map(
        (transfer): SolanaBalanceMovement => {
          const direction = transfer.direction === "in" ? "inbound" : "outbound"

          return {
            asset: nativeAsset,
            amount: rawTokenAmountToDecimal({
              amount: transfer.amountRaw,
              decimals: transfer.decimals,
            }),
            rawUnits: transfer.amountRaw,
            observedDecimals: transfer.decimals,
            matchCounterparty: transfer.counterparty,
            direction,
            fromAddress: direction === "inbound" ? transfer.counterparty : walletAddress,
            toAddress: direction === "inbound" ? walletAddress : transfer.counterparty,
            role: "principal",
            position: 0,
            evidenceKind: "transfer_row",
            supplementalTransferRow: transfer,
          }
        }
      )
      const remainingNativeMovements = nativeMovements.filter(
        (movement) => movement !== nativeMovement
      )

      return {
        nativeMovements: [...refinedNativeMovements, ...remainingNativeMovements].map(
          (movement, position) => ({ ...movement, position })
        ),
        splTransfers,
        ambiguousTransfers: [],
      }
    }

    const balanceKey = (balance: HeliusSolanaTokenBalance): string =>
      `${balance.accountIndex}:${balance.mint}`

    const buildSplMovements = ({
      payload,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const meta = payload.meta
      if (meta === null || meta.err !== null) {
        return []
      }

      const preBalances = meta.preTokenBalances ?? []
      const postBalances = meta.postTokenBalances ?? []
      const preByKey = new Map(preBalances.map((balance) => [balanceKey(balance), balance]))
      const postByKey = new Map(postBalances.map((balance) => [balanceKey(balance), balance]))
      const keys = Array.from(new Set([...preByKey.keys(), ...postByKey.keys()]))

      return keys.flatMap((key, index) => {
        const pre = preByKey.get(key)
        const post = postByKey.get(key)
        const balance = post ?? pre
        if (balance === undefined) {
          return []
        }

        const owner = post?.owner ?? pre?.owner ?? null
        if (owner !== walletAddress) {
          return []
        }

        const delta = subtractBigIntStrings(
          post?.uiTokenAmount.amount ?? "0",
          pre?.uiTokenAmount.amount ?? "0"
        )
        if (delta === 0n) {
          return []
        }

        const asset = assetsByMint.get(balance.mint)
        if (asset === undefined) {
          return []
        }

        const absoluteDelta = delta < 0n ? -delta : delta
        const direction = delta > 0n ? "inbound" : "outbound"
        const counterparty = inferCounterparty({
          direction,
          walletAddress,
          accountKeys: payload.transaction.message.accountKeys,
        })

        return [
          {
            asset,
            amount: rawTokenAmountToDecimal({
              amount: String(absoluteDelta),
              decimals: balance.uiTokenAmount.decimals,
            }),
            rawUnits: String(absoluteDelta),
            observedDecimals: balance.uiTokenAmount.decimals,
            matchCounterparty: null,
            direction,
            fromAddress: direction === "inbound" ? counterparty : walletAddress,
            toAddress: direction === "inbound" ? walletAddress : counterparty,
            role: "principal",
            position: offset + index,
            evidenceKind: "token_balance_delta",
            supplementalTransferRow: null,
          } satisfies SolanaBalanceMovement,
        ]
      })
    }

    const buildParsedSplMovements = ({
      transfers,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaParsedTokenTransfer>
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> =>
      transfers.flatMap((transfer, index) => {
        const mint = transfer.mint
        const tokenAmount = transfer.tokenAmount
        if (mint === undefined || tokenAmount === undefined || isDecimalZero(tokenAmount)) {
          return []
        }

        const asset = assetsByMint.get(mint)
        if (asset === undefined) {
          return []
        }

        const fromAddress = transfer.fromUserAccount ?? transfer.fromTokenAccount ?? null
        const toAddress = transfer.toUserAccount ?? transfer.toTokenAccount ?? null
        const direction =
          toAddress === walletAddress
            ? "inbound"
            : fromAddress === walletAddress
              ? "outbound"
              : null
        if (direction === null) {
          return []
        }
        return [
          {
            asset,
            amount: tokenAmount,
            rawUnits: tokenAmount,
            observedDecimals: null,
            matchCounterparty:
              direction === "inbound"
                ? (transfer.fromUserAccount ?? null)
                : (transfer.toUserAccount ?? null),
            direction,
            fromAddress: fromAddress ?? "solana:unknown_sender",
            toAddress: toAddress ?? "solana:unknown_recipient",
            role: "principal",
            position: offset + index,
            evidenceKind: "parsed_transfer",
            supplementalTransferRow: null,
          } satisfies SolanaBalanceMovement,
        ]
      })

    const buildTransferRowSplMovements = ({
      transfers,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> =>
      transfers.flatMap((transfer, index) => {
        if (transfer.amountRaw === "0") {
          return []
        }

        const asset = assetsByMint.get(transfer.mint)
        if (asset === undefined) {
          return []
        }

        const direction = transfer.direction === "in" ? "inbound" : "outbound"
        const amount = rawTokenAmountToDecimal({
          amount: transfer.amountRaw,
          decimals: transfer.decimals,
        })

        return [
          {
            asset,
            amount,
            rawUnits: transfer.amountRaw,
            observedDecimals: transfer.decimals,
            matchCounterparty: transfer.counterparty,
            direction,
            fromAddress: direction === "inbound" ? transfer.counterparty : walletAddress,
            toAddress: direction === "inbound" ? walletAddress : transfer.counterparty,
            role: "principal",
            position: offset + index,
            evidenceKind: "transfer_row",
            supplementalTransferRow: transfer,
          } satisfies SolanaBalanceMovement,
        ]
      })

    const movementAmountsEqual = (
      left: SolanaBalanceMovement,
      right: SolanaBalanceMovement
    ): boolean => {
      if (left.evidenceKind === "parsed_transfer" && right.evidenceKind === "transfer_row") {
        const leftAmount = BigDecimal.fromString(left.amount)
        const rightAmount = BigDecimal.fromString(right.amount)

        return (
          Option.isSome(leftAmount) &&
          Option.isSome(rightAmount) &&
          BigDecimal.equals(leftAmount.value, rightAmount.value)
        )
      }

      if (left.observedDecimals !== null && right.observedDecimals !== null) {
        return left.observedDecimals === right.observedDecimals && left.rawUnits === right.rawUnits
      }

      const leftAmount = BigDecimal.fromString(left.amount)
      const rightAmount = BigDecimal.fromString(right.amount)

      return (
        Option.isSome(leftAmount) &&
        Option.isSome(rightAmount) &&
        BigDecimal.equals(leftAmount.value, rightAmount.value)
      )
    }

    const movementsMatch = (
      authoritativeMovement: SolanaBalanceMovement,
      transferRowMovement: SolanaBalanceMovement
    ): boolean =>
      authoritativeMovement.asset.mintAddress === transferRowMovement.asset.mintAddress &&
      authoritativeMovement.direction === transferRowMovement.direction &&
      (authoritativeMovement.matchCounterparty === null ||
        transferRowMovement.matchCounterparty === null ||
        authoritativeMovement.matchCounterparty === transferRowMovement.matchCounterparty) &&
      (authoritativeMovement.observedDecimals === null ||
        (authoritativeMovement.observedDecimals === transferRowMovement.observedDecimals &&
          authoritativeMovement.rawUnits === transferRowMovement.rawUnits)) &&
      movementAmountsEqual(authoritativeMovement, transferRowMovement)

    const findTransferRowContradictions = ({
      transferRows,
      authoritativeMovements,
    }: {
      readonly transferRows: ReadonlyArray<SolanaBalanceMovement>
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      const unmatchedAuthoritativeMovements = [...authoritativeMovements]

      return transferRows.flatMap((movement) => {
        const matchIndex = unmatchedAuthoritativeMovements.findIndex((candidate) =>
          movementsMatch(candidate, movement)
        )

        if (matchIndex !== -1) {
          unmatchedAuthoritativeMovements.splice(matchIndex, 1)
          return []
        }

        return [
          {
            reason: "Helius transfer-row evidence contradicts full transaction movement evidence.",
            evidence: {
              mintAddress: movement.asset.mintAddress,
              direction: movement.direction,
              amount: movement.amount,
              rawUnits: movement.rawUnits,
              evidenceKind: movement.evidenceKind,
            },
          },
        ]
      })
    }

    const joinTransferRowEvidence = ({
      authoritativeMovements,
      transferRowMovements,
    }: {
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const unmatchedTransferRows = [...transferRowMovements]

      return authoritativeMovements.map((movement) => {
        const positionMatchIndex = unmatchedTransferRows.findIndex(
          (candidate) =>
            candidate.position === movement.position && movementsMatch(movement, candidate)
        )
        const matchIndex =
          positionMatchIndex === -1
            ? unmatchedTransferRows.findIndex((candidate) => movementsMatch(movement, candidate))
            : positionMatchIndex
        const [transferRowMovement] =
          matchIndex === -1 ? [] : unmatchedTransferRows.splice(matchIndex, 1)
        const supplementalTransferRow = transferRowMovement?.supplementalTransferRow ?? null

        if (
          supplementalTransferRow === null ||
          movement.evidenceKind === "transfer_row" ||
          transferRowMovement === undefined
        ) {
          return movement
        }

        const preferTransferRowAmountEvidence = movement.evidenceKind === "parsed_transfer"

        return {
          ...movement,
          rawUnits:
            preferTransferRowAmountEvidence || movement.observedDecimals === null
              ? transferRowMovement.rawUnits
              : movement.rawUnits,
          observedDecimals: preferTransferRowAmountEvidence
            ? transferRowMovement.observedDecimals
            : (movement.observedDecimals ?? transferRowMovement.observedDecimals),
          supplementalTransferRow,
        }
      })
    }

    const buildActivityFacts = ({
      sourceId,
      signature,
      timestamp,
      providerTransactionType,
      blockchainId,
      payload,
      movements,
      contradictions,
    }: {
      readonly sourceId: string
      readonly signature: string
      readonly timestamp: Date
      readonly providerTransactionType: string
      readonly blockchainId: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly movements: ReadonlyArray<SolanaBalanceMovement>
      readonly contradictions: ReadonlyArray<MovementContradiction>
    }): ActivityFacts =>
      ActivityFacts.make({
        sourceKind: "solana",
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        sourceId,
        externalId: signature,
        occurredAt: timestamp,
        providerActivityType: providerTransactionType,
        movements: movements.map(
          (movement) =>
            new ActivityMovementFacts({
              direction: movement.direction,
              role: movement.role === "fee" ? "gas" : movement.role,
              assetId: movement.asset.canonicalAssetId,
              assetSymbol: movement.asset.currencyCode,
              amount: movement.amount,
              fiatAmount: null,
              fiatCurrency: null,
              address: movement.direction === "inbound" ? movement.fromAddress : movement.toAddress,
              accountRef: null,
              tokenId: null,
              metadata: {
                evidenceKind: movement.evidenceKind,
                rawUnits: movement.rawUnits,
                mintAddress: movement.asset.mintAddress,
                providerAssetRowId: movement.asset.providerAssetRowId,
                supplementalTransferRow: movement.supplementalTransferRow,
              },
            })
        ),
        cex: null,
        onchain: new ActivityOnchainFacts({
          chainType: "solana",
          blockchainId,
          txHash: signature,
          blockNumber: String(payload.slot),
          status: payload.meta?.err === null ? "succeeded" : "failed",
          feePayer: firstSignerOrFallback({
            payload,
            fallback: "solana:unknown_fee_payer",
          }),
          entrypoints: (payload.transaction.message.instructions ?? []).flatMap((instruction) => {
            const id = instruction.programId ?? instruction.program ?? null
            if (id === null) {
              return []
            }

            return [
              new ActivityOnchainEntrypointFacts({
                kind: "program",
                id,
                name: instruction.program ?? null,
                metadata: instruction,
              }),
            ]
          }),
          metadata: {
            slot: payload.slot,
            transactionIndex: payload.transactionIndex ?? null,
            error: payload.meta?.err ?? null,
          },
        }),
        utxo: null,
        rawPayload: payload,
        evidence: [
          ...movements.map(
            (movement) =>
              new ActivityEvidence({
                kind: movement.evidenceKind,
                source: HELIUS_SOLANA_PROVIDER_KEY,
                summary: `Solana ${movement.evidenceKind} movement`,
                payload: {
                  mintAddress: movement.asset.mintAddress,
                  amount: movement.amount,
                  rawUnits: movement.rawUnits,
                  direction: movement.direction,
                  role: movement.role,
                  position: movement.position,
                  supplementalTransferRow: movement.supplementalTransferRow,
                },
              })
          ),
          ...contradictions.map(
            (contradiction) =>
              new ActivityEvidence({
                kind: "transfer_row",
                source: HELIUS_SOLANA_PROVIDER_KEY,
                summary: contradiction.reason,
                payload: contradiction.evidence,
              })
          ),
        ],
      })

    const chooseAuthoritativeSplMovements = ({
      parsedSplMovements,
      tokenBalanceSplMovements,
      transferRowSplMovements,
    }: {
      readonly parsedSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly tokenBalanceSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      if (tokenBalanceSplMovements.length > 0) {
        const parsedWithObservedDecimals = enrichParsedMovementsWithBalanceDecimals({
          parsedMovements: parsedSplMovements,
          balanceMovements: tokenBalanceSplMovements,
        })
        if (
          parsedWithObservedDecimals !== null &&
          movementTotalsEqual(parsedWithObservedDecimals, tokenBalanceSplMovements)
        ) {
          return parsedWithObservedDecimals
        }

        if (
          movementTotalsEqual(transferRowSplMovements, tokenBalanceSplMovements) &&
          movementRawTotalsEqual(transferRowSplMovements, tokenBalanceSplMovements)
        ) {
          return transferRowSplMovements
        }

        return tokenBalanceSplMovements
      }

      if (parsedSplMovements.length > 0) {
        return parsedSplMovements
      }

      return transferRowSplMovements
    }

    const chooseCanonicalSplMovements = ({
      parsedSplMovements,
      tokenBalanceSplMovements,
      transferRowSplMovements,
    }: {
      readonly parsedSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly tokenBalanceSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      if (tokenBalanceSplMovements.length > 0) {
        return tokenBalanceSplMovements
      }

      if (parsedSplMovements.length > 0) {
        return parsedSplMovements
      }

      return transferRowSplMovements
    }

    function enrichParsedMovementsWithBalanceDecimals({
      parsedMovements,
      balanceMovements,
    }: {
      readonly parsedMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly balanceMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> | null {
      if (parsedMovements.length === 0) {
        return null
      }

      const decimalsByMovement = new Map<string, number | null>()
      for (const movement of balanceMovements) {
        if (movement.observedDecimals === null) {
          return null
        }

        const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}`
        const existing = decimalsByMovement.get(key)
        if (existing !== undefined && existing !== movement.observedDecimals) {
          decimalsByMovement.set(key, null)
        } else if (existing === undefined) {
          decimalsByMovement.set(key, movement.observedDecimals)
        }
      }

      const enriched: Array<SolanaBalanceMovement> = []
      for (const movement of parsedMovements) {
        const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}`
        const decimals = decimalsByMovement.get(key)
        if (decimals === undefined || decimals === null) {
          return null
        }

        const rawUnits = decimalAmountToExactRawUnits({ amount: movement.amount, decimals })
        if (rawUnits === null) {
          return null
        }

        enriched.push({ ...movement, rawUnits, observedDecimals: decimals })
      }

      return enriched
    }

    function movementRawTotalsEqual(
      left: ReadonlyArray<SolanaBalanceMovement>,
      right: ReadonlyArray<SolanaBalanceMovement>
    ): boolean {
      const totals = (movements: ReadonlyArray<SolanaBalanceMovement>) => {
        const result = new Map<string, bigint>()

        for (const movement of movements) {
          if (movement.observedDecimals === null || !/^\d+$/.test(movement.rawUnits)) {
            return null
          }

          const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}:${movement.observedDecimals}`
          result.set(key, (result.get(key) ?? 0n) + BigInt(movement.rawUnits))
        }

        return result
      }

      const leftTotals = totals(left)
      const rightTotals = totals(right)
      if (leftTotals === null || rightTotals === null || leftTotals.size !== rightTotals.size) {
        return false
      }

      return Array.from(leftTotals).every(([key, amount]) => rightTotals.get(key) === amount)
    }

    function movementTotalsEqual(
      left: ReadonlyArray<SolanaBalanceMovement>,
      right: ReadonlyArray<SolanaBalanceMovement>
    ): boolean {
      if (left.length === 0 || right.length === 0) {
        return false
      }

      const totals = (movements: ReadonlyArray<SolanaBalanceMovement>) => {
        const result = new Map<string, BigDecimal.BigDecimal>()

        for (const movement of movements) {
          const amount = BigDecimal.fromString(movement.amount)
          if (Option.isNone(amount)) {
            return null
          }

          const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}`
          const existing = result.get(key)
          result.set(
            key,
            existing === undefined ? amount.value : BigDecimal.sum(existing, amount.value)
          )
        }

        return result
      }

      const leftTotals = totals(left)
      const rightTotals = totals(right)
      if (leftTotals === null || rightTotals === null || leftTotals.size !== rightTotals.size) {
        return false
      }

      return Array.from(leftTotals).every(([key, amount]) => {
        const rightAmount = rightTotals.get(key)
        return rightAmount !== undefined && BigDecimal.equals(amount, rightAmount)
      })
    }

    const findContradictionsForEvidence = ({
      authoritativeSplMovements,
      transferRowSplMovements,
    }: {
      readonly authoritativeSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      if (authoritativeSplMovements === transferRowSplMovements) {
        return []
      }

      return findTransferRowContradictions({
        transferRows: transferRowSplMovements,
        authoritativeMovements: authoritativeSplMovements,
      })
    }

    const buildNormalizationReview = ({
      principalId,
      payload,
      movements,
      contradictions,
      resolvedTransactionType,
    }: {
      readonly principalId: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly movements: ReadonlyArray<SolanaBalanceMovement>
      readonly contradictions: ReadonlyArray<MovementContradiction>
      readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
    }): SourceTransactionReviewDraft | null => {
      const hasUnresolvedAssets = movements.some(
        (movement) => movement.asset.canonicalAssetId === null
      )
      const hasFailedTransaction = payload.meta?.err !== null
      const hasUnclassifiedSuccessfulTransaction =
        payload.meta?.err === null &&
        movements.length === 0 &&
        (resolvedTransactionType.mappingStatus === "pending_review" ||
          resolvedTransactionType.transactionType === null)

      if (
        !hasUnresolvedAssets &&
        !hasFailedTransaction &&
        contradictions.length === 0 &&
        !hasUnclassifiedSuccessfulTransaction
      ) {
        return null
      }

      if (hasFailedTransaction) {
        return buildReview({
          principalId,
          reason: "Solana transaction failed; only fee data was normalized.",
          matchedLayer: "solana_failed_transaction",
        })
      }

      if (contradictions.length > 0) {
        return buildReview({
          principalId,
          reason:
            "Solana transaction has contradictory transfer-row evidence that requires review.",
          matchedLayer: "solana_transfer_evidence",
        })
      }

      if (hasUnresolvedAssets) {
        return buildReview({
          principalId,
          reason:
            "Solana transaction contains unsupported or unmapped SPL asset movement that requires review.",
          matchedLayer: "solana_asset_mapping",
        })
      }

      return buildReview({
        principalId,
        reason:
          "Solana transaction normalized without a deterministic activity classification and requires review.",
        matchedLayer: "solana_unknown_activity",
      })
    }

    const buildOnchainContext = ({
      addressId,
      blockchainId,
      signature,
      payload,
      walletAddress,
      providerTransactionType,
      nativeAsset,
    }: {
      readonly addressId: string | null
      readonly blockchainId: string
      readonly signature: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly walletAddress: string
      readonly providerTransactionType: string
      readonly nativeAsset: HeliusSolanaResolvedAsset
    }): SourceOnchainContextDraft | null => {
      if (addressId === null) {
        return null
      }

      const positionInBlock =
        payload.transactionIndex === undefined ? null : String(payload.transactionIndex)

      return {
        blockchainId,
        addressId,
        chainTxId: signature,
        blockHeight: String(payload.slot),
        blockHash: null,
        positionInBlock,
        fromAddress: firstSignerOrFallback({ payload, fallback: walletAddress }),
        toAddress: walletAddress,
        gasUsed: null,
        gasPrice: null,
        feeAmount: payload.meta?.fee === undefined ? null : String(payload.meta.fee),
        feeAssetId: nativeAsset.canonicalAssetId,
        feeCostBasisAmount: null,
        feeCostBasisCurrency: null,
        isError: payload.meta?.err !== null,
        functionName: providerTransactionType,
        metadata: {
          provider: HELIUS_SOLANA_PROVIDER_KEY,
          explorerUrl: `${SOLANA_EXPLORER_SIGNATURE_URL}${signature}`,
          error: payload.meta?.err ?? null,
          instructions: payload.transaction.message.instructions ?? [],
        },
      }
    }

    const buildTransactionDraft = ({
      sourceId,
      sourceRawRecordId,
      principalId,
      signature,
      timestamp,
      providerTransactionType,
      resolvedTransactionType,
      payload,
      activityFacts,
      contradictions,
    }: {
      readonly sourceId: string
      readonly sourceRawRecordId: string
      readonly principalId: string
      readonly signature: string
      readonly timestamp: Date
      readonly providerTransactionType: string
      readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly activityFacts: ActivityFacts
      readonly contradictions: ReadonlyArray<MovementContradiction>
    }): SourceTransactionDraft => ({
      sourceId,
      sourceRawRecordId,
      externalId: signature,
      externalGroupId: signature,
      timestamp,
      transactionType: resolvedTransactionType.transactionType,
      providerTransactionType,
      providerStatus: payload.meta?.err === null ? "succeeded" : "failed",
      providerResourcePath: `${SOLANA_EXPLORER_SIGNATURE_URL}${signature}`,
      providerDescription: payload.description ?? null,
      providerCreatedAt: timestamp,
      providerUpdatedAt: null,
      metadata: {
        provider: HELIUS_SOLANA_PROVIDER_KEY,
        source: payload.source ?? null,
        type: payload.type ?? null,
        activityFacts,
        transferEvidenceContradictions: contradictions,
      },
      principalId,
    })

    const buildVenueContext = ({
      walletAddress,
    }: {
      readonly walletAddress: string
    }): SourceVenueContextDraft => ({
      venueType: "dex",
      cexAccountId: null,
      externalAccountId: walletAddress,
      externalOrderId: null,
      externalFillId: null,
      side: null,
      instrument: null,
      fillPrice: null,
      commissionAmount: null,
      commissionCurrency: null,
      metadata: {
        provider: HELIUS_SOLANA_PROVIDER_KEY,
        chain: SOLANA_BLOCKCHAIN_NAME,
      },
    })

    return HeliusSolanaSourceSyncProvider.of({
      fetchRawBatch,
      refreshReferenceData,
      loadNormalizationLookups,
      prepareNormalization: ({ source, sourceRecord, lookups }) =>
        Effect.gen(function* () {
          const blockchainId = yield* requireSolanaBlockchainId(lookups)

          const walletAddress = yield* resolveWalletAddress({
            sourceId: source.id,
            sourceWalletAddress: source.walletAddress,
            sourceRecordExternalAccountId: sourceRecord.externalAccountId,
          })

          const payload = yield* decodeNormalizationPayload(sourceRecord.payload)

          const signature = yield* requirePayloadSignature(payload)

          const walletTransferEvidence = yield* fetchWalletTransferEvidence({
            walletAddress,
            signature,
          })

          const timestamp = timestampFromPayload({
            payload,
            fallback: sourceRecord.occurredAt,
          })

          const providerTransactionType = toProviderTransactionType(payload)

          const nativeAsset = yield* resolveNativeSol.pipe(
            Effect.mapError(
              (cause) =>
                new HeliusSolanaNormalizationReferenceError({
                  message: "Failed to resolve native Solana asset.",
                  cause,
                })
            )
          )

          const rawSolMovements = buildSolMovements({
            payload,
            nativeAsset,
            walletAddress,
          })

          const {
            nativeMovements: solMovements,
            splTransfers: splWalletTransferEvidence,
            ambiguousTransfers: ambiguousNativeSolTransfers,
          } = refineNativeSolEvidence({
            transfers: walletTransferEvidence,
            nativeMovements: rawSolMovements,
            nativeAsset,
            walletAddress,
            payload,
          })

          const tokenMints = collectSplTokenMints({
            payload,
            walletTransferEvidence: splWalletTransferEvidence,
          })

          const resolvedTokens = yield* assetResolutionService
            .resolveAssets({
              assets: tokenMints.map((mintAddress) => ({
                kind: "spl",
                mintAddress,
              })),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HeliusSolanaNormalizationReferenceError({
                    message: "Failed to resolve Solana SPL assets.",
                    cause,
                  })
              )
            )

          const assetsByMint = mapAssetsByMint(tokenMints, resolvedTokens)

          const parsedSplMovements = buildParsedSplMovements({
            transfers: payload.tokenTransfers ?? [],
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })

          const transferRowSplMovements = buildTransferRowSplMovements({
            transfers: splWalletTransferEvidence,
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })

          const tokenBalanceSplMovements = buildSplMovements({
            payload,
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })

          const splMovements = chooseAuthoritativeSplMovements({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })

          const joinedSplMovements =
            splMovements === transferRowSplMovements
              ? splMovements
              : joinTransferRowEvidence({
                  authoritativeMovements: splMovements,
                  transferRowMovements: transferRowSplMovements,
                })

          const canonicalSplMovements = chooseCanonicalSplMovements({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })
          const joinedCanonicalSplMovements =
            canonicalSplMovements === transferRowSplMovements
              ? canonicalSplMovements
              : joinTransferRowEvidence({
                  authoritativeMovements: canonicalSplMovements,
                  transferRowMovements: transferRowSplMovements,
                })

          const contradictions = [
            ...findContradictionsForEvidence({
              authoritativeSplMovements: splMovements,
              transferRowSplMovements,
            }),
            ...ambiguousNativeSolTransfers.map(
              (transfer): MovementContradiction => ({
                reason:
                  "Wallet transfer row could not be classified exactly as native SOL or wrapped SOL.",
                evidence: transfer,
              })
            ),
          ]

          const movements = [
            ...solMovements,
            ...joinedSplMovements.map((movement, index) => ({
              ...movement,
              position: solMovements.length + index,
            })),
          ]
          const canonicalMovements = [...rawSolMovements, ...joinedCanonicalSplMovements]

          const canonicalTransfers = canonicalMovements.flatMap((movement) => {
            const draft = buildTransferDraft({
              source,
              sourceRecord,
              blockchainId,
              movement,
              signature,
              timestamp,
            })
            return draft === null ? [] : [draft]
          })

          const movementsMatch = (
            candidate: SolanaBalanceMovement,
            movement: SolanaBalanceMovement
          ): boolean =>
            candidate.role === movement.role &&
            candidate.direction === movement.direction &&
            candidate.asset.providerAssetRowId === movement.asset.providerAssetRowId &&
            candidate.fromAddress === movement.fromAddress &&
            candidate.toAddress === movement.toAddress &&
            movementAmountsEqual(candidate, movement)

          const matchedObservedMovementIndexes = new Set<number>()
          const matchedCanonicalMovementIndexes = new Set<number>()
          canonicalMovements.forEach((canonicalMovement, canonicalIndex) => {
            const observedIndex = movements.findIndex(
              (movement, index) =>
                !matchedObservedMovementIndexes.has(index) &&
                movementsMatch(canonicalMovement, movement)
            )
            if (observedIndex !== -1) {
              matchedObservedMovementIndexes.add(observedIndex)
              matchedCanonicalMovementIndexes.add(canonicalIndex)
            }
          })

          const canonicalProviderTransfers = canonicalMovements.map((movement, index) => {
            const hasObservedMatch = matchedCanonicalMovementIndexes.has(index)

            return buildProviderTransferDraft({
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              blockchainId,
              signature,
              timestamp,
              movement,
              externalId: `${signature}:provider:${movement.role}:${movement.position}`,
              canonicalTransferExternalId: `${signature}:${movement.role}:${movement.position}`,
              evidenceOnly: false,
              accountingOnly: !hasObservedMatch,
            })
          })
          const evidenceProviderTransfers = movements.flatMap((movement, index) => {
            if (matchedObservedMovementIndexes.has(index)) {
              return []
            }

            return [
              buildProviderTransferDraft({
                sourceId: source.id,
                sourceRawRecordId: sourceRecord.id,
                blockchainId,
                signature,
                timestamp,
                movement,
                externalId: `${signature}:provider:${movement.role}:evidence:${movement.position}`,
                canonicalTransferExternalId: null,
                evidenceOnly: true,
                accountingOnly: false,
              }),
            ]
          })
          const providerTransfers = [...canonicalProviderTransfers, ...evidenceProviderTransfers]

          const resolvedTransactionType = stableMapping(
            providerTransactionType === "failed" ? "gas_fee" : null
          )

          const transactionReview = buildNormalizationReview({
            principalId: source.principalId,
            payload,
            movements,
            contradictions,
            resolvedTransactionType,
          })

          const onchainContext = buildOnchainContext({
            addressId: source.addressId,
            blockchainId,
            signature,
            payload,
            walletAddress,
            providerTransactionType,
            nativeAsset,
          })

          const activityFacts = buildActivityFacts({
            sourceId: source.id,
            signature,
            timestamp,
            providerTransactionType,
            blockchainId,
            payload,
            movements,
            contradictions,
          })

          return {
            transaction: buildTransactionDraft({
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              principalId: source.principalId,
              signature,
              timestamp,
              providerTransactionType,
              resolvedTransactionType,
              payload,
              activityFacts,
              contradictions,
            }),
            venueContext: buildVenueContext({ walletAddress }),
            onchainContext,
            providerTransfers,
            feeTransfers: canonicalTransfers,
            transactionReview,
            resolvedTransactionType,
            legDerivationStrategy: "skip",
          }
        }),
      deriveLegs: ({ transaction }) =>
        Effect.fail(
          normalizationNotImplemented({
            transactionId: transaction.id,
            externalId: transaction.externalId,
          })
        ),
    } satisfies HeliusSolanaSourceSyncProviderShape)
  })

const makeWithEmptyReferenceData = make({
  refreshReferenceData: () => Effect.succeed(emptyReferenceDataRefresh),
})

const makeWithAssetResolutionReferenceData = Effect.gen(function* () {
  const assetResolutionService = yield* HeliusSolanaAssetResolutionService

  return yield* make({
    refreshReferenceData: () =>
      assetResolutionService
        .ensureDefaultMappings()
        .pipe(
          Effect.map(toHeliusSolanaReferenceDataRefreshResult),
          Effect.mapError(toReferenceRefreshStorageError)
        ),
  })
})

/**
 * HeliusSolanaSourceSyncProviderFromClientLive - Helius provider layer with an injectable client.
 */
export const HeliusSolanaSourceSyncProviderFromClientLive = Layer.effect(
  HeliusSolanaSourceSyncProvider,
  makeWithEmptyReferenceData
)

/**
 * HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive - Injectable Helius provider with asset reference refresh.
 */
export const HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive = Layer.effect(
  HeliusSolanaSourceSyncProvider,
  makeWithAssetResolutionReferenceData
)

/**
 * HeliusSolanaSourceSyncProviderLive - Production Helius Solana provider layer.
 */
export const HeliusSolanaSourceSyncProviderLive =
  HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive.pipe(
    Layer.provide(HeliusSolanaAssetResolutionServiceLive),
    Layer.provide(HeliusSolanaSyncClientLive)
  )
