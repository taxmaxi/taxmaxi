import { Command, Options } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Schema } from "effect"
import * as Config from "effect/Config"
import * as Option from "effect/Option"

export const SOLANA_PRIORITY_MAP_FILE_NAME = "solana-priority-map.json"
export const SOLANA_PRIORITY_REPORT_FILE_NAME = "solana-priority-report.md"
export const DEFAULT_SOLANA_REFERENCE_DATA_DIR =
  "packages/sync-engine/src/providers/helius-solana/reference-data"

const SOLANA_REFERENCE_DATA_DIR_ENV_VAR = "CRAWLER_SOLANA_REFERENCE_DATA_DIR"

export class CrawlerCommandError extends Schema.TaggedError<CrawlerCommandError>()(
  "CrawlerCommandError",
  {
    message: Schema.String,
  }
) {}

export const SolanaPriorityMapArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chain: Schema.Literal("solana"),
  source: Schema.Literal("mock"),
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
  entries: Schema.Number,
})

export type CrawlSolanaOptions = {
  readonly fromYear: Option.Option<number>
  readonly toYear: Option.Option<number>
  readonly top: number
  readonly out: Option.Option<string>
  readonly json: boolean
}

export type CrawlSolanaResult = {
  readonly priorityMapPath: string
  readonly reportPath: string
  readonly priorityMap: SolanaPriorityMapArtifact
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

export const crawlSolanaOptions = Options.all({
  fromYear: fromYearOption,
  toYear: toYearOption,
  top: topOption,
  out: outOption,
  json: jsonOption,
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
    "No priority entries were emitted because the crawler is currently using mocked data sources.",
    "",
  ].join("\n")

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

export const crawlSolanaProgram = ({
  fromYear,
  toYear,
  top,
  out,
  json,
}: CrawlSolanaOptions): Effect.Effect<
  CrawlSolanaResult,
  CrawlerCommandError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    yield* validateTop(top)

    const currentYear = new Date().getUTCFullYear()
    const resolvedFromYear = Option.getOrElse(fromYear, () => currentYear)
    const resolvedToYear = Option.getOrElse(toYear, () => resolvedFromYear)
    yield* validateCrawlWindow({ fromYear: resolvedFromYear, toYear: resolvedToYear })

    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outputDirectory = yield* resolveOutputDirectory(out)
    const priorityMapPath = path.join(outputDirectory, SOLANA_PRIORITY_MAP_FILE_NAME)
    const reportPath = path.join(outputDirectory, SOLANA_PRIORITY_REPORT_FILE_NAME)
    const generatedAt = yield* nowIsoString
    const priorityMap = makeEmptySolanaPriorityMap({
      fromYear: resolvedFromYear,
      toYear: resolvedToYear,
      top,
      generatedAt,
    })
    const encodedPriorityMap = yield* encodePriorityMap(priorityMap)
    const report = makeSolanaPriorityReport(priorityMap)

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

    if (json) {
      yield* Console.log(
        yield* encodeJsonSummary({
          stage: "crawl_solana_completed",
          priorityMapPath,
          reportPath,
          entries: priorityMap.entries.length,
        })
      )
    } else {
      yield* Console.log(`Wrote ${priorityMapPath}`)
      yield* Console.log(`Wrote ${reportPath}`)
    }

    return {
      priorityMapPath,
      reportPath,
      priorityMap,
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
  },
  crawlSolanaProgram
).pipe(Command.withDescription("Crawl mocked Solana data sources and emit priority artifacts"))
