/**
 * Extracts compact Solana behavior evidence from raw Helius/RPC transaction payloads.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const TokenAmountSchema = Schema.Struct({
  amount: Schema.String,
  decimals: Schema.Number,
  uiAmountString: Schema.optional(Schema.String),
})

const TokenBalanceSchema = Schema.Struct({
  accountIndex: Schema.Number,
  mint: Schema.String,
  owner: Schema.optional(Schema.String),
  uiTokenAmount: TokenAmountSchema,
})

const AccountKeySchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    pubkey: Schema.String,
  })
)

const InstructionSchema = Schema.Struct({
  programId: Schema.optional(Schema.String),
  program: Schema.optional(Schema.String),
})

const InnerInstructionsSchema = Schema.Struct({
  index: Schema.Number,
  instructions: Schema.Array(InstructionSchema),
})

const TransactionBodySchema = Schema.Struct({
  signatures: Schema.optional(Schema.Array(Schema.String)),
  message: Schema.Struct({
    accountKeys: Schema.optional(Schema.Array(AccountKeySchema)),
    instructions: Schema.optional(Schema.Array(InstructionSchema)),
  }),
})

const TransactionMetaSchema = Schema.NullOr(
  Schema.Struct({
    err: Schema.NullOr(Schema.Unknown),
    preBalances: Schema.optional(Schema.Array(Schema.Number)),
    postBalances: Schema.optional(Schema.Array(Schema.Number)),
    preTokenBalances: Schema.optional(Schema.Array(TokenBalanceSchema)),
    postTokenBalances: Schema.optional(Schema.Array(TokenBalanceSchema)),
    innerInstructions: Schema.optional(Schema.Array(InnerInstructionsSchema)),
  })
)

const TransactionPayloadSchema = Schema.Struct({
  slot: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  transaction: Schema.optional(TransactionBodySchema),
  meta: Schema.optional(TransactionMetaSchema),
})

const decodeTransactionPayloadEither = Schema.decodeUnknownEither(TransactionPayloadSchema)

export const SolanaNativeBalanceDeltaEvidence = Schema.Struct({
  accountIndex: Schema.Number,
  account: Schema.NullOr(Schema.String),
  preLamports: Schema.String,
  postLamports: Schema.String,
  deltaLamports: Schema.String,
})

export const SolanaTokenBalanceDeltaEvidence = Schema.Struct({
  accountIndex: Schema.Number,
  owner: Schema.NullOr(Schema.String),
  mint: Schema.String,
  decimals: Schema.Number,
  preAmount: Schema.String,
  postAmount: Schema.String,
  deltaAmount: Schema.String,
})

export const SolanaProviderLabelEvidence = Schema.Struct({
  type: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
})

export const SolanaBehaviorSample = Schema.Struct({
  signature: Schema.String,
  slot: Schema.NullOr(Schema.Number),
  status: Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.NullOr(Schema.Unknown),
  }),
  invokedProgramIds: Schema.Array(Schema.String),
  nativeBalanceDeltas: Schema.Array(SolanaNativeBalanceDeltaEvidence),
  tokenBalanceDeltas: Schema.Array(SolanaTokenBalanceDeltaEvidence),
  providerLabels: SolanaProviderLabelEvidence,
})
export type SolanaBehaviorSample = typeof SolanaBehaviorSample.Type

export const SolanaBehaviorSamplingInput = Schema.Struct({
  signatures: Schema.Array(Schema.String),
  programs: Schema.Array(Schema.String),
  slotRange: Schema.NullOr(
    Schema.Struct({
      fromSlot: Schema.Number,
      toSlot: Schema.Number,
    })
  ),
  sampleLimit: Schema.Number,
})
export type SolanaBehaviorSamplingInput = typeof SolanaBehaviorSamplingInput.Type

export const SolanaBehaviorSampleError = Schema.Struct({
  scope: Schema.Literal("signature", "slot", "payload"),
  target: Schema.String,
  message: Schema.String,
})
export type SolanaBehaviorSampleError = typeof SolanaBehaviorSampleError.Type

/** JSON artifact emitted by the Solana behavior sampler command. */
export const SolanaBehaviorSamplesArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  source: Schema.Literal("helius-solana"),
  generatedAt: Schema.String,
  sampling: SolanaBehaviorSamplingInput,
  samples: Schema.Array(SolanaBehaviorSample),
  errors: Schema.Array(SolanaBehaviorSampleError),
})
export type SolanaBehaviorSamplesArtifact = typeof SolanaBehaviorSamplesArtifact.Type

export class SolanaBehaviorPayloadDecodeError extends Schema.TaggedError<SolanaBehaviorPayloadDecodeError>()(
  "SolanaBehaviorPayloadDecodeError",
  {
    message: Schema.String,
  }
) {}

/** Client failure returned by the injected Solana behavior sampler RPC client. */
export class SolanaBehaviorSamplerClientError extends Schema.TaggedError<SolanaBehaviorSamplerClientError>()(
  "SolanaBehaviorSamplerClientError",
  {
    message: Schema.String,
  }
) {}

export interface FetchTransactionBySignatureParams {
  readonly signature: string
}

export interface FetchFinalizedBlockParams {
  readonly slot: number
}

/** RPC client contract used by the sampler to fetch transactions and finalized blocks. */
export interface SolanaBehaviorSamplerClientShape {
  readonly fetchTransactionBySignature: (
    params: FetchTransactionBySignatureParams
  ) => Effect.Effect<unknown, SolanaBehaviorSamplerClientError>
  readonly fetchFinalizedBlock: (
    params: FetchFinalizedBlockParams
  ) => Effect.Effect<unknown, SolanaBehaviorSamplerClientError>
}

/** Service tag for the Solana behavior sampler RPC client. */
export class SolanaBehaviorSamplerClient extends Context.Tag("SolanaBehaviorSamplerClient")<
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplerClientShape
>() {}

const accountKeyAddress = (accountKey: typeof AccountKeySchema.Type | undefined): string | null => {
  if (accountKey === undefined) {
    return null
  }

  return typeof accountKey === "string" ? accountKey : accountKey.pubkey
}

const signatureFromPayload = (payload: typeof TransactionPayloadSchema.Type): string | null => {
  if (payload.signature !== undefined && payload.signature.trim() !== "") {
    return payload.signature
  }

  const signature = payload.transaction?.signatures?.[0]
  return signature === undefined || signature.trim() === "" ? null : signature
}

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))

const INTEGER_STRING_PATTERN = /^-?\d+$/

const toPayloadDecodeError = (message: string): SolanaBehaviorPayloadDecodeError =>
  new SolanaBehaviorPayloadDecodeError({ message })

const parseIntegerString = ({
  value,
  path,
}: {
  readonly value: string
  readonly path: string
}): Effect.Effect<bigint, SolanaBehaviorPayloadDecodeError> =>
  INTEGER_STRING_PATTERN.test(value)
    ? Effect.succeed(BigInt(value))
    : Effect.fail(toPayloadDecodeError(`Invalid Solana transaction payload ${path}: ${value}`))

const parseIntegerNumber = ({
  value,
  path,
}: {
  readonly value: number
  readonly path: string
}): Effect.Effect<bigint, SolanaBehaviorPayloadDecodeError> =>
  Number.isInteger(value)
    ? Effect.succeed(BigInt(value))
    : Effect.fail(toPayloadDecodeError(`Invalid Solana transaction payload ${path}: ${value}`))

const invokedProgramIdsFromPayload = (
  payload: typeof TransactionPayloadSchema.Type
): ReadonlyArray<string> => {
  const topLevel = payload.transaction?.message.instructions ?? []
  const inner = payload.meta?.innerInstructions?.flatMap((entry) => entry.instructions) ?? []

  return uniqueStrings(
    [...topLevel, ...inner].flatMap((instruction) =>
      instruction.programId === undefined ? [] : [instruction.programId]
    )
  )
}

const nativeBalanceDeltasFromPayload = (
  payload: typeof TransactionPayloadSchema.Type
): Effect.Effect<
  ReadonlyArray<typeof SolanaNativeBalanceDeltaEvidence.Type>,
  SolanaBehaviorPayloadDecodeError
> => {
  const preBalances = payload.meta?.preBalances ?? []
  const postBalances = payload.meta?.postBalances ?? []
  const accountKeys = payload.transaction?.message.accountKeys ?? []
  const maxLength = Math.max(preBalances.length, postBalances.length)

  return Effect.forEach(
    Array.from({ length: maxLength }, (_, accountIndex) => accountIndex),
    (accountIndex) =>
      Effect.gen(function* () {
        const preLamports = yield* parseIntegerNumber({
          value: preBalances[accountIndex] ?? 0,
          path: `preBalances[${accountIndex}]`,
        })
        const postLamports = yield* parseIntegerNumber({
          value: postBalances[accountIndex] ?? 0,
          path: `postBalances[${accountIndex}]`,
        })

        return {
          accountIndex,
          account: accountKeyAddress(accountKeys[accountIndex]),
          preLamports: preLamports.toString(),
          postLamports: postLamports.toString(),
          deltaLamports: (postLamports - preLamports).toString(),
        }
      })
  ).pipe(Effect.map((deltas) => deltas.filter((delta) => delta.deltaLamports !== "0")))
}

const tokenBalanceKey = (balance: typeof TokenBalanceSchema.Type): string =>
  `${balance.accountIndex}:${balance.mint}:${balance.owner ?? ""}`

const tokenBalanceDeltasFromPayload = (
  payload: typeof TransactionPayloadSchema.Type
): Effect.Effect<
  ReadonlyArray<typeof SolanaTokenBalanceDeltaEvidence.Type>,
  SolanaBehaviorPayloadDecodeError
> => {
  const preBalances = payload.meta?.preTokenBalances ?? []
  const postBalances = payload.meta?.postTokenBalances ?? []
  const preByKey = new Map(preBalances.map((balance) => [tokenBalanceKey(balance), balance]))
  const postByKey = new Map(postBalances.map((balance) => [tokenBalanceKey(balance), balance]))
  const keys = uniqueStrings([...preByKey.keys(), ...postByKey.keys()])

  return Effect.forEach(keys, (key) => {
    const pre = preByKey.get(key)
    const post = postByKey.get(key)
    const representative = post ?? pre

    if (representative === undefined) {
      return Effect.succeed([])
    }

    return Effect.gen(function* () {
      const preAmount = yield* parseIntegerString({
        value: pre?.uiTokenAmount.amount ?? "0",
        path: `token balance ${key} pre amount`,
      })
      const postAmount = yield* parseIntegerString({
        value: post?.uiTokenAmount.amount ?? "0",
        path: `token balance ${key} post amount`,
      })
      const deltaAmount = postAmount - preAmount

      return deltaAmount === 0n
        ? []
        : [
            {
              accountIndex: representative.accountIndex,
              owner: representative.owner ?? null,
              mint: representative.mint,
              decimals: representative.uiTokenAmount.decimals,
              preAmount: preAmount.toString(),
              postAmount: postAmount.toString(),
              deltaAmount: deltaAmount.toString(),
            },
          ]
    })
  }).pipe(Effect.map((deltas) => deltas.flat()))
}

const statusFromPayloadMeta = (
  meta: typeof TransactionMetaSchema.Type | undefined
): SolanaBehaviorSample["status"] =>
  meta === undefined || meta === null
    ? {
        ok: false,
        error: "missing transaction metadata",
      }
    : {
        ok: meta.err === null,
        error: meta.err,
      }

export const extractSolanaBehaviorSample = ({
  payload,
  slot,
}: {
  readonly payload: unknown
  readonly slot: number | null
}): Effect.Effect<SolanaBehaviorSample, SolanaBehaviorPayloadDecodeError> => {
  const decoded = decodeTransactionPayloadEither(payload)

  return Effect.gen(function* () {
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(
        toPayloadDecodeError(`Invalid Solana transaction payload: ${decoded.left.message}`)
      )
    }

    const transaction = decoded.right
    const signature = signatureFromPayload(transaction)

    if (signature === null) {
      return yield* Effect.fail(
        toPayloadDecodeError("Invalid Solana transaction payload: missing signature")
      )
    }

    const nativeBalanceDeltas = yield* nativeBalanceDeltasFromPayload(transaction)
    const tokenBalanceDeltas = yield* tokenBalanceDeltasFromPayload(transaction)

    return {
      signature,
      slot: transaction.slot ?? slot,
      status: statusFromPayloadMeta(transaction.meta),
      invokedProgramIds: [...invokedProgramIdsFromPayload(transaction)],
      nativeBalanceDeltas: [...nativeBalanceDeltas],
      tokenBalanceDeltas: [...tokenBalanceDeltas],
      providerLabels: {
        type: transaction.type ?? null,
        source: transaction.source ?? null,
      },
    }
  })
}

const BlockTransactionEntrySchema = Schema.Struct({
  meta: Schema.optional(TransactionMetaSchema),
  transaction: TransactionBodySchema,
})

const FinalizedBlockPayloadSchema = Schema.Struct({
  transactions: Schema.Array(BlockTransactionEntrySchema),
})

const decodeFinalizedBlockPayloadEither = Schema.decodeUnknownEither(FinalizedBlockPayloadSchema)

const blockTransactions = (
  payload: unknown
): Effect.Effect<
  ReadonlyArray<typeof TransactionPayloadSchema.Type>,
  SolanaBehaviorPayloadDecodeError
> => {
  const decoded = decodeFinalizedBlockPayloadEither(payload)

  return Either.isLeft(decoded)
    ? Effect.fail(
        new SolanaBehaviorPayloadDecodeError({
          message: `Invalid Solana block payload: ${decoded.left.message}`,
        })
      )
    : Effect.succeed(
        decoded.right.transactions.map((entry) =>
          entry.meta === undefined
            ? { transaction: entry.transaction }
            : { transaction: entry.transaction, meta: entry.meta }
        )
      )
}

const sampleMatchesPrograms = (
  sample: SolanaBehaviorSample,
  programs: ReadonlyArray<string>
): boolean =>
  programs.length === 0 ||
  sample.invokedProgramIds.some((programId) => programs.includes(programId))

interface SolanaBehaviorSamplingAccumulator {
  readonly samples: ReadonlyArray<SolanaBehaviorSample>
  readonly errors: ReadonlyArray<SolanaBehaviorSampleError>
}

const emptySamplingAccumulator: SolanaBehaviorSamplingAccumulator = {
  samples: [],
  errors: [],
}

const appendSample = (
  accumulator: SolanaBehaviorSamplingAccumulator,
  sample: SolanaBehaviorSample
): SolanaBehaviorSamplingAccumulator => ({
  samples: [...accumulator.samples, sample],
  errors: accumulator.errors,
})

const appendError = (
  accumulator: SolanaBehaviorSamplingAccumulator,
  error: SolanaBehaviorSampleError
): SolanaBehaviorSamplingAccumulator => ({
  samples: accumulator.samples,
  errors: [...accumulator.errors, error],
})

const collectSlotTransactionSamples = ({
  accumulator,
  transactionPayloads,
  slot,
  programs,
  remaining,
  index,
}: {
  readonly accumulator: SolanaBehaviorSamplingAccumulator
  readonly transactionPayloads: ReadonlyArray<typeof TransactionPayloadSchema.Type>
  readonly slot: number
  readonly programs: ReadonlyArray<string>
  readonly remaining: number
  readonly index: number
}): Effect.Effect<SolanaBehaviorSamplingAccumulator, never> =>
  index >= transactionPayloads.length || accumulator.samples.length >= remaining
    ? Effect.succeed(accumulator)
    : Effect.gen(function* () {
        const transactionPayload = transactionPayloads[index]
        const sampleEither =
          transactionPayload === undefined
            ? Either.left(
                toPayloadDecodeError(`Missing Solana transaction payload at slot ${slot}`)
              )
            : yield* Effect.either(
                extractSolanaBehaviorSample({ payload: transactionPayload, slot })
              )
        const nextAccumulator = Either.isLeft(sampleEither)
          ? appendError(accumulator, {
              scope: "payload",
              target: String(slot),
              message: sampleEither.left.message,
            })
          : sampleMatchesPrograms(sampleEither.right, programs)
            ? appendSample(accumulator, sampleEither.right)
            : accumulator

        return yield* collectSlotTransactionSamples({
          accumulator: nextAccumulator,
          transactionPayloads,
          slot,
          programs,
          remaining,
          index: index + 1,
        })
      })

const collectSlotSamples = ({
  accumulator,
  client,
  slot,
  programs,
  remaining,
}: {
  readonly accumulator: SolanaBehaviorSamplingAccumulator
  readonly client: SolanaBehaviorSamplerClientShape
  readonly slot: number
  readonly programs: ReadonlyArray<string>
  readonly remaining: number
}): Effect.Effect<SolanaBehaviorSamplingAccumulator, never> =>
  Effect.gen(function* () {
    const blockEither = yield* Effect.either(client.fetchFinalizedBlock({ slot }))

    if (Either.isLeft(blockEither)) {
      return appendError(accumulator, {
        scope: "slot",
        target: String(slot),
        message: blockEither.left.message,
      })
    }

    const transactionPayloadsEither = yield* Effect.either(blockTransactions(blockEither.right))

    if (Either.isLeft(transactionPayloadsEither)) {
      return appendError(accumulator, {
        scope: "slot",
        target: String(slot),
        message: transactionPayloadsEither.left.message,
      })
    }

    return yield* collectSlotTransactionSamples({
      accumulator,
      transactionPayloads: transactionPayloadsEither.right,
      slot,
      programs,
      remaining,
      index: 0,
    })
  })

const collectSlotRangeSamples = ({
  accumulator,
  client,
  fromSlot,
  toSlot,
  programs,
  remaining,
}: {
  readonly accumulator: SolanaBehaviorSamplingAccumulator
  readonly client: SolanaBehaviorSamplerClientShape
  readonly fromSlot: number
  readonly toSlot: number
  readonly programs: ReadonlyArray<string>
  readonly remaining: number
}): Effect.Effect<SolanaBehaviorSamplingAccumulator, never> =>
  fromSlot > toSlot || accumulator.samples.length >= remaining
    ? Effect.succeed(accumulator)
    : collectSlotSamples({
        accumulator,
        client,
        slot: fromSlot,
        programs,
        remaining,
      }).pipe(
        Effect.flatMap((nextAccumulator) =>
          collectSlotRangeSamples({
            accumulator: nextAccumulator,
            client,
            fromSlot: fromSlot + 1,
            toSlot,
            programs,
            remaining,
          })
        )
      )

const sampleSignaturesFromSlots = ({
  client,
  fromSlot,
  toSlot,
  programs,
  remaining,
}: {
  readonly client: SolanaBehaviorSamplerClientShape
  readonly fromSlot: number
  readonly toSlot: number
  readonly programs: ReadonlyArray<string>
  readonly remaining: number
}): Effect.Effect<
  {
    readonly samples: ReadonlyArray<SolanaBehaviorSample>
    readonly errors: ReadonlyArray<SolanaBehaviorSampleError>
  },
  never
> =>
  collectSlotRangeSamples({
    accumulator: emptySamplingAccumulator,
    client,
    fromSlot,
    toSlot,
    programs,
    remaining,
  })

const collectSignatureSamples = ({
  accumulator,
  client,
  signatures,
  sampleLimit,
  index,
}: {
  readonly accumulator: SolanaBehaviorSamplingAccumulator
  readonly client: SolanaBehaviorSamplerClientShape
  readonly signatures: ReadonlyArray<string>
  readonly sampleLimit: number
  readonly index: number
}): Effect.Effect<SolanaBehaviorSamplingAccumulator, never> =>
  index >= signatures.length || accumulator.samples.length >= sampleLimit
    ? Effect.succeed(accumulator)
    : Effect.gen(function* () {
        const signature = signatures[index]
        if (signature === undefined) {
          return yield* collectSignatureSamples({
            accumulator,
            client,
            signatures,
            sampleLimit,
            index: index + 1,
          })
        }

        const payloadEither = yield* Effect.either(
          client.fetchTransactionBySignature({ signature })
        )
        if (Either.isLeft(payloadEither)) {
          return yield* collectSignatureSamples({
            accumulator: appendError(accumulator, {
              scope: "signature",
              target: signature,
              message: payloadEither.left.message,
            }),
            client,
            signatures,
            sampleLimit,
            index: index + 1,
          })
        }

        const sampleEither = yield* Effect.either(
          extractSolanaBehaviorSample({ payload: payloadEither.right, slot: null })
        )
        const nextAccumulator = Either.isLeft(sampleEither)
          ? appendError(accumulator, {
              scope: "payload",
              target: signature,
              message: sampleEither.left.message,
            })
          : appendSample(accumulator, sampleEither.right)

        return yield* collectSignatureSamples({
          accumulator: nextAccumulator,
          client,
          signatures,
          sampleLimit,
          index: index + 1,
        })
      })

/** Builds the behavior sample artifact for direct signatures and optional slot sampling. */
export const buildSolanaBehaviorSamplesArtifact = ({
  generatedAt,
  sampling,
}: {
  readonly generatedAt: string
  readonly sampling: SolanaBehaviorSamplingInput
}): Effect.Effect<SolanaBehaviorSamplesArtifact, never, SolanaBehaviorSamplerClient> =>
  Effect.gen(function* () {
    const client = yield* SolanaBehaviorSamplerClient
    const signatureAccumulator = yield* collectSignatureSamples({
      accumulator: emptySamplingAccumulator,
      client,
      signatures: sampling.signatures,
      sampleLimit: sampling.sampleLimit,
      index: 0,
    })
    const remaining = sampling.sampleLimit - signatureAccumulator.samples.length
    const slotAccumulator =
      sampling.slotRange !== null && remaining > 0
        ? yield* sampleSignaturesFromSlots({
            client,
            fromSlot: sampling.slotRange.fromSlot,
            toSlot: sampling.slotRange.toSlot,
            programs: sampling.programs,
            remaining,
          })
        : emptySamplingAccumulator

    return {
      schemaVersion: 1,
      chain: "solana",
      source: "helius-solana",
      generatedAt,
      sampling,
      samples: [...signatureAccumulator.samples, ...slotAccumulator.samples],
      errors: [...signatureAccumulator.errors, ...slotAccumulator.errors],
    }
  })

/** Test layer for injecting deterministic sampler client behavior. */
export const SolanaBehaviorSamplerClientTestLive = (
  client: SolanaBehaviorSamplerClientShape
): Layer.Layer<SolanaBehaviorSamplerClient> => Layer.succeed(SolanaBehaviorSamplerClient, client)
