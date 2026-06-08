/**
 * Solana Dune rankings file import helpers.
 *
 * @module SolanaDuneRankingsFile
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ProtocolCandidateRepository,
  type ProtocolCandidateObservationDraft,
  type ProtocolCandidateImportResult,
  type SyncEngineStorageError,
} from "../../../services/index.ts"

export const SolanaDunePeriodGranularity = Schema.Literal("year", "quarter")
export type SolanaDunePeriodGranularity = typeof SolanaDunePeriodGranularity.Type

export const SolanaDuneQueryConfig = Schema.Struct({
  queryId: Schema.Number,
  queryName: Schema.String,
  periodGranularity: SolanaDunePeriodGranularity,
  version: Schema.Number,
  kind: Schema.Literal(
    "dex-project-priority",
    "token-transfer-program-candidates",
    "program-sample-transactions"
  ),
})
export type SolanaDuneQueryConfig = typeof SolanaDuneQueryConfig.Type

export const SolanaDuneRankingEntry = Schema.Struct({
  programId: Schema.String,
  period: Schema.String,
  invocationCount: Schema.Number,
  uniqueSignerCount: Schema.NullOr(Schema.Number),
  transactionCount: Schema.NullOr(Schema.Number),
  sampleSignatures: Schema.Array(Schema.String),
  queryId: Schema.Number,
  queryName: Schema.String,
  periodGranularity: SolanaDunePeriodGranularity,
  queryVersion: Schema.Number,
  retrievedAt: Schema.String,
})
export type SolanaDuneRankingEntry = typeof SolanaDuneRankingEntry.Type

export const SolanaDuneRankingsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  onchainDataSource: Schema.Literal("dune"),
  generatedAt: Schema.String,
  window: Schema.Struct({
    fromYear: Schema.Number,
    toYear: Schema.Number,
  }),
  top: Schema.Number,
  executionWindowDays: Schema.Number,
  queries: Schema.Array(SolanaDuneQueryConfig),
  entries: Schema.Array(SolanaDuneRankingEntry),
})
export type SolanaDuneRankingsFile = typeof SolanaDuneRankingsFile.Type

export class SolanaDuneRankingsFileImportError extends Schema.TaggedError<SolanaDuneRankingsFileImportError>()(
  "SolanaDuneRankingsFileImportError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }
) {}

const operation = "solanaDuneRankingsFile.import"

const parseUtcDate = (
  value: string,
  field: string
): Effect.Effect<Date, SolanaDuneRankingsFileImportError> => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? Effect.fail(
        new SolanaDuneRankingsFileImportError({
          message: `Invalid ${field}: expected YYYY-MM-DD`,
        })
      )
    : Effect.succeed(date)
}

const parseRetrievedAt = (
  value: string
): Effect.Effect<Date, SolanaDuneRankingsFileImportError> => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? Effect.fail(
        new SolanaDuneRankingsFileImportError({
          message: "Invalid retrievedAt: expected ISO date string",
        })
      )
    : Effect.succeed(date)
}

const parseFilePeriod = (
  period: string
): Effect.Effect<
  { readonly observedWindowStart: Date; readonly observedWindowEnd: Date },
  SolanaDuneRankingsFileImportError
> => {
  const parts = period.split(" to ")
  const [start, end] = parts

  if (parts.length !== 2 || start === undefined || end === undefined) {
    return Effect.fail(
      new SolanaDuneRankingsFileImportError({
        message: "Invalid period: expected `YYYY-MM-DD to YYYY-MM-DD`",
      })
    )
  }

  return Effect.gen(function* () {
    const observedWindowStart = yield* parseUtcDate(start, "period start")
    const observedWindowEnd = yield* parseUtcDate(end, "period end")

    if (observedWindowStart >= observedWindowEnd) {
      return yield* Effect.fail(
        new SolanaDuneRankingsFileImportError({
          message: "Invalid period: start must be before end",
        })
      )
    }

    return { observedWindowStart, observedWindowEnd }
  })
}

const rawPayloadFromEntry = (entry: SolanaDuneRankingEntry): Record<string, unknown> => ({
  programId: entry.programId,
  period: entry.period,
  invocationCount: entry.invocationCount,
  uniqueSignerCount: entry.uniqueSignerCount,
  transactionCount: entry.transactionCount,
  sampleSignatures: [...entry.sampleSignatures],
  queryId: entry.queryId,
  queryName: entry.queryName,
  periodGranularity: entry.periodGranularity,
  queryVersion: entry.queryVersion,
  retrievedAt: entry.retrievedAt,
})

const observationFromEntry = ({
  blockchainName,
  entry,
}: {
  readonly blockchainName: string
  readonly entry: SolanaDuneRankingEntry
}): Effect.Effect<ProtocolCandidateObservationDraft, SolanaDuneRankingsFileImportError> =>
  Effect.gen(function* () {
    const { observedWindowStart, observedWindowEnd } = yield* parseFilePeriod(entry.period)
    const retrievedAt = yield* parseRetrievedAt(entry.retrievedAt)

    return {
      blockchainName,
      subjectKind: "program",
      subjectIdentifier: entry.programId,
      protocolNameHint: null,
      categoryHint: null,
      observedWindowStart,
      observedWindowEnd,
      interactionCount: entry.invocationCount,
      transactionCount: entry.transactionCount,
      uniqueActorCount: entry.uniqueSignerCount,
      sampleTransactionHashes: [...entry.sampleSignatures],
      retrievedAt,
      rawPayload: rawPayloadFromEntry(entry),
      sourceMetadata: {
        source: "dune",
        queryId: entry.queryId,
        queryName: entry.queryName,
        queryVersion: entry.queryVersion,
      },
    }
  })

export const duneObservationsFromSolanaDuneRankingsFile = ({
  rankingsFile,
  blockchainName,
}: {
  readonly rankingsFile: SolanaDuneRankingsFile
  readonly blockchainName: string
}): Effect.Effect<
  ReadonlyArray<ProtocolCandidateObservationDraft>,
  SolanaDuneRankingsFileImportError
> =>
  Effect.forEach(rankingsFile.entries, (entry) => observationFromEntry({ blockchainName, entry }))

export const decodeDuneObservationsFromSolanaDuneRankingsFile = ({
  file,
  blockchainName,
}: {
  readonly file: unknown
  readonly blockchainName: string
}): Effect.Effect<
  ReadonlyArray<ProtocolCandidateObservationDraft>,
  SolanaDuneRankingsFileImportError
> =>
  Schema.decodeUnknown(SolanaDuneRankingsFile)(file).pipe(
    Effect.mapError(
      (error) =>
        new SolanaDuneRankingsFileImportError({
          message: "Failed to decode Solana Dune rankings file",
          cause: error,
        })
    ),
    Effect.flatMap((decoded) =>
      duneObservationsFromSolanaDuneRankingsFile({ rankingsFile: decoded, blockchainName })
    )
  )

export const importSolanaDuneRankingsFile = ({
  file,
  blockchainName,
}: {
  readonly file: unknown
  readonly blockchainName: string
}): Effect.Effect<
  ProtocolCandidateImportResult,
  SolanaDuneRankingsFileImportError | SyncEngineStorageError,
  ProtocolCandidateRepository
> =>
  Effect.gen(function* () {
    const repository = yield* ProtocolCandidateRepository
    const observations = yield* decodeDuneObservationsFromSolanaDuneRankingsFile({
      file,
      blockchainName,
    })

    return yield* repository.importObservations({ observations })
  }).pipe(Effect.withSpan(operation))
