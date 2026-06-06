import { Command, Options } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Schema } from "effect"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
import { CrawlerCommandError } from "./errors.ts"
import {
  buildSolanaBehaviorSamplesArtifact,
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplesArtifact,
  type SolanaBehaviorSamplingInput,
} from "./solana-behavior-sampler.ts"
import {
  buildSolanaDuneRankingsFile,
  DEFAULT_SOLANA_DUNE_EXECUTION_WINDOW_DAYS,
  SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME,
  SolanaDuneProgramRankingClient,
  SolanaDuneRankingsFile,
  type SolanaDunePeriodGranularity,
} from "./solana-dune-program-ranking.ts"

export { SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME } from "./solana-dune-program-ranking.ts"

export const SOLANA_PRIORITY_MAP_FILE_NAME = "solana-priority-map.json"
export const SOLANA_PRIORITY_REPORT_FILE_NAME = "solana-priority-report.md"
export const SOLANA_BEHAVIOR_SAMPLES_FILE_NAME = "solana-behavior-samples.json"
export const DEFAULT_SOLANA_REFERENCE_DATA_DIR =
  "packages/sync-engine/src/providers/helius-solana/reference-data"

const SOLANA_REFERENCE_DATA_DIR_ENV_VAR = "CRAWLER_SOLANA_REFERENCE_DATA_DIR"

export const SolanaPriorityMapArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  source: Schema.Literal("mock", "dune"),
  generatedAt: Schema.String,
  window: Schema.Struct({
    fromYear: Schema.Number,
    toYear: Schema.Number,
  }),
  top: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      rank: Schema.Number,
      key: Schema.String,
      score: Schema.Number,
      reason: Schema.String,
    })
  ),
})
export type SolanaPriorityMapArtifact = typeof SolanaPriorityMapArtifact.Type

const CrawlSolanaJsonSummary = Schema.Struct({
  stage: Schema.Literal("crawl_solana_completed"),
  priorityMapPath: Schema.String,
  reportPath: Schema.String,
  behaviorSamplesPath: Schema.optional(Schema.String),
  duneProgramRankingsPath: Schema.optional(Schema.String),
  entries: Schema.Number,
  samples: Schema.optional(Schema.Number),
})

export type CrawlSolanaOptions = {
  readonly fromYear: Option.Option<number>
  readonly toYear: Option.Option<number>
  readonly top: number
  readonly out: Option.Option<string>
  readonly json: boolean
  readonly signatures: ReadonlyArray<string>
  readonly programs: ReadonlyArray<string>
  readonly fromSlot: Option.Option<number>
  readonly toSlot: Option.Option<number>
  readonly sampleLimit: number
  readonly dune: boolean
  readonly dunePeriod: SolanaDunePeriodGranularity
  readonly duneWindowDays?: number
}

export type CrawlSolanaResult = {
  readonly priorityMapPath: string
  readonly reportPath: string
  readonly priorityMap: SolanaPriorityMapArtifact
  readonly behaviorSamplesPath: string | null
  readonly behaviorSamples: SolanaBehaviorSamplesArtifact | null
  readonly duneProgramRankingsPath: string | null
  readonly duneProgramRankings: SolanaDuneRankingsFile | null
}

const fromYearOption = Options.integer("from-year").pipe(
  Options.optional,
  Options.withDescription("Earliest year to include")
)

const toYearOption = Options.integer("to-year").pipe(
  Options.optional,
  Options.withDescription("Latest year to include")
)

const topOption = Options.integer("top").pipe(
  Options.withDefault(100),
  Options.withDescription("Maximum number of priority entries to emit")
)

const outOption = Options.text("out").pipe(
  Options.optional,
  Options.withDescription("Output directory for generated artifacts")
)

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output machine-readable JSON")
)

const signatureOption = Options.text("signature").pipe(
  Options.repeated,
  Options.withDescription("Transaction signature to sample")
)

const programOption = Options.text("program").pipe(
  Options.repeated,
  Options.withDescription("Program id to include when slot-range sampling")
)

const fromSlotOption = Options.integer("from-slot").pipe(
  Options.optional,
  Options.withDescription("First finalized slot to sample")
)

const toSlotOption = Options.integer("to-slot").pipe(
  Options.optional,
  Options.withDescription("Last finalized slot to sample")
)

const sampleLimitOption = Options.integer("sample-limit").pipe(
  Options.withDefault(100),
  Options.withDescription("Maximum behavior samples to emit")
)

const duneOption = Options.boolean("dune").pipe(
  Options.withDescription("Use saved Dune queries for Solana priority rankings")
)

const dunePeriodOption = Options.choice("dune-period", ["year", "quarter"] as const).pipe(
  Options.withDefault("year"),
  Options.withDescription("Period granularity for saved Dune ranking queries")
)

const duneWindowDaysOption = Options.integer("dune-window-days").pipe(
  Options.withDefault(DEFAULT_SOLANA_DUNE_EXECUTION_WINDOW_DAYS),
  Options.withDescription("Maximum date-window size for each saved Dune ranking query execution")
)

export const crawlSolanaOptions = Options.all({
  fromYear: fromYearOption,
  toYear: toYearOption,
  top: topOption,
  out: outOption,
  json: jsonOption,
  signatures: signatureOption,
  programs: programOption,
  fromSlot: fromSlotOption,
  toSlot: toSlotOption,
  sampleLimit: sampleLimitOption,
  dune: duneOption,
  dunePeriod: dunePeriodOption,
  duneWindowDays: duneWindowDaysOption,
})

const resolveDefaultOutputDirectory = Config.string(SOLANA_REFERENCE_DATA_DIR_ENV_VAR).pipe(
  Config.map((configuredDirectory) => {
    const trimmed = configuredDirectory.trim()
    return trimmed.length > 0 ? trimmed : DEFAULT_SOLANA_REFERENCE_DATA_DIR
  }),
  Config.orElse(() => Config.succeed(DEFAULT_SOLANA_REFERENCE_DATA_DIR))
)

const nowIsoString = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(Number(currentTimeMillis)).toISOString()
)

const validateCrawlWindow = ({
  fromYear,
  toYear,
}: {
  readonly fromYear: number
  readonly toYear: number
}) =>
  fromYear > toYear
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--from-year` must be less than or equal to `--to-year`.",
        })
      )
    : Effect.void

const validateTop = (top: number) =>
  top < 0
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--top` must be zero or greater.",
        })
      )
    : Effect.void

const validateSampleLimit = (sampleLimit: number) =>
  sampleLimit < 0
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--sample-limit` must be zero or greater.",
        })
      )
    : Effect.void

const validateDuneWindowDays = (duneWindowDays: number) =>
  !Number.isSafeInteger(duneWindowDays) || duneWindowDays <= 0
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--dune-window-days` must be a positive safe integer.",
        })
      )
    : Effect.void

const validateSlotRange = ({
  fromSlot,
  toSlot,
}: {
  readonly fromSlot: number
  readonly toSlot: number
}) =>
  fromSlot > toSlot
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--from-slot` must be less than or equal to `--to-slot`.",
        })
      )
    : Effect.void

export const makeEmptySolanaPriorityMap = ({
  fromYear,
  toYear,
  top,
  generatedAt,
}: {
  readonly fromYear: number
  readonly toYear: number
  readonly top: number
  readonly generatedAt: string
}): SolanaPriorityMapArtifact => ({
  schemaVersion: 1,
  chain: "solana",
  source: "mock",
  generatedAt,
  window: {
    fromYear,
    toYear,
  },
  top,
  entries: [],
})

const makeSolanaPriorityReport = (artifact: SolanaPriorityMapArtifact): string =>
  [
    "# Solana Priority Report",
    "",
    `Generated at: ${artifact.generatedAt}`,
    `Window: ${artifact.window.fromYear}-${artifact.window.toYear}`,
    `Top limit: ${artifact.top}`,
    "",
    artifact.source === "mock"
      ? "No priority entries were emitted because the crawler is currently using mocked data sources."
      : `Priority entries were generated from ${artifact.source} historical ranking data.`,
    "",
  ].join("\n")

const makeDuneSolanaPriorityMap = ({
  duneProgramRankings,
}: {
  readonly duneProgramRankings: SolanaDuneRankingsFile
}): SolanaPriorityMapArtifact => ({
  schemaVersion: 1,
  chain: "solana",
  source: "dune",
  generatedAt: duneProgramRankings.generatedAt,
  window: duneProgramRankings.window,
  top: duneProgramRankings.top,
  entries: duneProgramRankings.entries.map((entry, index) => ({
    rank: index + 1,
    key: entry.programId,
    score: entry.invocationCount,
    reason: `${entry.queryName} v${entry.queryVersion} query ${entry.queryId} ${entry.periodGranularity} period ${entry.period}`,
  })),
})

const encodePriorityMap = (artifact: SolanaPriorityMapArtifact) =>
  Schema.encode(Schema.parseJson(SolanaPriorityMapArtifact))(artifact).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana priority map artifact.",
        })
    )
  )

const encodeJsonSummary = (summary: typeof CrawlSolanaJsonSummary.Type) =>
  Schema.encode(Schema.parseJson(CrawlSolanaJsonSummary))(summary).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana crawler JSON summary.",
        })
    )
  )

const encodeBehaviorSamples = (artifact: SolanaBehaviorSamplesArtifact) =>
  Schema.encode(Schema.parseJson(SolanaBehaviorSamplesArtifact))(artifact).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana behavior samples artifact.",
        })
    )
  )

const encodeDuneProgramRankings = (rankingsFile: SolanaDuneRankingsFile) =>
  Schema.encode(Schema.parseJson(SolanaDuneRankingsFile))(rankingsFile).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana Dune rankings file.",
        })
    )
  )

const readDefaultOutputDirectory = Effect.configProviderWith((provider) =>
  provider.load(resolveDefaultOutputDirectory)
).pipe(
  Effect.mapError(
    () =>
      new CrawlerCommandError({
        message: "Failed to resolve Solana crawler output directory.",
      })
  )
)

const resolveOutputDirectory = (
  out: Option.Option<string>
): Effect.Effect<string, CrawlerCommandError> =>
  Option.match(out, {
    onNone: () => readDefaultOutputDirectory,
    onSome: (directory) => {
      const trimmed = directory.trim()
      return trimmed.length > 0
        ? Effect.succeed(trimmed)
        : Effect.fail(
            new CrawlerCommandError({
              message: "`--out` must not be empty.",
            })
          )
    },
  })

const trimNonEmpty = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const normalizeStringValues = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(
    new Set(
      values.flatMap((value) => {
        const trimmed = trimNonEmpty(value)
        return trimmed === null ? [] : [trimmed]
      })
    )
  )

const resolveBehaviorSamplingInput = ({
  signatures,
  programs,
  fromSlot,
  toSlot,
  sampleLimit,
}: {
  readonly signatures: ReadonlyArray<string>
  readonly programs: ReadonlyArray<string>
  readonly fromSlot: Option.Option<number>
  readonly toSlot: Option.Option<number>
  readonly sampleLimit: number
}): Effect.Effect<SolanaBehaviorSamplingInput | null, CrawlerCommandError> =>
  Effect.gen(function* () {
    yield* validateSampleLimit(sampleLimit)

    const normalizedSignatures = normalizeStringValues(signatures)
    const normalizedPrograms = normalizeStringValues(programs)
    const maybeFromSlot = Option.getOrNull(fromSlot)
    const maybeToSlot = Option.getOrNull(toSlot)

    if (maybeFromSlot === null && maybeToSlot !== null) {
      return yield* new CrawlerCommandError({
        message: "`--to-slot` requires `--from-slot`.",
      })
    }

    if (maybeFromSlot !== null && maybeToSlot === null) {
      return yield* new CrawlerCommandError({
        message: "`--from-slot` requires `--to-slot`.",
      })
    }

    const slotRange =
      maybeFromSlot === null || maybeToSlot === null
        ? null
        : {
            fromSlot: maybeFromSlot,
            toSlot: maybeToSlot,
          }

    if (slotRange !== null) {
      yield* validateSlotRange(slotRange)
    }

    return normalizedSignatures.length === 0 && slotRange === null
      ? null
      : {
          signatures: [...normalizedSignatures],
          programs: [...normalizedPrograms],
          slotRange,
          sampleLimit,
        }
  })

export const crawlSolanaProgram = ({
  fromYear,
  toYear,
  top,
  out,
  json,
  signatures,
  programs,
  fromSlot,
  toSlot,
  sampleLimit,
  dune,
  dunePeriod,
  duneWindowDays = DEFAULT_SOLANA_DUNE_EXECUTION_WINDOW_DAYS,
}: CrawlSolanaOptions): Effect.Effect<
  CrawlSolanaResult,
  CrawlerCommandError,
  FileSystem.FileSystem | Path.Path | SolanaBehaviorSamplerClient | SolanaDuneProgramRankingClient
> =>
  Effect.gen(function* () {
    yield* validateTop(top)
    yield* validateDuneWindowDays(duneWindowDays)
    const behaviorSamplingInput = yield* resolveBehaviorSamplingInput({
      signatures,
      programs,
      fromSlot,
      toSlot,
      sampleLimit,
    })

    const currentYear = new Date().getUTCFullYear()
    const resolvedFromYear = Option.getOrElse(fromYear, () => currentYear)
    const resolvedToYear = Option.getOrElse(toYear, () => resolvedFromYear)
    yield* validateCrawlWindow({ fromYear: resolvedFromYear, toYear: resolvedToYear })

    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outputDirectory = yield* resolveOutputDirectory(out)
    const priorityMapPath = path.join(outputDirectory, SOLANA_PRIORITY_MAP_FILE_NAME)
    const reportPath = path.join(outputDirectory, SOLANA_PRIORITY_REPORT_FILE_NAME)
    const behaviorSamplesPath = path.join(outputDirectory, SOLANA_BEHAVIOR_SAMPLES_FILE_NAME)
    const duneProgramRankingsPath = path.join(
      outputDirectory,
      SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME
    )
    const generatedAt = yield* nowIsoString
    const duneProgramRankings =
      dune && top > 0
        ? yield* buildSolanaDuneRankingsFile({
            generatedAt,
            executionWindowDays: duneWindowDays,
            fromYear: resolvedFromYear,
            periodGranularity: dunePeriod,
            toYear: resolvedToYear,
            top,
          }).pipe(
            Effect.mapError(
              (error) =>
                new CrawlerCommandError({
                  message: error.message,
                })
            )
          )
        : null
    const priorityMap =
      duneProgramRankings === null
        ? makeEmptySolanaPriorityMap({
            fromYear: resolvedFromYear,
            toYear: resolvedToYear,
            top,
            generatedAt,
          })
        : makeDuneSolanaPriorityMap({ duneProgramRankings })
    const encodedPriorityMap = yield* encodePriorityMap(priorityMap)
    const report = makeSolanaPriorityReport(priorityMap)
    const behaviorSamples =
      behaviorSamplingInput === null
        ? null
        : yield* buildSolanaBehaviorSamplesArtifact({
            generatedAt,
            sampling: behaviorSamplingInput,
          })
    const encodedBehaviorSamples =
      behaviorSamples === null ? null : yield* encodeBehaviorSamples(behaviorSamples)
    const encodedDuneProgramRankings =
      duneProgramRankings === null ? null : yield* encodeDuneProgramRankings(duneProgramRankings)

    yield* fs.makeDirectory(outputDirectory, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: "Failed to create Solana crawler output directory.",
          })
      )
    )
    yield* fs.writeFileString(priorityMapPath, `${encodedPriorityMap}\n`).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: "Failed to write Solana priority map artifact.",
          })
      )
    )
    yield* fs.writeFileString(reportPath, report).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: "Failed to write Solana priority report artifact.",
          })
      )
    )
    if (encodedBehaviorSamples !== null) {
      yield* fs.writeFileString(behaviorSamplesPath, `${encodedBehaviorSamples}\n`).pipe(
        Effect.mapError(
          () =>
            new CrawlerCommandError({
              message: "Failed to write Solana behavior samples artifact.",
            })
        )
      )
    }
    if (encodedDuneProgramRankings !== null) {
      yield* fs.writeFileString(duneProgramRankingsPath, `${encodedDuneProgramRankings}\n`).pipe(
        Effect.mapError(
          () =>
            new CrawlerCommandError({
              message: "Failed to write Solana Dune rankings file.",
            })
        )
      )
    }

    if (json) {
      yield* Console.log(
        yield* encodeJsonSummary({
          stage: "crawl_solana_completed",
          priorityMapPath,
          reportPath,
          ...(behaviorSamples === null
            ? {}
            : {
                behaviorSamplesPath,
                samples: behaviorSamples.samples.length,
              }),
          ...(duneProgramRankings === null
            ? {}
            : {
                duneProgramRankingsPath,
              }),
          entries: priorityMap.entries.length,
        })
      )
    } else {
      yield* Console.log(`Wrote ${priorityMapPath}`)
      yield* Console.log(`Wrote ${reportPath}`)
      if (behaviorSamples !== null) {
        yield* Console.log(`Wrote ${behaviorSamplesPath}`)
      }
      if (duneProgramRankings !== null) {
        yield* Console.log(`Wrote ${duneProgramRankingsPath}`)
      }
    }

    return {
      priorityMapPath,
      reportPath,
      priorityMap,
      behaviorSamplesPath: behaviorSamples === null ? null : behaviorSamplesPath,
      behaviorSamples,
      duneProgramRankingsPath: duneProgramRankings === null ? null : duneProgramRankingsPath,
      duneProgramRankings,
    }
  })

export const crawlSolanaCommand = Command.make(
  "solana",
  {
    fromYear: fromYearOption,
    toYear: toYearOption,
    top: topOption,
    out: outOption,
    json: jsonOption,
    signatures: signatureOption,
    programs: programOption,
    fromSlot: fromSlotOption,
    toSlot: toSlotOption,
    sampleLimit: sampleLimitOption,
    dune: duneOption,
    dunePeriod: dunePeriodOption,
    duneWindowDays: duneWindowDaysOption,
  },
  crawlSolanaProgram
).pipe(Command.withDescription("Crawl Solana data sources and emit priority artifacts"))
