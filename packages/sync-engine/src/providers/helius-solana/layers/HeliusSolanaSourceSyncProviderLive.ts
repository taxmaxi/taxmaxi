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

const HeliusSolanaTokenBalanceSchema = Schema.Struct({
  accountIndex: Schema.Number,
  mint: Schema.String,
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  programId: Schema.optional(Schema.NullOr(Schema.String)),
  uiTokenAmount: Schema.Struct({
    amount: Schema.String,
    decimals: Schema.Number,
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
  decimals: Schema.Number,
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

const decimalToRawTokenAmount = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number
}): string =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => amount,
    onSome: (decimal) => BigDecimal.scale(decimal, decimals).value.toString(),
  })

const isDecimalZero = (amount: string): boolean =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => false,
    onSome: BigDecimal.isZero,
  })

const parsedTokenAmountToMovementAmount = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number | null
}) => {
  if (decimals === null) {
    return {
      amount,
      rawUnits: amount,
    }
  }

  const rawUnits = decimalToRawTokenAmount({ amount, decimals })
  return {
    amount: rawTokenAmountToDecimal({ amount: rawUnits, decimals }),
    rawUnits,
  }
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
  signature,
  timestamp,
  movement,
}: {
  readonly sourceId: string
  readonly sourceRawRecordId: string
  readonly signature: string
  readonly timestamp: Date
  readonly movement: SolanaBalanceMovement
}): SourceProviderTransferDraft => ({
  sourceId,
  sourceRawRecordId,
  externalId: `${signature}:provider:${movement.role}:${movement.position}`,
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
  amount: movement.amount,
  metadata: {
    provider: HELIUS_SOLANA_PROVIDER_KEY,
    role: movement.role,
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
        pagesRemaining: number
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
              if (
                matches.length > 0 ||
                !page.pagination.hasMore ||
                pagesRemaining <= 1 ||
                page.pagination.nextCursor === null ||
                page.pagination.nextCursor === undefined
              ) {
                return Effect.succeed(matches)
              }

              return fetchPage(page.pagination.nextCursor, pagesRemaining - 1)
            })
          )

      return fetchPage(null, 10).pipe(
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
        const movementAmount = parsedTokenAmountToMovementAmount({
          amount: tokenAmount,
          decimals: asset.decimals,
        })

        return [
          {
            asset,
            amount: movementAmount.amount,
            rawUnits: movementAmount.rawUnits,
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

    const movementComparisonKey = (movement: SolanaBalanceMovement): string =>
      [
        movement.asset.mintAddress ?? SOLANA_WRAPPED_NATIVE_MINT,
        movement.direction,
        movement.rawUnits,
      ].join(":")

    const findTransferRowContradictions = ({
      transferRows,
      authoritativeMovements,
    }: {
      readonly transferRows: ReadonlyArray<SolanaBalanceMovement>
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      const authoritativeKeys = new Set(authoritativeMovements.map(movementComparisonKey))
      return transferRows
        .filter((movement) => !authoritativeKeys.has(movementComparisonKey(movement)))
        .map((movement) => ({
          reason: "Helius transfer-row evidence contradicts full transaction movement evidence.",
          evidence: {
            mintAddress: movement.asset.mintAddress,
            direction: movement.direction,
            amount: movement.amount,
            rawUnits: movement.rawUnits,
            evidenceKind: movement.evidenceKind,
          },
        }))
    }

    const joinTransferRowEvidenceByPosition = ({
      authoritativeMovements,
      transferRowMovements,
    }: {
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const transferRowsByPosition = new Map(
        transferRowMovements.map((movement) => [movement.position, movement])
      )

      return authoritativeMovements.map((movement) => {
        const transferRowMovement = transferRowsByPosition.get(movement.position)
        const supplementalTransferRow = transferRowMovement?.supplementalTransferRow ?? null

        if (
          supplementalTransferRow === null ||
          movement.evidenceKind === "transfer_row" ||
          transferRowMovement === undefined ||
          movementComparisonKey(movement) !== movementComparisonKey(transferRowMovement)
        ) {
          return movement
        }

        return {
          ...movement,
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
              assetSymbol: movement.asset.canonicalAssetSymbol,
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
        return tokenBalanceSplMovements
      }

      if (parsedSplMovements.length > 0) {
        return parsedSplMovements
      }

      return transferRowSplMovements
    }

    const findContradictionsForEvidence = ({
      parsedSplMovements,
      tokenBalanceSplMovements,
      transferRowSplMovements,
    }: {
      readonly parsedSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly tokenBalanceSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      if (tokenBalanceSplMovements.length > 0) {
        return findTransferRowContradictions({
          transferRows: transferRowSplMovements,
          authoritativeMovements: tokenBalanceSplMovements,
        })
      }

      if (parsedSplMovements.length > 0) {
        return findTransferRowContradictions({
          transferRows: transferRowSplMovements,
          authoritativeMovements: parsedSplMovements,
        })
      }

      return []
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

          const tokenMints = collectSplTokenMints({ payload, walletTransferEvidence })

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

          const solMovements = buildSolMovements({
            payload,
            nativeAsset,
            walletAddress,
          })

          const parsedSplMovements = buildParsedSplMovements({
            transfers: payload.tokenTransfers ?? [],
            walletAddress,
            assetsByMint,
            offset: solMovements.length,
          })

          const transferRowSplMovements = buildTransferRowSplMovements({
            transfers: walletTransferEvidence,
            walletAddress,
            assetsByMint,
            offset: solMovements.length,
          })

          const tokenBalanceSplMovements = buildSplMovements({
            payload,
            walletAddress,
            assetsByMint,
            offset: solMovements.length,
          })

          const splMovements = chooseAuthoritativeSplMovements({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })

          const joinedSplMovements =
            splMovements === transferRowSplMovements
              ? splMovements
              : joinTransferRowEvidenceByPosition({
                  authoritativeMovements: splMovements,
                  transferRowMovements: transferRowSplMovements,
                })

          const contradictions = findContradictionsForEvidence({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })

          const movements = [...solMovements, ...joinedSplMovements]

          const canonicalTransfers = movements.flatMap((movement) => {
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

          const providerTransfers = movements.map((movement) =>
            buildProviderTransferDraft({
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              signature,
              timestamp,
              movement,
            })
          )

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
