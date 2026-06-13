import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Option, Schema } from "effect"
import {
  ProtocolCandidateRepository,
  type ProtocolCandidateObservationDraft,
} from "@my/sync-engine/services"
import { SolanaDuneRankingsFile } from "@my/sync-engine/providers/helius-solana"
import {
  buildSolanaDexDiscoveryFile,
  solanaDuneDexProjectRankingsFileName,
} from "../src/solana-dex-discovery.ts"
import { crawlSolanaProgram } from "../src/solana-crawler.ts"
import {
  SolanaDuneClient,
  SolanaDuneClientTestLive,
  SolanaDuneError,
  solanaDuneClientFromRecordedExecutions,
  type ExecuteSolanaDuneQueryParams,
} from "../src/solana-dune-client.ts"

const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
const PHOENIX_PROGRAM = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"

const completedRows = (rows: ReadonlyArray<unknown>) => ({
  state: "QUERY_STATE_COMPLETED",
  result: { rows },
})

const priorityRow = ({
  project,
  traders,
  volume,
  programIds,
  programIdCount = programIds?.length ?? 0,
  period = "2024-01-01 to 2024-01-08",
}: {
  readonly project: string
  readonly traders: number
  readonly volume: number
  readonly programIds: ReadonlyArray<string> | null
  readonly programIdCount?: number
  readonly period?: string
}) => ({
  project,
  tax_category: "swap",
  period,
  retrieved_at: "2026-06-12T00:00:00Z",
  approx_unique_traders: traders,
  approx_trade_transactions: traders * 2,
  trade_rows: traders * 3,
  canonical_program_ids: programIds,
  canonical_program_id_count: programIdCount,
  volume_usd: volume,
})

const defaultPriorityRows = [
  priorityRow({
    project: "raydium",
    traders: 107551,
    volume: 175670048.87,
    programIds: [RAYDIUM_AMM_PROGRAM, RAYDIUM_CLMM_PROGRAM, RAYDIUM_AMM_PROGRAM],
  }),
  priorityRow({
    project: "orca",
    traders: 52649,
    volume: 247140649.51,
    programIds: [ORCA_WHIRLPOOL_PROGRAM],
  }),
  priorityRow({
    project: "phoenix",
    traders: 8345,
    volume: 29525386.45,
    programIds: [PHOENIX_PROGRAM],
  }),
]

type RecordedCall = {
  readonly kind: string
  readonly parameters: Readonly<Record<string, string>>
}

const dexDiscoveryClientLive = (overrides?: {
  readonly priorityRows?: ReadonlyArray<unknown>
  readonly priorityRowsForWindow?: (
    parameters: Readonly<Record<string, string>>
  ) => ReadonlyArray<unknown> | SolanaDuneError
  readonly failSampleQuery?: boolean
  readonly calls?: Array<RecordedCall>
}) =>
  SolanaDuneClientTestLive({
    executeQuery: ({ parameters, query }: ExecuteSolanaDuneQueryParams) => {
      overrides?.calls?.push({ kind: query.kind, parameters })

      if (query.kind === "dex-project-priority") {
        if (overrides?.priorityRowsForWindow !== undefined) {
          const rows = overrides.priorityRowsForWindow(parameters)
          return rows instanceof SolanaDuneError
            ? Effect.fail(rows)
            : Effect.succeed(completedRows(rows))
        }
        return Effect.succeed(completedRows(overrides?.priorityRows ?? defaultPriorityRows))
      }

      if (overrides?.failSampleQuery === true) {
        return Effect.dieMessage("sample query should not run")
      }
      const project = parameters.project ?? "unknown"
      return Effect.succeed(
        completedRows([
          { tx_id: `${project}-swap-1` },
          { tx_id: `${project}-swap-2` },
          { tx_id: `${project}-swap-2` },
          { tx_id: `${project}-swap-3` },
        ])
      )
    },
  })

const runDiscovery = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect)

describe("solana dex discovery", () => {
  it("emits one named, categorized project entry with canonical program id evidence", async () => {
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(Effect.provide(dexDiscoveryClientLive()))
    )

    expect(file.entries.map((entry) => entry.subjectIdentifier)).toEqual([
      "raydium",
      "orca",
      "phoenix",
    ])
    expect(file.entries[0]).toMatchObject({
      subjectKind: "protocol",
      subjectIdentifier: "raydium",
      protocolNameHint: "raydium",
      categoryHint: "swap",
      canonicalProgramIds: [RAYDIUM_AMM_PROGRAM, RAYDIUM_CLMM_PROGRAM],
      period: "2024-01-01 to 2024-01-08",
      invocationCount: 107551 * 3,
      uniqueSignerCount: 107551,
      transactionCount: 107551 * 2,
      volumeUsd: 175670048.87,
      sampleSignatures: ["raydium-swap-1", "raydium-swap-2", "raydium-swap-3"],
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
      retrievedAt: "2026-06-12T00:00:00Z",
    })
    expect(file.entries[1]).toMatchObject({
      protocolNameHint: "orca",
      categoryHint: "swap",
      canonicalProgramIds: [ORCA_WHIRLPOOL_PROGRAM],
      volumeUsd: 247140649.51,
    })
    expect(file.queries.map((query) => query.queryName)).toEqual([
      "solana-dex-project-priority",
      "solana-dex-project-sample-transactions",
    ])
    expect(file.startDate).toBe("2024-01-01")
    expect(file.endDate).toBe("2024-01-08")
    expect(file.parameters).toEqual({ topProjects: 10, samplesPerProject: 25, windowDays: 7 })
    expect(
      file.executions.map((execution) => ({ kind: execution.kind, status: execution.status }))
    ).toEqual([
      { kind: "dex-project-priority", status: "completed" },
      { kind: "dex-project-sample-transactions", status: "completed" },
      { kind: "dex-project-sample-transactions", status: "completed" },
      { kind: "dex-project-sample-transactions", status: "completed" },
    ])
    expect(file.executions[0]?.response).toEqual(completedRows(defaultPriorityRows))
    await expect(runDiscovery(Schema.decodeUnknown(SolanaDuneRankingsFile)(file))).resolves.toEqual(
      file
    )
  })

  it("keeps only the requested number of top projects ordered by traders", async () => {
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 1,
        samplesPerProject: 25,
      }).pipe(Effect.provide(dexDiscoveryClientLive()))
    )

    expect(file.entries.map((entry) => entry.protocolNameHint)).toEqual(["raydium"])
  })

  it("limits sample signatures per project", async () => {
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 2,
      }).pipe(Effect.provide(dexDiscoveryClientLive()))
    )

    expect(file.entries[0]?.sampleSignatures).toEqual(["raydium-swap-1", "raydium-swap-2"])
  })

  it("skips the sample query entirely when samples are disabled", async () => {
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 0,
      }).pipe(Effect.provide(dexDiscoveryClientLive({ failSampleQuery: true })))
    )

    expect(file.entries[0]?.sampleSignatures).toEqual([])
  })

  it("splits long ranges into windows and samples each project once", async () => {
    const calls: Array<RecordedCall> = []
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-15",
        topProjects: 10,
        samplesPerProject: 25,
        windowDays: 7,
      }).pipe(Effect.provide(dexDiscoveryClientLive({ calls })))
    )

    const priorityCalls = calls.filter((call) => call.kind === "dex-project-priority")
    expect(priorityCalls.map((call) => call.parameters)).toEqual([
      { start_date: "2024-01-01", end_date: "2024-01-08" },
      { start_date: "2024-01-08", end_date: "2024-01-15" },
    ])

    const sampleCalls = calls.filter((call) => call.kind === "dex-project-sample-transactions")
    expect(sampleCalls.filter((call) => call.parameters.project === "raydium")).toEqual([
      {
        kind: "dex-project-sample-transactions",
        parameters: { project: "raydium", start_date: "2024-01-01", end_date: "2024-01-02" },
      },
    ])

    const raydiumEntries = file.entries.filter((entry) => entry.subjectIdentifier === "raydium")
    expect(raydiumEntries.map((entry) => entry.period)).toEqual([
      "2024-01-01 to 2024-01-08",
      "2024-01-08 to 2024-01-15",
    ])
    expect(raydiumEntries[0]?.sampleSignatures).toEqual([
      "raydium-swap-1",
      "raydium-swap-2",
      "raydium-swap-3",
    ])
    expect(raydiumEntries[1]?.sampleSignatures).toEqual([])
  })

  it("halves a window when the Dune execution times out", async () => {
    const calls: Array<RecordedCall> = []
    const timeoutError = new SolanaDuneError({
      queryId: 7_647_495,
      message:
        'Dune execution x ended with QUERY_STATE_FAILED: {"type":"FAILED_TYPE_EXECUTION_TIMEOUT"}',
    })
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 0,
        windowDays: 7,
      }).pipe(
        Effect.provide(
          dexDiscoveryClientLive({
            calls,
            priorityRowsForWindow: (parameters) => {
              const isFullWindow =
                parameters.start_date === "2024-01-01" && parameters.end_date === "2024-01-08"
              return isFullWindow
                ? timeoutError
                : [
                    priorityRow({
                      project: "raydium",
                      traders: 10,
                      volume: 1,
                      programIds: [RAYDIUM_AMM_PROGRAM],
                      period: `${parameters.start_date} to ${parameters.end_date}`,
                    }),
                  ]
            },
          })
        )
      )
    )

    const priorityCalls = calls.filter((call) => call.kind === "dex-project-priority")
    expect(priorityCalls.map((call) => call.parameters)).toEqual([
      { start_date: "2024-01-01", end_date: "2024-01-08" },
      { start_date: "2024-01-01", end_date: "2024-01-05" },
      { start_date: "2024-01-05", end_date: "2024-01-08" },
    ])
    expect(file.entries.map((entry) => entry.period)).toEqual([
      "2024-01-01 to 2024-01-05",
      "2024-01-05 to 2024-01-08",
    ])
    expect(
      file.executions.map((execution) => ({
        status: execution.status,
        parameters: execution.parameters,
      }))
    ).toEqual([
      {
        status: "timed_out",
        parameters: { start_date: "2024-01-01", end_date: "2024-01-08" },
      },
      {
        status: "completed",
        parameters: { start_date: "2024-01-01", end_date: "2024-01-05" },
      },
      {
        status: "completed",
        parameters: { start_date: "2024-01-05", end_date: "2024-01-08" },
      },
    ])
  })

  it("fails when a one-day window still times out", async () => {
    const timeoutError = new SolanaDuneError({
      queryId: 7_647_495,
      message:
        'Dune execution x ended with QUERY_STATE_FAILED: {"type":"FAILED_TYPE_EXECUTION_TIMEOUT"}',
    })
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-03",
        topProjects: 10,
        samplesPerProject: 0,
        windowDays: 7,
      }).pipe(
        Effect.provide(
          dexDiscoveryClientLive({
            priorityRowsForWindow: () => timeoutError,
          })
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("EXECUTION_TIMEOUT")
    }
  })

  it("emits no entries or sample queries for projects without canonical program ids", async () => {
    const calls: Array<RecordedCall> = []
    const file = await runDiscovery(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(
        Effect.provide(
          dexDiscoveryClientLive({
            calls,
            priorityRows: [
              priorityRow({ project: "mystery", traders: 999, volume: 1, programIds: null }),
              priorityRow({
                project: "orca",
                traders: 100,
                volume: 2,
                programIds: [ORCA_WHIRLPOOL_PROGRAM],
              }),
            ],
          })
        )
      )
    )

    expect(file.entries.map((entry) => entry.subjectIdentifier)).toEqual(["orca"])
    expect(
      calls
        .filter((call) => call.kind === "dex-project-sample-transactions")
        .map((call) => call.parameters.project)
    ).toEqual(["orca"])
  })

  it("fails when Dune returns a truncated canonical program id sample", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 0,
      }).pipe(
        Effect.provide(
          dexDiscoveryClientLive({
            priorityRows: [
              priorityRow({
                project: "raydium",
                traders: 107551,
                volume: 175670048.87,
                programIds: Array.from(
                  { length: 20 },
                  (_, index) => `${RAYDIUM_AMM_PROGRAM}-${index}`
                ),
                programIdCount: 21,
              }),
            ],
            failSampleQuery: true,
          })
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain(
        "has 20 canonical_program_ids but canonical_program_id_count is 21"
      )
    }
  })

  it("fails when the range produces no candidate entries", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(Effect.provide(dexDiscoveryClientLive({ priorityRows: [] })))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("produced no candidate entries")
    }
  })

  it("fails with a structured error on malformed priority rows", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(
        Effect.provide(dexDiscoveryClientLive({ priorityRows: [{ project: 42, nonsense: true }] }))
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("Failed to decode Dune rows")
    }
  })

  it("rejects an invalid date range", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-02-01",
        endDate: "2024-01-01",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(Effect.provide(dexDiscoveryClientLive()))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("`startDate` must be before `endDate`")
    }
  })

  it("rejects normalized but invalid calendar dates", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-02-31",
        endDate: "2024-03-08",
        topProjects: 10,
        samplesPerProject: 25,
      }).pipe(Effect.provide(dexDiscoveryClientLive({ failSampleQuery: true })))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain(
        "`startDate` must be a UTC date formatted as YYYY-MM-DD"
      )
    }
  })

  it("imports observations with protocol name and category hints", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const importedObservations: ProtocolCandidateObservationDraft[] = []
    const protocolCandidateRepositoryLive = Layer.succeed(
      ProtocolCandidateRepository,
      ProtocolCandidateRepository.of({
        importObservations: ({ observations }) =>
          Effect.sync(() => {
            importedObservations.push(...observations)
            return {
              candidates: [],
              observationCount: observations.length,
            }
          }),
      })
    )

    const result = await crawlSolanaProgram({
      startDate: Option.some("2024-01-01"),
      endDate: Option.some("2024-01-08"),
      fromFile: Option.none(),
      topProjects: 10,
      samplesPerProject: 25,
      windowDays: 7,
      out: Option.some(outputDirectory),
      json: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeContext.layer, dexDiscoveryClientLive(), protocolCandidateRepositoryLive)
      ),
      Effect.runPromise
    )

    expect(result.dexProjectRankingsPath).toBe(
      `${outputDirectory}/${solanaDuneDexProjectRankingsFileName({ startDate: "2024-01-01", endDate: "2024-01-08" })}`
    )
    expect(result.duneProtocolCandidateImport.observationCount).toBe(3)
    expect(
      importedObservations.map((observation) => ({
        subjectKind: observation.subjectKind,
        subjectIdentifier: observation.subjectIdentifier,
        protocolNameHint: observation.protocolNameHint,
        categoryHint: observation.categoryHint,
        canonicalProgramIds: observation.rawPayload.canonicalProgramIds,
      }))
    ).toEqual([
      {
        subjectKind: "protocol",
        subjectIdentifier: "raydium",
        protocolNameHint: "raydium",
        categoryHint: "swap",
        canonicalProgramIds: [RAYDIUM_AMM_PROGRAM, RAYDIUM_CLMM_PROGRAM],
      },
      {
        subjectKind: "protocol",
        subjectIdentifier: "orca",
        protocolNameHint: "orca",
        categoryHint: "swap",
        canonicalProgramIds: [ORCA_WHIRLPOOL_PROGRAM],
      },
      {
        subjectKind: "protocol",
        subjectIdentifier: "phoenix",
        protocolNameHint: "phoenix",
        categoryHint: "swap",
        canonicalProgramIds: [PHOENIX_PROGRAM],
      },
    ])
    expect(importedObservations[0]?.subjectKind).toBe("protocol")
    expect(importedObservations[0]?.sampleTransactionHashes).toEqual([
      "raydium-swap-1",
      "raydium-swap-2",
      "raydium-swap-3",
    ])
    expect(importedObservations[0]?.rawPayload).toMatchObject({
      protocolNameHint: "raydium",
      categoryHint: "swap",
      canonicalProgramIds: [RAYDIUM_AMM_PROGRAM, RAYDIUM_CLMM_PROGRAM],
      volumeUsd: 175670048.87,
    })
    expect(importedObservations[0]?.sourceMetadata).toEqual({
      source: "dune",
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
    })
  })

  it("only updates the database when no output directory is requested", async () => {
    const importedObservations: ProtocolCandidateObservationDraft[] = []
    const protocolCandidateRepositoryLive = Layer.succeed(
      ProtocolCandidateRepository,
      ProtocolCandidateRepository.of({
        importObservations: ({ observations }) =>
          Effect.sync(() => {
            importedObservations.push(...observations)
            return {
              candidates: [],
              observationCount: observations.length,
            }
          }),
      })
    )

    const result = await crawlSolanaProgram({
      startDate: Option.some("2024-01-01"),
      endDate: Option.some("2024-01-08"),
      fromFile: Option.none(),
      topProjects: 10,
      samplesPerProject: 25,
      windowDays: 7,
      out: Option.none(),
      json: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeContext.layer, dexDiscoveryClientLive(), protocolCandidateRepositoryLive)
      ),
      Effect.runPromise
    )

    expect(result.dexProjectRankingsPath).toBeNull()
    expect(result.duneProtocolCandidateImport.observationCount).toBe(3)
    expect(importedObservations).toHaveLength(3)
  })

  it("replays a written rankings file without calling Dune", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const importedObservations: ProtocolCandidateObservationDraft[] = []
    const protocolCandidateRepositoryLive = Layer.succeed(
      ProtocolCandidateRepository,
      ProtocolCandidateRepository.of({
        importObservations: ({ observations }) =>
          Effect.sync(() => {
            importedObservations.push(...observations)
            return {
              candidates: [],
              observationCount: observations.length,
            }
          }),
      })
    )
    const deadDuneClientLive = SolanaDuneClientTestLive({
      executeQuery: () => Effect.dieMessage("Dune must not be called during a replay"),
    })

    const liveResult = await crawlSolanaProgram({
      startDate: Option.some("2024-01-01"),
      endDate: Option.some("2024-01-08"),
      fromFile: Option.none(),
      topProjects: 10,
      samplesPerProject: 25,
      windowDays: 7,
      out: Option.some(outputDirectory),
      json: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeContext.layer, dexDiscoveryClientLive(), protocolCandidateRepositoryLive)
      ),
      Effect.runPromise
    )
    const liveImportCount = importedObservations.length

    const replayResult = await crawlSolanaProgram({
      startDate: Option.none(),
      endDate: Option.none(),
      fromFile: Option.some(
        `${outputDirectory}/${solanaDuneDexProjectRankingsFileName({ startDate: "2024-01-01", endDate: "2024-01-08" })}`
      ),
      topProjects: 10,
      samplesPerProject: 25,
      windowDays: 7,
      out: Option.none(),
      json: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeContext.layer, deadDuneClientLive, protocolCandidateRepositoryLive)
      ),
      Effect.runPromise
    )

    expect(replayResult.replayedFromFile).toBe(
      `${outputDirectory}/${solanaDuneDexProjectRankingsFileName({ startDate: "2024-01-01", endDate: "2024-01-08" })}`
    )
    expect(replayResult.dexProjectRankings.entries).toEqual(
      liveResult.dexProjectRankings.entries.map((entry) => ({
        ...entry,
        sampleSignatures: [...entry.sampleSignatures],
      }))
    )
    expect(importedObservations).toHaveLength(liveImportCount * 2)
    expect(importedObservations.slice(liveImportCount).map((o) => o.subjectIdentifier)).toEqual(
      importedObservations.slice(0, liveImportCount).map((o) => o.subjectIdentifier)
    )
  })

  it("rejects date flags combined with a replay file", async () => {
    const result = await Effect.runPromiseExit(
      crawlSolanaProgram({
        startDate: Option.some("2024-01-01"),
        endDate: Option.none(),
        fromFile: Option.some("/tmp/some-rankings.json"),
        topProjects: 10,
        samplesPerProject: 25,
        windowDays: 7,
        out: Option.none(),
        json: true,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeContext.layer,
            dexDiscoveryClientLive(),
            Layer.succeed(
              ProtocolCandidateRepository,
              ProtocolCandidateRepository.of({
                importObservations: () => Effect.dieMessage("must not import"),
              })
            )
          )
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("do not pass `--start-date` or `--end-date`")
    }
  })

  it("fails a replay when the file has no recorded execution for a window", async () => {
    const result = await Effect.runPromiseExit(
      buildSolanaDexDiscoveryFile({
        generatedAt: "2026-06-12T00:00:00.000Z",
        startDate: "2024-01-01",
        endDate: "2024-01-08",
        topProjects: 10,
        samplesPerProject: 0,
        windowDays: 7,
      }).pipe(Effect.provideService(SolanaDuneClient, solanaDuneClientFromRecordedExecutions([])))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("No recorded Dune execution")
    }
  })
})
