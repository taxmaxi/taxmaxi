/**
 * Dune-backed historical Solana program ranking adapter.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME = "solana-dune-program-rankings.json"

const NumericField = Schema.Union(Schema.Number, Schema.NumberFromString)
const NullableStringArray = Schema.NullOr(Schema.Array(Schema.String))

const DuneExecutionResultResponse = Schema.Struct({
  state: Schema.String,
  result: Schema.Struct({
    rows: Schema.Array(Schema.Unknown),
  }),
})

const DuneDexProjectPriorityRow = Schema.Struct({
  project: Schema.String,
  period: Schema.String,
  retrieved_at: Schema.String,
  approx_unique_traders: NumericField,
  approx_trade_transactions: NumericField,
  trade_rows: NumericField,
  canonical_program_ids: NullableStringArray,
})

const DuneTokenTransferProgramCandidateRow = Schema.Struct({
  program_id: Schema.String,
  period: Schema.String,
  retrieved_at: Schema.String,
  approx_signers: NumericField,
  approx_transfer_transactions: NumericField,
  transfer_rows: NumericField,
})

const DuneProgramSampleTransactionRow = Schema.Struct({
  tx_id: Schema.String,
})

const DUNE_QUERY_VERSION = 1
const DUNE_SAMPLE_QUERY_VERSION = 1

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

const SOLANA_DUNE_PROGRAM_RANKING_QUERY_TEMPLATES: ReadonlyArray<
  Omit<SolanaDuneQueryConfig, "periodGranularity">
> = [
  {
    queryId: 7_647_495,
    queryName: "solana-dex-project-priority",
    version: DUNE_QUERY_VERSION,
    kind: "dex-project-priority",
  },
  {
    queryId: 7_648_079,
    queryName: "solana-token-transfer-program-candidates",
    version: DUNE_QUERY_VERSION,
    kind: "token-transfer-program-candidates",
  },
]

export const SOLANA_DUNE_PROGRAM_SAMPLE_QUERY = {
  queryId: 7_648_230,
  queryName: "solana-program-sample-transactions",
  periodGranularity: "year",
  version: DUNE_SAMPLE_QUERY_VERSION,
  kind: "program-sample-transactions",
} satisfies SolanaDuneQueryConfig

export const solanaDuneProgramRankingQueriesForPeriod = (
  periodGranularity: SolanaDunePeriodGranularity
): ReadonlyArray<SolanaDuneQueryConfig> =>
  SOLANA_DUNE_PROGRAM_RANKING_QUERY_TEMPLATES.map((query) => ({
    ...query,
    periodGranularity,
  }))

export const SOLANA_DUNE_PROGRAM_RANKING_QUERIES = solanaDuneProgramRankingQueriesForPeriod("year")

export const SolanaDuneProgramRankingRecord = Schema.Struct({
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
export type SolanaDuneProgramRankingRecord = typeof SolanaDuneProgramRankingRecord.Type

export const SolanaDuneProgramRankingsArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  source: Schema.Literal("dune"),
  generatedAt: Schema.String,
  window: Schema.Struct({
    fromYear: Schema.Number,
    toYear: Schema.Number,
  }),
  top: Schema.Number,
  queries: Schema.Array(SolanaDuneQueryConfig),
  entries: Schema.Array(SolanaDuneProgramRankingRecord),
})
export type SolanaDuneProgramRankingsArtifact = typeof SolanaDuneProgramRankingsArtifact.Type

export class SolanaDuneProgramRankingError extends Schema.TaggedError<SolanaDuneProgramRankingError>()(
  "SolanaDuneProgramRankingError",
  {
    message: Schema.String,
    queryId: Schema.optional(Schema.Number),
  }
) {}

type SolanaDuneRankingPeriod = {
  readonly label: string
  readonly startDate: string
  readonly endDate: string
}

type SolanaDuneProgramRankingRecordWithSampleWindow = SolanaDuneProgramRankingRecord & {
  readonly sampleWindow: {
    readonly startDate: string
    readonly endDate: string
  }
}

export interface ExecuteSolanaDuneQueryParams {
  readonly query: SolanaDuneQueryConfig
  readonly parameters: Readonly<Record<string, string>>
}

export interface SolanaDuneProgramRankingClientShape {
  readonly executeQuery: (
    params: ExecuteSolanaDuneQueryParams
  ) => Effect.Effect<unknown, SolanaDuneProgramRankingError>
}

export class SolanaDuneProgramRankingClient extends Context.Tag("SolanaDuneProgramRankingClient")<
  SolanaDuneProgramRankingClient,
  SolanaDuneProgramRankingClientShape
>() {}

const queryError = ({
  query,
  message,
}: {
  readonly query: SolanaDuneQueryConfig
  readonly message: string
}): SolanaDuneProgramRankingError =>
  new SolanaDuneProgramRankingError({ queryId: query.queryId, message })

const safeInteger = ({
  value,
  query,
  field,
}: {
  readonly value: number
  readonly query: SolanaDuneQueryConfig
  readonly field: string
}): Effect.Effect<number, SolanaDuneProgramRankingError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(queryError({ query, message: `Dune row has invalid ${field}: ${value}` }))

const decodeRows = <A, I>(
  schema: Schema.Schema<A, I>,
  rows: ReadonlyArray<unknown>,
  query: SolanaDuneQueryConfig
): Effect.Effect<ReadonlyArray<A>, SolanaDuneProgramRankingError> =>
  Schema.decodeUnknown(Schema.Array(schema))(rows).pipe(
    Effect.mapError((error) =>
      queryError({
        query,
        message: `Failed to decode Dune rows for ${query.queryName}: ${error.message}`,
      })
    )
  )

const nonEmptyRows = (
  rows: ReadonlyArray<unknown>,
  query: SolanaDuneQueryConfig
): Effect.Effect<ReadonlyArray<unknown>, SolanaDuneProgramRankingError> =>
  rows.length === 0
    ? Effect.fail(queryError({ query, message: `Dune query ${query.queryName} returned no rows` }))
    : Effect.succeed(rows)

const yearPeriods = ({
  fromYear,
  toYear,
}: {
  readonly fromYear: number
  readonly toYear: number
}): ReadonlyArray<SolanaDuneRankingPeriod> =>
  Array.from({ length: toYear - fromYear + 1 }, (_value, index) => {
    const year = fromYear + index
    return {
      label: String(year),
      startDate: `${year}-01-01`,
      endDate: `${year + 1}-01-01`,
    }
  })

const quarterPeriods = ({
  fromYear,
  toYear,
}: {
  readonly fromYear: number
  readonly toYear: number
}): ReadonlyArray<SolanaDuneRankingPeriod> =>
  Array.from({ length: (toYear - fromYear + 1) * 4 }, (_value, index) => {
    const year = fromYear + Math.floor(index / 4)
    const quarterIndex = index % 4
    const startMonth = quarterIndex * 3 + 1
    const endMonth = quarterIndex === 3 ? 1 : startMonth + 3
    const endYear = quarterIndex === 3 ? year + 1 : year

    return {
      label: `${year}-Q${quarterIndex + 1}`,
      startDate: `${year}-${String(startMonth).padStart(2, "0")}-01`,
      endDate: `${endYear}-${String(endMonth).padStart(2, "0")}-01`,
    }
  })

const periodsForGranularity = ({
  fromYear,
  periodGranularity,
  toYear,
}: {
  readonly fromYear: number
  readonly periodGranularity: SolanaDunePeriodGranularity
  readonly toYear: number
}): ReadonlyArray<SolanaDuneRankingPeriod> =>
  periodGranularity === "year"
    ? yearPeriods({ fromYear, toYear })
    : quarterPeriods({ fromYear, toYear })

const resultRows = (
  response: unknown,
  query: SolanaDuneQueryConfig,
  options?: {
    readonly requireRows?: boolean
  }
): Effect.Effect<ReadonlyArray<unknown>, SolanaDuneProgramRankingError> =>
  Schema.decodeUnknown(DuneExecutionResultResponse)(response).pipe(
    Effect.mapError((error) =>
      queryError({
        query,
        message: `Failed to decode Dune execution response for ${query.queryName}: ${error.message}`,
      })
    ),
    Effect.flatMap((decoded) =>
      decoded.state === "QUERY_STATE_COMPLETED"
        ? options?.requireRows === false
          ? Effect.succeed(decoded.result.rows)
          : nonEmptyRows(decoded.result.rows, query)
        : Effect.fail(
            queryError({
              query,
              message: `Dune query ${query.queryName} finished with state ${decoded.state}`,
            })
          )
    )
  )

const mapDexProjectRows = ({
  period,
  query,
  rows,
}: {
  readonly period: SolanaDuneRankingPeriod
  readonly query: SolanaDuneQueryConfig
  readonly rows: ReadonlyArray<typeof DuneDexProjectPriorityRow.Type>
}): Effect.Effect<
  ReadonlyArray<SolanaDuneProgramRankingRecordWithSampleWindow>,
  SolanaDuneProgramRankingError
> =>
  Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const invocationCount = yield* safeInteger({
        value: row.trade_rows,
        query,
        field: "trade_rows",
      })
      const transactionCount = yield* safeInteger({
        value: row.approx_trade_transactions,
        query,
        field: "approx_trade_transactions",
      })
      const uniqueSignerCount = yield* safeInteger({
        value: row.approx_unique_traders,
        query,
        field: "approx_unique_traders",
      })
      const programIds = row.canonical_program_ids ?? []

      return programIds.map(
        (programId): SolanaDuneProgramRankingRecordWithSampleWindow => ({
          programId,
          period: row.period,
          invocationCount,
          uniqueSignerCount,
          transactionCount,
          sampleSignatures: [],
          queryId: query.queryId,
          queryName: query.queryName,
          periodGranularity: query.periodGranularity,
          queryVersion: query.version,
          retrievedAt: row.retrieved_at,
          sampleWindow: {
            startDate: period.startDate,
            endDate: period.endDate,
          },
        })
      )
    })
  ).pipe(Effect.map((records) => records.flat()))

const mapTokenTransferRows = ({
  period,
  query,
  rows,
}: {
  readonly period: SolanaDuneRankingPeriod
  readonly query: SolanaDuneQueryConfig
  readonly rows: ReadonlyArray<typeof DuneTokenTransferProgramCandidateRow.Type>
}): Effect.Effect<
  ReadonlyArray<SolanaDuneProgramRankingRecordWithSampleWindow>,
  SolanaDuneProgramRankingError
> =>
  Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const invocationCount = yield* safeInteger({
        value: row.transfer_rows,
        query,
        field: "transfer_rows",
      })
      const transactionCount = yield* safeInteger({
        value: row.approx_transfer_transactions,
        query,
        field: "approx_transfer_transactions",
      })
      const uniqueSignerCount = yield* safeInteger({
        value: row.approx_signers,
        query,
        field: "approx_signers",
      })

      return {
        programId: row.program_id,
        period: row.period,
        invocationCount,
        uniqueSignerCount,
        transactionCount,
        sampleSignatures: [],
        queryId: query.queryId,
        queryName: query.queryName,
        periodGranularity: query.periodGranularity,
        queryVersion: query.version,
        retrievedAt: row.retrieved_at,
        sampleWindow: {
          startDate: period.startDate,
          endDate: period.endDate,
        },
      } satisfies SolanaDuneProgramRankingRecordWithSampleWindow
    })
  )

const recordsFromQueryResponse = ({
  period,
  query,
  response,
}: {
  readonly period: SolanaDuneRankingPeriod
  readonly query: SolanaDuneQueryConfig
  readonly response: unknown
}): Effect.Effect<
  ReadonlyArray<SolanaDuneProgramRankingRecordWithSampleWindow>,
  SolanaDuneProgramRankingError
> =>
  Effect.gen(function* () {
    const rows = yield* resultRows(response, query)

    switch (query.kind) {
      case "dex-project-priority": {
        const decodedRows = yield* decodeRows(DuneDexProjectPriorityRow, rows, query)
        return yield* mapDexProjectRows({ period, query, rows: decodedRows })
      }
      case "token-transfer-program-candidates": {
        const decodedRows = yield* decodeRows(DuneTokenTransferProgramCandidateRow, rows, query)
        return yield* mapTokenTransferRows({ period, query, rows: decodedRows })
      }
      case "program-sample-transactions": {
        return yield* Effect.fail(
          queryError({
            query,
            message: "Sample transaction query cannot produce ranking records",
          })
        )
      }
    }
  })

const sampleQueryForPeriod = (
  periodGranularity: SolanaDunePeriodGranularity
): SolanaDuneQueryConfig => ({
  ...SOLANA_DUNE_PROGRAM_SAMPLE_QUERY,
  periodGranularity,
})

const sampleSignaturesFromQueryResponse = ({
  query,
  response,
}: {
  readonly query: SolanaDuneQueryConfig
  readonly response: unknown
}): Effect.Effect<ReadonlyArray<string>, SolanaDuneProgramRankingError> =>
  Effect.gen(function* () {
    const rows = yield* resultRows(response, query, { requireRows: false })
    const decodedRows = yield* decodeRows(DuneProgramSampleTransactionRow, rows, query)
    return decodedRows.map((row) => row.tx_id)
  })

const populateSampleSignatures = ({
  entries,
  periodGranularity,
}: {
  readonly entries: ReadonlyArray<SolanaDuneProgramRankingRecordWithSampleWindow>
  readonly periodGranularity: SolanaDunePeriodGranularity
}): Effect.Effect<
  ReadonlyArray<SolanaDuneProgramRankingRecord>,
  SolanaDuneProgramRankingError,
  SolanaDuneProgramRankingClient
> =>
  Effect.gen(function* () {
    const client = yield* SolanaDuneProgramRankingClient
    const query = sampleQueryForPeriod(periodGranularity)

    return yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const response = yield* client.executeQuery({
          query,
          parameters: {
            program_id: entry.programId,
            start_date: entry.sampleWindow.startDate,
            end_date: entry.sampleWindow.endDate,
          },
        })
        const sampleSignatures = yield* sampleSignaturesFromQueryResponse({ query, response })

        return {
          programId: entry.programId,
          period: entry.period,
          invocationCount: entry.invocationCount,
          uniqueSignerCount: entry.uniqueSignerCount,
          transactionCount: entry.transactionCount,
          sampleSignatures: [...sampleSignatures],
          queryId: entry.queryId,
          queryName: entry.queryName,
          periodGranularity: entry.periodGranularity,
          queryVersion: entry.queryVersion,
          retrievedAt: entry.retrievedAt,
        }
      })
    )
  })

export const buildSolanaDuneProgramRankingsArtifact = ({
  generatedAt,
  fromYear,
  periodGranularity = "year",
  toYear,
  top,
}: {
  readonly generatedAt: string
  readonly fromYear: number
  readonly periodGranularity?: SolanaDunePeriodGranularity
  readonly toYear: number
  readonly top: number
}): Effect.Effect<
  SolanaDuneProgramRankingsArtifact,
  SolanaDuneProgramRankingError,
  SolanaDuneProgramRankingClient
> =>
  Effect.gen(function* () {
    const client = yield* SolanaDuneProgramRankingClient
    const periods = periodsForGranularity({ fromYear, periodGranularity, toYear })
    const queries = solanaDuneProgramRankingQueriesForPeriod(periodGranularity)
    const queryPeriods = queries.flatMap((query) => periods.map((period) => ({ query, period })))
    const entries = yield* Effect.forEach(queryPeriods, ({ query, period }) =>
      Effect.gen(function* () {
        const response = yield* client.executeQuery({
          query,
          parameters: {
            start_date: period.startDate,
            end_date: period.endDate,
          },
        })
        return yield* recordsFromQueryResponse({ period, query, response })
      })
    ).pipe(Effect.map((records) => records.flat()))

    const topEntries = [...entries]
      .sort((left, right) => {
        const countDelta = right.invocationCount - left.invocationCount
        return countDelta === 0 ? left.programId.localeCompare(right.programId) : countDelta
      })
      .slice(0, top)
    const entriesWithSamples = yield* populateSampleSignatures({
      entries: topEntries,
      periodGranularity,
    })

    return {
      schemaVersion: 1,
      chain: "solana",
      source: "dune",
      generatedAt,
      window: { fromYear, toYear },
      top,
      queries: [...queries, sampleQueryForPeriod(periodGranularity)],
      entries: entriesWithSamples,
    }
  })

/** Test layer for injecting deterministic Dune query responses. */
export const SolanaDuneProgramRankingClientTestLive = (
  client: SolanaDuneProgramRankingClientShape
): Layer.Layer<SolanaDuneProgramRankingClient> =>
  Layer.succeed(SolanaDuneProgramRankingClient, client)
