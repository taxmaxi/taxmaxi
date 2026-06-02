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

const TransactionPayloadSchema = Schema.Struct({
  slot: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  transaction: Schema.optional(
    Schema.Struct({
      signatures: Schema.optional(Schema.Array(Schema.String)),
      message: Schema.Struct({
        accountKeys: Schema.optional(Schema.Array(AccountKeySchema)),
        instructions: Schema.optional(Schema.Array(InstructionSchema)),
      }),
    })
  ),
  meta: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        err: Schema.NullOr(Schema.Unknown),
        preBalances: Schema.optional(Schema.Array(Schema.Number)),
        postBalances: Schema.optional(Schema.Array(Schema.Number)),
        preTokenBalances: Schema.optional(Schema.Array(TokenBalanceSchema)),
        postTokenBalances: Schema.optional(Schema.Array(TokenBalanceSchema)),
        innerInstructions: Schema.optional(Schema.Array(InnerInstructionsSchema)),
      })
    )
  ),
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

export interface SolanaBehaviorSamplerClientShape {
  readonly fetchTransactionBySignature: (
    params: FetchTransactionBySignatureParams
  ) => Effect.Effect<unknown, SolanaBehaviorSamplerClientError>
  readonly fetchFinalizedBlock: (
    params: FetchFinalizedBlockParams
  ) => Effect.Effect<unknown, SolanaBehaviorSamplerClientError>
}

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
): ReadonlyArray<typeof SolanaNativeBalanceDeltaEvidence.Type> => {
  const preBalances = payload.meta?.preBalances ?? []
  const postBalances = payload.meta?.postBalances ?? []
  const accountKeys = payload.transaction?.message.accountKeys ?? []
  const maxLength = Math.max(preBalances.length, postBalances.length)

  return Array.from({ length: maxLength }, (_, accountIndex) => {
    const preLamports = BigInt(preBalances[accountIndex] ?? 0)
    const postLamports = BigInt(postBalances[accountIndex] ?? 0)

    return {
      accountIndex,
      account: accountKeyAddress(accountKeys[accountIndex]),
      preLamports: preLamports.toString(),
      postLamports: postLamports.toString(),
      deltaLamports: (postLamports - preLamports).toString(),
    }
  }).filter((delta) => delta.deltaLamports !== "0")
}

const tokenBalanceKey = (balance: typeof TokenBalanceSchema.Type): string =>
  `${balance.accountIndex}:${balance.mint}:${balance.owner ?? ""}`

const tokenBalanceDeltasFromPayload = (
  payload: typeof TransactionPayloadSchema.Type
): ReadonlyArray<typeof SolanaTokenBalanceDeltaEvidence.Type> => {
  const preBalances = payload.meta?.preTokenBalances ?? []
  const postBalances = payload.meta?.postTokenBalances ?? []
  const preByKey = new Map(preBalances.map((balance) => [tokenBalanceKey(balance), balance]))
  const postByKey = new Map(postBalances.map((balance) => [tokenBalanceKey(balance), balance]))
  const keys = uniqueStrings([...preByKey.keys(), ...postByKey.keys()])

  return keys.flatMap((key) => {
    const pre = preByKey.get(key)
    const post = postByKey.get(key)
    const representative = post ?? pre

    if (representative === undefined) {
      return []
    }

    const preAmount = BigInt(pre?.uiTokenAmount.amount ?? "0")
    const postAmount = BigInt(post?.uiTokenAmount.amount ?? "0")
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
}

export const extractSolanaBehaviorSample = ({
  payload,
  slot,
}: {
  readonly payload: unknown
  readonly slot: number | null
}): Effect.Effect<SolanaBehaviorSample, SolanaBehaviorPayloadDecodeError> => {
  const decoded = decodeTransactionPayloadEither(payload)

  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new SolanaBehaviorPayloadDecodeError({
        message: `Invalid Solana transaction payload: ${decoded.left.message}`,
      })
    )
  }

  const transaction = decoded.right
  const signature = signatureFromPayload(transaction)

  if (signature === null) {
    return Effect.fail(
      new SolanaBehaviorPayloadDecodeError({
        message: "Invalid Solana transaction payload: missing signature",
      })
    )
  }

  return Effect.succeed({
    signature,
    slot: transaction.slot ?? slot,
    status: {
      ok: transaction.meta?.err === null || transaction.meta?.err === undefined,
      error: transaction.meta?.err ?? null,
    },
    invokedProgramIds: [...invokedProgramIdsFromPayload(transaction)],
    nativeBalanceDeltas: [...nativeBalanceDeltasFromPayload(transaction)],
    tokenBalanceDeltas: [...tokenBalanceDeltasFromPayload(transaction)],
    providerLabels: {
      type: transaction.type ?? null,
      source: transaction.source ?? null,
    },
  })
}

const BlockTransactionEntrySchema = Schema.Struct({
  transaction: TransactionPayloadSchema,
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
    : Effect.succeed(decoded.right.transactions.map((entry) => entry.transaction))
}

const sampleMatchesPrograms = (
  sample: SolanaBehaviorSample,
  programs: ReadonlyArray<string>
): boolean =>
  programs.length === 0 ||
  sample.invokedProgramIds.some((programId) => programs.includes(programId))

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
  Effect.gen(function* () {
    const samples: Array<SolanaBehaviorSample> = []
    const errors: Array<SolanaBehaviorSampleError> = []

    for (let slot = fromSlot; slot <= toSlot && samples.length < remaining; slot += 1) {
      const blockEither = yield* Effect.either(client.fetchFinalizedBlock({ slot }))

      if (Either.isLeft(blockEither)) {
        errors.push({
          scope: "slot",
          target: String(slot),
          message: blockEither.left.message,
        })
        continue
      }

      const transactionPayloadsEither = yield* Effect.either(blockTransactions(blockEither.right))

      if (Either.isLeft(transactionPayloadsEither)) {
        errors.push({
          scope: "slot",
          target: String(slot),
          message: transactionPayloadsEither.left.message,
        })
        continue
      }

      for (const transactionPayload of transactionPayloadsEither.right) {
        if (samples.length >= remaining) {
          break
        }

        const sampleEither = yield* Effect.either(
          extractSolanaBehaviorSample({ payload: transactionPayload, slot })
        )

        if (Either.isLeft(sampleEither)) {
          errors.push({
            scope: "payload",
            target: String(slot),
            message: sampleEither.left.message,
          })
          continue
        }

        if (sampleMatchesPrograms(sampleEither.right, programs)) {
          samples.push(sampleEither.right)
        }
      }
    }

    return { samples, errors }
  })

export const buildSolanaBehaviorSamplesArtifact = ({
  generatedAt,
  sampling,
}: {
  readonly generatedAt: string
  readonly sampling: SolanaBehaviorSamplingInput
}): Effect.Effect<SolanaBehaviorSamplesArtifact, never, SolanaBehaviorSamplerClient> =>
  Effect.gen(function* () {
    const client = yield* SolanaBehaviorSamplerClient
    const samples: Array<SolanaBehaviorSample> = []
    const errors: Array<SolanaBehaviorSampleError> = []

    for (const signature of sampling.signatures) {
      if (samples.length >= sampling.sampleLimit) {
        break
      }

      const payloadEither = yield* Effect.either(client.fetchTransactionBySignature({ signature }))

      if (Either.isLeft(payloadEither)) {
        errors.push({
          scope: "signature",
          target: signature,
          message: payloadEither.left.message,
        })
        continue
      }

      const sampleEither = yield* Effect.either(
        extractSolanaBehaviorSample({ payload: payloadEither.right, slot: null })
      )

      if (Either.isLeft(sampleEither)) {
        errors.push({
          scope: "payload",
          target: signature,
          message: sampleEither.left.message,
        })
        continue
      }

      samples.push(sampleEither.right)
    }

    const remaining = sampling.sampleLimit - samples.length
    if (sampling.slotRange !== null && remaining > 0) {
      const slotSamples = yield* sampleSignaturesFromSlots({
        client,
        fromSlot: sampling.slotRange.fromSlot,
        toSlot: sampling.slotRange.toSlot,
        programs: sampling.programs,
        remaining,
      })
      samples.push(...slotSamples.samples)
      errors.push(...slotSamples.errors)
    }

    return {
      schemaVersion: 1,
      chain: "solana",
      source: "helius-solana",
      generatedAt,
      sampling,
      samples,
      errors,
    }
  })

export const SolanaBehaviorSamplerClientTestLive = (
  client: SolanaBehaviorSamplerClientShape
): Layer.Layer<SolanaBehaviorSamplerClient> => Layer.succeed(SolanaBehaviorSamplerClient, client)
