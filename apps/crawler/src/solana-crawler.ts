import { Command, Options } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Schema } from "effect"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
import {
  ProtocolCandidateRepository,
  type ProtocolCandidateImportResult,
} from "@my/sync-engine/services"
import {
  duneObservationsFromSolanaDuneRankingsFile,
  SolanaDuneRankingsFile,
} from "@my/sync-engine/providers/helius-solana"
import { CrawlerCommandError } from "./errors.ts"
import {
  buildSolanaBehaviorSamplesArtifact,
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplesArtifact,
  type SolanaBehaviorSamplingInput,
} from "./solana-behavior-sampler.ts"
import {
  buildSolanaDexDiscoveryFile,
  DEFAULT_SOLANA_DEX_DISCOVERY_WINDOW_DAYS,
  solanaDuneDexProjectRankingsFileName,
} from "./solana-dex-discovery.ts"
import { SolanaDuneClient, solanaDuneClientFromRecordedExecutions } from "./solana-dune-client.ts"

export const SOLANA_BEHAVIOR_SAMPLES_FILE_NAME = "solana-behavior-samples.json"
export const DEFAULT_SOLANA_REFERENCE_DATA_DIR =
  "packages/sync-engine/src/providers/helius-solana/reference-data"

const SOLANA_REFERENCE_DATA_DIR_ENV_VAR = "CRAWLER_SOLANA_REFERENCE_DATA_DIR"

const CrawlSolanaBehaviorJsonSummary = Schema.Struct({
  stage: Schema.Literal("crawl_solana_behavior_completed"),
  behaviorSamplesPath: Schema.String,
  samples: Schema.Number,
})

const CrawlSolanaJsonSummary = Schema.Struct({
  stage: Schema.Literal("crawl_solana_completed"),
  dexProjectRankingsPath: Schema.optional(Schema.String),
  replayedFromFile: Schema.optional(Schema.String),
  entries: Schema.Number,
  candidates: Schema.Number,
  duneProtocolCandidateObservations: Schema.Number,
})

export type CrawlSolanaBehaviorOptions = {
  readonly out: Option.Option<string>
  readonly json: boolean
  readonly signatures: ReadonlyArray<string>
  readonly programs: ReadonlyArray<string>
  readonly fromSlot: Option.Option<number>
  readonly toSlot: Option.Option<number>
  readonly sampleLimit: number
}

export type CrawlSolanaBehaviorResult = {
  readonly behaviorSamplesPath: string
  readonly behaviorSamples: SolanaBehaviorSamplesArtifact
}

export type CrawlSolanaOptions = {
  readonly startDate: Option.Option<string>
  readonly endDate: Option.Option<string>
  readonly fromFile: Option.Option<string>
  readonly topProjects: number
  readonly samplesPerProject: number
  readonly windowDays: number
  readonly out: Option.Option<string>
  readonly json: boolean
}

export type CrawlSolanaResult = {
  readonly dexProjectRankingsPath: string | null
  readonly dexProjectRankings: SolanaDuneRankingsFile
  readonly duneProtocolCandidateImport: ProtocolCandidateImportResult
  readonly replayedFromFile: string | null
}

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

const startDateOption = Options.text("start-date").pipe(
  Options.optional,
  Options.withDescription("Inclusive UTC start date, YYYY-MM-DD")
)

const endDateOption = Options.text("end-date").pipe(
  Options.optional,
  Options.withDescription("Exclusive UTC end date, YYYY-MM-DD")
)

const fromFileOption = Options.text("from-file").pipe(
  Options.optional,
  Options.withDescription(
    "Replay a previously written rankings file instead of calling Dune; uses no Dune credits"
  )
)

const topProjectsOption = Options.integer("top-projects").pipe(
  Options.withDefault(10),
  Options.withDescription("Maximum number of ranked DEX projects to keep per window")
)

const samplesPerProjectOption = Options.integer("samples-per-project").pipe(
  Options.withDefault(25),
  Options.withDescription("Maximum sample transaction signatures per project")
)

const windowDaysOption = Options.integer("window-days").pipe(
  Options.withDefault(DEFAULT_SOLANA_DEX_DISCOVERY_WINDOW_DAYS),
  Options.withDescription(
    "Maximum days per Dune execution window; timed-out windows are halved automatically"
  )
)

const dexOutOption = Options.text("out").pipe(
  Options.optional,
  Options.withDescription(
    "Also write the rankings file to this directory; without it only the database is updated"
  )
)

export const crawlSolanaBehaviorOptions = Options.all({
  out: outOption,
  json: jsonOption,
  signatures: signatureOption,
  programs: programOption,
  fromSlot: fromSlotOption,
  toSlot: toSlotOption,
  sampleLimit: sampleLimitOption,
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

const validateSampleLimit = (sampleLimit: number) =>
  sampleLimit < 0
    ? Effect.fail(
        new CrawlerCommandError({
          message: "`--sample-limit` must be zero or greater.",
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

const validateNonNegative = ({ flag, value }: { readonly flag: string; readonly value: number }) =>
  value < 0
    ? Effect.fail(
        new CrawlerCommandError({
          message: `\`${flag}\` must be zero or greater.`,
        })
      )
    : Effect.void

const encodeJsonBehaviorSummary = (summary: typeof CrawlSolanaBehaviorJsonSummary.Type) =>
  Schema.encode(Schema.parseJson(CrawlSolanaBehaviorJsonSummary))(summary).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana crawler JSON summary.",
        })
    )
  )

const encodeJsonSummary = (summary: typeof CrawlSolanaJsonSummary.Type) =>
  Schema.encode(Schema.parseJson(CrawlSolanaJsonSummary))(summary).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana DEX crawler JSON summary.",
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

const encodeDexProjectRankings = (rankingsFile: SolanaDuneRankingsFile) =>
  Schema.encode(Schema.parseJson(SolanaDuneRankingsFile))(rankingsFile).pipe(
    Effect.mapError(
      () =>
        new CrawlerCommandError({
          message: "Failed to encode Solana Dune DEX project rankings file.",
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
}): Effect.Effect<SolanaBehaviorSamplingInput, CrawlerCommandError> =>
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

    if (normalizedSignatures.length === 0 && slotRange === null) {
      return yield* new CrawlerCommandError({
        message: "Provide `--signature` values or a `--from-slot`/`--to-slot` range to sample.",
      })
    }

    return {
      signatures: [...normalizedSignatures],
      programs: [...normalizedPrograms],
      slotRange,
      sampleLimit,
    }
  })

export const crawlSolanaBehaviorProgram = ({
  out,
  json,
  signatures,
  programs,
  fromSlot,
  toSlot,
  sampleLimit,
}: CrawlSolanaBehaviorOptions): Effect.Effect<
  CrawlSolanaBehaviorResult,
  CrawlerCommandError,
  FileSystem.FileSystem | Path.Path | SolanaBehaviorSamplerClient
> =>
  Effect.gen(function* () {
    const behaviorSamplingInput = yield* resolveBehaviorSamplingInput({
      signatures,
      programs,
      fromSlot,
      toSlot,
      sampleLimit,
    })

    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outputDirectory = yield* resolveOutputDirectory(out)
    const behaviorSamplesPath = path.join(outputDirectory, SOLANA_BEHAVIOR_SAMPLES_FILE_NAME)
    const generatedAt = yield* nowIsoString

    const behaviorSamples = yield* buildSolanaBehaviorSamplesArtifact({
      generatedAt,
      sampling: behaviorSamplingInput,
    })
    const encodedBehaviorSamples = yield* encodeBehaviorSamples(behaviorSamples)

    yield* fs.makeDirectory(outputDirectory, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: "Failed to create Solana crawler output directory.",
          })
      )
    )
    yield* fs.writeFileString(behaviorSamplesPath, `${encodedBehaviorSamples}\n`).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: "Failed to write Solana behavior samples artifact.",
          })
      )
    )

    if (json) {
      yield* Console.log(
        yield* encodeJsonBehaviorSummary({
          stage: "crawl_solana_behavior_completed",
          behaviorSamplesPath,
          samples: behaviorSamples.samples.length,
        })
      )
    } else {
      yield* Console.log(`Wrote ${behaviorSamplesPath}`)
    }

    return {
      behaviorSamplesPath,
      behaviorSamples,
    }
  })

export const crawlSolanaBehaviorCommand = Command.make(
  "solana-behavior",
  {
    out: outOption,
    json: jsonOption,
    signatures: signatureOption,
    programs: programOption,
    fromSlot: fromSlotOption,
    toSlot: toSlotOption,
    sampleLimit: sampleLimitOption,
  },
  crawlSolanaBehaviorProgram
).pipe(Command.withDescription("Sample Solana transaction behavior and emit a samples artifact"))

const readReplayRankingsFile = (
  filePath: string
): Effect.Effect<SolanaDuneRankingsFile, CrawlerCommandError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: `Failed to read rankings file at ${filePath}.`,
          })
      )
    )

    return yield* Schema.decodeUnknown(Schema.parseJson(SolanaDuneRankingsFile))(content).pipe(
      Effect.mapError(
        () =>
          new CrawlerCommandError({
            message: `Failed to decode rankings file at ${filePath}; only files written by this crawler version can be replayed.`,
          })
      )
    )
  })

export const crawlSolanaProgram = ({
  startDate,
  endDate,
  fromFile,
  topProjects,
  samplesPerProject,
  windowDays,
  out,
  json,
}: CrawlSolanaOptions): Effect.Effect<
  CrawlSolanaResult,
  CrawlerCommandError,
  FileSystem.FileSystem | Path.Path | ProtocolCandidateRepository | SolanaDuneClient
> =>
  Effect.gen(function* () {
    yield* validateNonNegative({ flag: "--top-projects", value: topProjects })
    yield* validateNonNegative({ flag: "--samples-per-project", value: samplesPerProject })

    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outputDirectory = yield* Option.match(out, {
      onNone: () => Effect.succeed<string | null>(null),
      onSome: (directory) => {
        const trimmed = directory.trim()
        return trimmed.length === 0
          ? Effect.fail(new CrawlerCommandError({ message: "`--out` must not be empty." }))
          : Effect.succeed<string | null>(trimmed)
      },
    })
    const generatedAt = yield* nowIsoString

    const replayFile = yield* Option.match(fromFile, {
      onNone: () => Effect.succeed<SolanaDuneRankingsFile | null>(null),
      onSome: (filePath) =>
        Option.isSome(startDate) || Option.isSome(endDate)
          ? Effect.fail(
              new CrawlerCommandError({
                message:
                  "`--from-file` replays the file's date range; do not pass `--start-date` or `--end-date`.",
              })
            )
          : readReplayRankingsFile(filePath),
    })

    const dexProjectRankings = yield* replayFile === null
      ? Effect.gen(function* () {
          const requireDate = (value: Option.Option<string>, flag: string) =>
            Option.match(value, {
              onNone: () =>
                Effect.fail(
                  new CrawlerCommandError({
                    message: `Provide \`${flag}\` and its counterpart, or replay with \`--from-file\`.`,
                  })
                ),
              onSome: (date) => Effect.succeed(date),
            })

          return yield* buildSolanaDexDiscoveryFile({
            generatedAt,
            startDate: yield* requireDate(startDate, "--start-date"),
            endDate: yield* requireDate(endDate, "--end-date"),
            topProjects,
            samplesPerProject,
            windowDays,
          }).pipe(
            Effect.mapError(
              (error) =>
                new CrawlerCommandError({
                  message: error.message,
                })
            )
          )
        })
      : buildSolanaDexDiscoveryFile({
          generatedAt,
          startDate: replayFile.startDate,
          endDate: replayFile.endDate,
          topProjects: replayFile.parameters.topProjects,
          samplesPerProject: replayFile.parameters.samplesPerProject,
          windowDays: replayFile.parameters.windowDays,
        }).pipe(
          Effect.provideService(
            SolanaDuneClient,
            solanaDuneClientFromRecordedExecutions(replayFile.executions)
          ),
          Effect.mapError(
            (error) =>
              new CrawlerCommandError({
                message: error.message,
              })
          )
        )

    const dexProjectRankingsPath =
      outputDirectory === null
        ? null
        : path.join(outputDirectory, solanaDuneDexProjectRankingsFileName(dexProjectRankings))

    const duneProtocolCandidateImport = yield* Effect.gen(function* () {
      const repository = yield* ProtocolCandidateRepository
      const observations = yield* duneObservationsFromSolanaDuneRankingsFile({
        rankingsFile: dexProjectRankings,
        blockchainName: "solana",
      })
      return yield* repository.importObservations({ observations })
    }).pipe(
      Effect.mapError(
        (error) =>
          new CrawlerCommandError({
            message: error.message,
          })
      )
    )

    if (outputDirectory !== null && dexProjectRankingsPath !== null) {
      const encodedDexProjectRankings = yield* encodeDexProjectRankings(dexProjectRankings)
      yield* fs.makeDirectory(outputDirectory, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new CrawlerCommandError({
              message: "Failed to create Solana crawler output directory.",
            })
        )
      )
      yield* fs.writeFileString(dexProjectRankingsPath, `${encodedDexProjectRankings}\n`).pipe(
        Effect.mapError(
          () =>
            new CrawlerCommandError({
              message: "Failed to write Solana Dune DEX project rankings file.",
            })
        )
      )
    }

    const replayedFromFile = Option.getOrNull(fromFile)
    const importedCandidateCount = new Set(
      duneProtocolCandidateImport.candidates.map((candidate) => candidate.id)
    ).size

    if (json) {
      yield* Console.log(
        yield* encodeJsonSummary({
          stage: "crawl_solana_completed",
          ...(dexProjectRankingsPath === null ? {} : { dexProjectRankingsPath }),
          ...(replayedFromFile === null ? {} : { replayedFromFile }),
          entries: dexProjectRankings.entries.length,
          candidates: importedCandidateCount,
          duneProtocolCandidateObservations: duneProtocolCandidateImport.observationCount,
        })
      )
    } else {
      if (dexProjectRankingsPath !== null) {
        yield* Console.log(`Wrote ${dexProjectRankingsPath}`)
      }
      yield* Console.log(
        `Imported ${duneProtocolCandidateImport.observationCount} candidate observations`
      )
    }

    return {
      dexProjectRankingsPath,
      dexProjectRankings,
      duneProtocolCandidateImport,
      replayedFromFile,
    }
  })

export const crawlSolanaCommand = Command.make(
  "solana",
  {
    startDate: startDateOption,
    endDate: endDateOption,
    fromFile: fromFileOption,
    topProjects: topProjectsOption,
    samplesPerProject: samplesPerProjectOption,
    windowDays: windowDaysOption,
    out: dexOutOption,
    json: jsonOption,
  },
  crawlSolanaProgram
).pipe(
  Command.withDescription(
    "Discover Solana DEX protocol candidates from curated Dune swap data and import them for review"
  )
)
