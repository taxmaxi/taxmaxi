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

export const SolanaDuneQueryConfig = Schema.Struct({
  queryId: Schema.Number,
  queryName: Schema.String,
  version: Schema.Number,
  kind: Schema.Literal("dex-project-priority", "dex-project-sample-transactions"),
})
export type SolanaDuneQueryConfig = typeof SolanaDuneQueryConfig.Type

export const SolanaDuneRankingEntry = Schema.Struct({
  /** Subject shape persisted into the protocol candidate review queue. */
  subjectKind: Schema.Literal("protocol"),
  /** Stable project/protocol identifier from Dune, for example `raydium`. */
  subjectIdentifier: Schema.String,
  /** Protocol/project name reported by the Dune query, for example `jupiter`. */
  protocolNameHint: Schema.NullOr(Schema.String),
  /** Tax-relevant category reported by the Dune query, for example `swap`. */
  categoryHint: Schema.NullOr(Schema.String),
  /** Canonical Solana program ids Dune attributed to the project in this window. */
  canonicalProgramIds: Schema.Array(Schema.String),
  /** Observed window formatted as `YYYY-MM-DD to YYYY-MM-DD`. */
  period: Schema.String,
  invocationCount: Schema.Number,
  uniqueSignerCount: Schema.NullOr(Schema.Number),
  transactionCount: Schema.NullOr(Schema.Number),
  /** Total traded USD volume in the observed window when the query reports it. */
  volumeUsd: Schema.NullOr(Schema.Number),
  sampleSignatures: Schema.Array(Schema.String),
  queryId: Schema.Number,
  queryName: Schema.String,
  queryVersion: Schema.Number,
  retrievedAt: Schema.String,
})
export type SolanaDuneRankingEntry = typeof SolanaDuneRankingEntry.Type

/**
 * SolanaDuneRecordedExecution - One raw Dune query execution captured during a crawl.
 *
 * Recorded executions make a rankings file replayable: the crawler can serve
 * them instead of calling Dune, so re-imports and re-processing with newer
 * mapping logic cost no Dune credits. Timed-out executions are recorded too so
 * a replay reproduces the same window-halving decisions.
 */
export const SolanaDuneRecordedExecution = Schema.Struct({
  queryId: Schema.Number,
  kind: Schema.Literal("dex-project-priority", "dex-project-sample-transactions"),
  parameters: Schema.Record({ key: Schema.String, value: Schema.String }),
  status: Schema.Literal("completed", "timed_out"),
  /** Raw Dune API response for completed executions, null for timed-out ones. */
  response: Schema.Unknown,
})
export type SolanaDuneRecordedExecution = typeof SolanaDuneRecordedExecution.Type

export const SolanaDuneRankingsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  onchainDataSource: Schema.Literal("dune"),
  generatedAt: Schema.String,
  /** Inclusive UTC start date of the crawled range, `YYYY-MM-DD`. */
  startDate: Schema.String,
  /** Exclusive UTC end date of the crawled range, `YYYY-MM-DD`. */
  endDate: Schema.String,
  /** Crawl tuning used to produce this file; replays reuse it for identical windowing. */
  parameters: Schema.Struct({
    samplesPerProject: Schema.Number,
    windowDays: Schema.Number,
  }),
  queries: Schema.Array(SolanaDuneQueryConfig),
  entries: Schema.Array(SolanaDuneRankingEntry),
  /** Raw Dune executions captured during the crawl, replayable without credits. */
  executions: Schema.Array(SolanaDuneRecordedExecution),
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
  subjectKind: entry.subjectKind,
  subjectIdentifier: entry.subjectIdentifier,
  protocolNameHint: entry.protocolNameHint,
  categoryHint: entry.categoryHint,
  canonicalProgramIds: [...entry.canonicalProgramIds],
  period: entry.period,
  invocationCount: entry.invocationCount,
  uniqueSignerCount: entry.uniqueSignerCount,
  transactionCount: entry.transactionCount,
  volumeUsd: entry.volumeUsd,
  sampleSignatures: [...entry.sampleSignatures],
  queryId: entry.queryId,
  queryName: entry.queryName,
  queryVersion: entry.queryVersion,
  retrievedAt: entry.retrievedAt,
})

const duneSourceObservationKey = ({
  entry,
  observedWindowStart,
  observedWindowEnd,
}: {
  readonly entry: SolanaDuneRankingEntry
  readonly observedWindowStart: Date
  readonly observedWindowEnd: Date
}): string =>
  [
    entry.queryId,
    entry.queryVersion,
    entry.subjectKind,
    entry.subjectIdentifier,
    observedWindowStart.toISOString(),
    observedWindowEnd.toISOString(),
  ].join(":")

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
      subjectKind: entry.subjectKind,
      subjectIdentifier: entry.subjectIdentifier,
      protocolNameHint: entry.protocolNameHint,
      categoryHint: entry.categoryHint,
      sourceObservationKey: duneSourceObservationKey({
        entry,
        observedWindowStart,
        observedWindowEnd,
      }),
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
