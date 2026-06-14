/**
 * Dune-backed Solana DEX project discovery for the protocol candidate review queue.
 *
 * Uses only the curated `dex_solana.trades` Spellbook queries:
 *
 * - `solana-dex-project-priority` ranks DEX projects per date window.
 * - `solana-dex-project-sample-transactions` samples diversified swap transactions per project.
 *
 * Date ranges are split into windows and each window that hits the Dune
 * execution timeout is halved and retried, so high-volume periods crawl with
 * smaller windows automatically. Every ranked project with canonical program
 * ids becomes one candidate entry with the program ids retained as review
 * evidence. Each project is sampled once per invocation from a one-day slice
 * to keep Dune credit usage low.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import {
  SolanaDuneQueryConfig,
  SolanaDuneRankingEntry,
  SolanaDuneRankingsFile,
  SolanaDuneRecordedExecution,
} from "@my/sync-engine/providers/helius-solana"
import { SolanaDuneClient, SolanaDuneError } from "./solana-dune-client.ts"

/**
 * Rankings file name for one crawled date range. The range is part of the
 * name so runs for different ranges never overwrite each other's raw data.
 */
export const solanaDuneDexProjectRankingsFileName = ({
  startDate,
  endDate,
}: {
  readonly startDate: string
  readonly endDate: string
}): string => `solana-dune-dex-project-rankings-${startDate}-to-${endDate}.json`

export const DEFAULT_SOLANA_DEX_DISCOVERY_WINDOW_DAYS = 7

const NumericField = Schema.Union(Schema.Number, Schema.NumberFromString)

const DuneExecutionResultResponse = Schema.Struct({
  state: Schema.String,
  result: Schema.Struct({
    rows: Schema.Array(Schema.Unknown),
  }),
})

const DexProjectPriorityRow = Schema.Struct({
  project: Schema.String,
  tax_category: Schema.String,
  period: Schema.String,
  retrieved_at: Schema.String,
  approx_unique_traders: NumericField,
  approx_trade_transactions: NumericField,
  trade_rows: NumericField,
  canonical_program_ids: Schema.NullOr(Schema.Array(Schema.String)),
  canonical_program_id_count: NumericField,
  volume_usd: NumericField,
})

const DexProjectSampleTransactionRow = Schema.Struct({
  tx_id: Schema.String,
})

export const SOLANA_DEX_PROJECT_PRIORITY_QUERY = {
  queryId: 7_647_495,
  queryName: "solana-dex-project-priority",
  version: 1,
  kind: "dex-project-priority",
} satisfies SolanaDuneQueryConfig

export const SOLANA_DEX_PROJECT_SAMPLE_TRANSACTIONS_QUERY = {
  queryId: 7_648_044,
  queryName: "solana-dex-project-sample-transactions",
  version: 1,
  kind: "dex-project-sample-transactions",
} satisfies SolanaDuneQueryConfig

export interface BuildSolanaDexDiscoveryFileParams {
  readonly generatedAt: string
  /** Inclusive UTC start date, `YYYY-MM-DD`. */
  readonly startDate: string
  /** Exclusive UTC end date, `YYYY-MM-DD`. */
  readonly endDate: string
  /** Maximum number of ranked DEX projects to keep per window. */
  readonly topProjects: number
  /** Maximum sample transaction signatures per project. Each project is sampled once. */
  readonly samplesPerProject: number
  /** Maximum days per Dune execution window. Timed-out windows are halved automatically. */
  readonly windowDays?: number
}

type DateWindow = {
  readonly startDate: string
  readonly endDate: string
}

const queryError = ({
  query,
  message,
}: {
  readonly query: SolanaDuneQueryConfig
  readonly message: string
}): SolanaDuneError => new SolanaDuneError({ queryId: query.queryId, message })

const decodeRows = <A, I>(
  schema: Schema.Schema<A, I>,
  rows: ReadonlyArray<unknown>,
  query: SolanaDuneQueryConfig
): Effect.Effect<ReadonlyArray<A>, SolanaDuneError> =>
  Schema.decodeUnknown(Schema.Array(schema))(rows).pipe(
    Effect.mapError((error) =>
      queryError({
        query,
        message: `Failed to decode Dune rows for ${query.queryName}: ${error.message}`,
      })
    )
  )

const resultRows = (
  response: unknown,
  query: SolanaDuneQueryConfig
): Effect.Effect<ReadonlyArray<unknown>, SolanaDuneError> =>
  Schema.decodeUnknown(DuneExecutionResultResponse)(response).pipe(
    Effect.mapError((error) =>
      queryError({
        query,
        message: `Failed to decode Dune execution response for ${query.queryName}: ${error.message}`,
      })
    ),
    Effect.flatMap((decoded) =>
      decoded.state === "QUERY_STATE_COMPLETED"
        ? Effect.succeed(decoded.result.rows)
        : Effect.fail(
            queryError({
              query,
              message: `Dune query ${query.queryName} finished with state ${decoded.state}`,
            })
          )
    )
  )

const safeCount = ({
  value,
  query,
  field,
}: {
  readonly value: number
  readonly query: SolanaDuneQueryConfig
  readonly field: string
}): Effect.Effect<number, SolanaDuneError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(queryError({ query, message: `Dune row has invalid ${field}: ${value}` }))

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const invalidUtcDate = (field: string): SolanaDuneError =>
  new SolanaDuneError({
    message: `\`${field}\` must be a UTC date formatted as YYYY-MM-DD`,
  })

const decodeUtcDate = (
  value: string,
  field: string
): Effect.Effect<DateTime.Utc, SolanaDuneError> =>
  Schema.decodeUnknown(Schema.DateTimeUtc)(`${value}T00:00:00.000Z`).pipe(
    Effect.mapError(() => invalidUtcDate(field))
  )

const validateUtcDate = (value: string, field: string): Effect.Effect<string, SolanaDuneError> =>
  decodeUtcDate(value, field).pipe(
    Effect.filterOrFail(
      (dateTime) => UTC_DATE_PATTERN.test(value) && DateTime.formatIsoDateUtc(dateTime) === value,
      () => invalidUtcDate(field)
    ),
    Effect.as(value)
  )

const validateDateRange = ({
  startDate,
  endDate,
}: DateWindow): Effect.Effect<void, SolanaDuneError> =>
  Effect.gen(function* () {
    yield* validateUtcDate(startDate, "startDate")
    yield* validateUtcDate(endDate, "endDate")
    if (startDate >= endDate) {
      return yield* Effect.fail(
        new SolanaDuneError({
          message: "`startDate` must be before `endDate`",
        })
      )
    }
  })

const addUtcDays = (date: string, days: number): Effect.Effect<string, SolanaDuneError> =>
  decodeUtcDate(date, "date").pipe(
    Effect.map(DateTime.add({ days })),
    Effect.map(DateTime.formatIsoDateUtc)
  )

const windowDayCount = ({
  startDate,
  endDate,
}: DateWindow): Effect.Effect<number, SolanaDuneError> => {
  const millisPerDay = 24 * 60 * 60 * 1000
  return Effect.gen(function* () {
    const start = yield* decodeUtcDate(startDate, "startDate")
    const end = yield* decodeUtcDate(endDate, "endDate")
    return Math.round(DateTime.distance(start, end) / millisPerDay)
  })
}

const splitIntoWindows = ({
  startDate,
  endDate,
  windowDays,
}: DateWindow & {
  readonly windowDays: number
}): Effect.Effect<ReadonlyArray<DateWindow>, SolanaDuneError> =>
  Effect.gen(function* () {
    const windows: Array<DateWindow> = []
    let windowStart = startDate

    while (windowStart < endDate) {
      const windowEnd = yield* addUtcDays(windowStart, windowDays)
      windows.push({
        startDate: windowStart,
        endDate: windowEnd < endDate ? windowEnd : endDate,
      })
      windowStart = windowEnd
    }

    return windows
  })

const isDuneExecutionTimeout = (error: SolanaDuneError): boolean =>
  error.message.includes("EXECUTION_TIMEOUT")

type PriorityWindowResult = {
  readonly window: DateWindow
  readonly rows: ReadonlyArray<typeof DexProjectPriorityRow.Type>
}

type ExecutionRecorder = Array<SolanaDuneRecordedExecution>

const canonicalProgramIdsFromPriorityRow = (
  row: typeof DexProjectPriorityRow.Type
): Effect.Effect<ReadonlyArray<string>, SolanaDuneError> =>
  Effect.gen(function* () {
    const query = SOLANA_DEX_PROJECT_PRIORITY_QUERY
    const rawProgramIds = row.canonical_program_ids ?? []
    const canonicalProgramIdCount = yield* safeCount({
      value: row.canonical_program_id_count,
      query,
      field: "canonical_program_id_count",
    })

    if (rawProgramIds.length < canonicalProgramIdCount) {
      return yield* Effect.fail(
        queryError({
          query,
          message: `Dune row for project ${row.project} has ${rawProgramIds.length} canonical_program_ids but canonical_program_id_count is ${canonicalProgramIdCount}`,
        })
      )
    }

    return [...new Set(rawProgramIds.filter((programId) => programId.trim() !== ""))]
  })

/**
 * Execute the priority query for one window, halving the window on Dune
 * execution timeouts until it fits or a one-day window still times out.
 * Every execution, including timed-out ones, is recorded for replay.
 */
const priorityRowsForWindow = (
  window: DateWindow,
  recorder: ExecutionRecorder
): Effect.Effect<ReadonlyArray<PriorityWindowResult>, SolanaDuneError, SolanaDuneClient> =>
  Effect.gen(function* () {
    const client = yield* SolanaDuneClient
    const query = SOLANA_DEX_PROJECT_PRIORITY_QUERY
    const dayCount = yield* windowDayCount(window)
    const parameters = {
      start_date: window.startDate,
      end_date: window.endDate,
    }
    const execution = client.executeQuery({ query, parameters }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          recorder.push({
            queryId: query.queryId,
            kind: query.kind,
            parameters,
            status: "completed",
            response,
          })
        })
      ),
      Effect.flatMap((response) => resultRows(response, query)),
      Effect.flatMap((rows) => decodeRows(DexProjectPriorityRow, rows, query)),
      Effect.map((rows) => [{ window, rows }])
    )

    return yield* execution.pipe(
      Effect.catchIf(
        (error) => isDuneExecutionTimeout(error) && dayCount > 1,
        () =>
          Effect.gen(function* () {
            recorder.push({
              queryId: query.queryId,
              kind: query.kind,
              parameters,
              status: "timed_out",
              response: null,
            })
            const halfDays = Math.ceil(dayCount / 2)
            const midDate = yield* addUtcDays(window.startDate, halfDays)
            yield* Effect.logInfo(
              { startDate: window.startDate, endDate: window.endDate, midDate },
              "Dune priority query timed out; halving window"
            )
            const firstHalf = yield* priorityRowsForWindow(
              {
                startDate: window.startDate,
                endDate: midDate,
              },
              recorder
            )
            const secondHalf = yield* priorityRowsForWindow(
              {
                startDate: midDate,
                endDate: window.endDate,
              },
              recorder
            )
            return [...firstHalf, ...secondHalf]
          })
      )
    )
  })

const sampleSignaturesForProject = ({
  project,
  sampleDate,
  samplesPerProject,
  recorder,
}: {
  readonly project: string
  readonly sampleDate: string
  readonly samplesPerProject: number
  readonly recorder: ExecutionRecorder
}): Effect.Effect<ReadonlyArray<string>, SolanaDuneError, SolanaDuneClient> =>
  Effect.gen(function* () {
    const client = yield* SolanaDuneClient
    const query = SOLANA_DEX_PROJECT_SAMPLE_TRANSACTIONS_QUERY
    const endDate = yield* addUtcDays(sampleDate, 1)
    const parameters = {
      project,
      start_date: sampleDate,
      end_date: endDate,
    }
    const response = yield* client.executeQuery({ query, parameters })
    recorder.push({
      queryId: query.queryId,
      kind: query.kind,
      parameters,
      status: "completed",
      response,
    })
    const rows = yield* resultRows(response, query)
    const decodedRows = yield* decodeRows(DexProjectSampleTransactionRow, rows, query)

    return [...new Set(decodedRows.map((row) => row.tx_id))].slice(0, samplesPerProject)
  })

const entriesFromPriorityRow = ({
  row,
  canonicalProgramIds,
  period,
  sampleSignatures,
}: {
  readonly row: typeof DexProjectPriorityRow.Type
  readonly canonicalProgramIds: ReadonlyArray<string>
  readonly period: string
  readonly sampleSignatures: ReadonlyArray<string>
}): Effect.Effect<SolanaDuneRankingEntry, SolanaDuneError> =>
  Effect.gen(function* () {
    const query = SOLANA_DEX_PROJECT_PRIORITY_QUERY
    const invocationCount = yield* safeCount({
      value: row.trade_rows,
      query,
      field: "trade_rows",
    })
    const transactionCount = yield* safeCount({
      value: row.approx_trade_transactions,
      query,
      field: "approx_trade_transactions",
    })
    const uniqueSignerCount = yield* safeCount({
      value: row.approx_unique_traders,
      query,
      field: "approx_unique_traders",
    })

    return {
      subjectKind: "protocol",
      subjectIdentifier: row.project,
      protocolNameHint: row.project,
      categoryHint: row.tax_category,
      canonicalProgramIds: [...canonicalProgramIds],
      period,
      invocationCount,
      uniqueSignerCount,
      transactionCount,
      volumeUsd: row.volume_usd,
      sampleSignatures,
      queryId: query.queryId,
      queryName: query.queryName,
      queryVersion: query.version,
      retrievedAt: row.retrieved_at,
    }
  })

/**
 * Build a Solana Dune rankings file from the curated DEX project queries.
 *
 * One entry is emitted per ranked project and window, with canonical program ids
 * retained as evidence so project-level Dune metrics are not overstated as
 * per-program measurements.
 */
export const buildSolanaDexDiscoveryFile = ({
  generatedAt,
  startDate,
  endDate,
  topProjects,
  samplesPerProject,
  windowDays = DEFAULT_SOLANA_DEX_DISCOVERY_WINDOW_DAYS,
}: BuildSolanaDexDiscoveryFileParams): Effect.Effect<
  SolanaDuneRankingsFile,
  SolanaDuneError,
  SolanaDuneClient
> =>
  Effect.gen(function* () {
    yield* validateDateRange({ startDate, endDate })
    if (!Number.isSafeInteger(windowDays) || windowDays <= 0) {
      return yield* Effect.fail(
        new SolanaDuneError({ message: "`windowDays` must be a positive safe integer" })
      )
    }

    const windows = yield* splitIntoWindows({ startDate, endDate, windowDays })
    const sampledProjects = new Map<string, ReadonlyArray<string>>()
    const entries: Array<SolanaDuneRankingEntry> = []
    const executions: ExecutionRecorder = []

    for (const window of windows) {
      const windowResults = yield* priorityRowsForWindow(window, executions)

      for (const { window: executedWindow, rows } of windowResults) {
        const topRows = rows.slice(0, topProjects)
        const period = `${executedWindow.startDate} to ${executedWindow.endDate}`

        for (const row of topRows) {
          const canonicalProgramIds = yield* canonicalProgramIdsFromPriorityRow(row)
          if (canonicalProgramIds.length === 0) {
            continue
          }

          let sampleSignatures: ReadonlyArray<string> = []
          if (samplesPerProject > 0 && !sampledProjects.has(row.project)) {
            sampleSignatures = yield* sampleSignaturesForProject({
              project: row.project,
              sampleDate: executedWindow.startDate,
              samplesPerProject,
              recorder: executions,
            })
            if (sampleSignatures.length > 0) {
              sampledProjects.set(row.project, sampleSignatures)
            }
          }

          entries.push(
            yield* entriesFromPriorityRow({
              row,
              canonicalProgramIds,
              period,
              sampleSignatures,
            })
          )
        }
      }
    }

    if (entries.length === 0) {
      return yield* Effect.fail(
        new SolanaDuneError({
          message: `Dune DEX discovery for ${startDate} to ${endDate} produced no candidate entries`,
        })
      )
    }

    return {
      schemaVersion: 1,
      chain: "solana",
      onchainDataSource: "dune",
      generatedAt,
      startDate,
      endDate,
      parameters: {
        topProjects,
        samplesPerProject,
        windowDays,
      },
      queries: [SOLANA_DEX_PROJECT_PRIORITY_QUERY, SOLANA_DEX_PROJECT_SAMPLE_TRANSACTIONS_QUERY],
      entries,
      executions,
    }
  })
