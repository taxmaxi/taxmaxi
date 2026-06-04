import * as CliConfig from "@effect/cli/CliConfig"
import * as Options from "@effect/cli/Options"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import {
  extractSolanaBehaviorSample,
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplerClientTestLive,
  SolanaBehaviorSamplesArtifact,
} from "../src/solana-behavior-sampler.ts"
import {
  crawlSolanaOptions,
  crawlSolanaProgram,
  SOLANA_BEHAVIOR_SAMPLES_FILE_NAME,
  DEFAULT_SOLANA_REFERENCE_DATA_DIR,
  SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME,
  SOLANA_PRIORITY_MAP_FILE_NAME,
  SOLANA_PRIORITY_REPORT_FILE_NAME,
  SolanaPriorityMapArtifact,
} from "../src/solana-crawler.ts"
import { readSolanaBehaviorSamplerClientConfig } from "../src/solana-behavior-sampler-live.ts"
import {
  SolanaDuneProgramRankingClient,
  SolanaDuneProgramRankingClientTestLive,
  SolanaDuneProgramRankingError,
  SolanaDuneProgramRankingsArtifact,
} from "../src/solana-dune-program-ranking.ts"
import { readSolanaDuneApiKey } from "../src/solana-dune-program-ranking-live.ts"

const unusedSamplerClientLive = SolanaBehaviorSamplerClientTestLive({
  fetchTransactionBySignature: () =>
    Effect.dieMessage("fetchTransactionBySignature should not run"),
  fetchFinalizedBlock: () => Effect.dieMessage("fetchFinalizedBlock should not run"),
})

const unusedDuneClientLive = SolanaDuneProgramRankingClientTestLive({
  executeQuery: () => Effect.dieMessage("executeQuery should not run"),
})

const runEffect = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    NodeContext.NodeContext | SolanaBehaviorSamplerClient | SolanaDuneProgramRankingClient
  >
): Promise<A> =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive, unusedDuneClientLive)
    ),
    Effect.runPromise
  )

const parseOptions = (args: ReadonlyArray<string>) =>
  Options.processCommandLine(crawlSolanaOptions, args, CliConfig.defaultConfig).pipe(
    Effect.flatMap(([validationError, rest, parsed]) =>
      Option.match(validationError, {
        onNone: () => Effect.succeed({ rest, parsed }),
        onSome: Effect.fail,
      })
    )
  )

describe("solana crawler", () => {
  it("uses a configured Solana RPC URL without requiring a Helius API key", async () => {
    const result = await Effect.runPromise(
      readSolanaBehaviorSamplerClientConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["SOLANA_RPC_URL", "http://127.0.0.1:8899"]]))
        )
      )
    )

    expect(result).toEqual({
      apiKey: null,
      rpcUrl: "http://127.0.0.1:8899",
    })
  })

  it("uses the Helius API key with a configured Solana RPC URL when both are provided", async () => {
    const result = await Effect.runPromise(
      readSolanaBehaviorSamplerClientConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["SOLANA_RPC_URL", "https://mainnet.helius-rpc.com/"],
              ["HELIUS_API_KEY", "helius-key"],
            ])
          )
        )
      )
    )

    expect(result).toEqual({
      apiKey: "helius-key",
      rpcUrl: "https://mainnet.helius-rpc.com/",
    })
  })

  it("requires a Helius API key when no Solana RPC URL is configured", async () => {
    const result = await Effect.runPromiseExit(
      readSolanaBehaviorSamplerClientConfig.pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("HELIUS_API_KEY is not configured")
    }
  })

  it("reads a non-empty Dune API key from Effect Config", async () => {
    const result = await Effect.runPromise(
      readSolanaDuneApiKey.pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["DUNE_API_KEY", " dune-key "]])))
      )
    )

    expect(result).toBe("dune-key")
  })

  it("requires a non-empty Dune API key", async () => {
    const result = await Effect.runPromiseExit(
      readSolanaDuneApiKey.pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["DUNE_API_KEY", " "]])))
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("DUNE_API_KEY is empty")
    }
  })

  it("parses crawl solana options", async () => {
    const result = await runEffect(
      parseOptions([
        "--from-year",
        "2020",
        "--to-year",
        "2025",
        "--top",
        "25",
        "--out",
        "tmp/reference-data",
        "--json",
        "--signature",
        "sig-1",
        "--signature",
        "sig-2",
        "--program",
        "program-1",
        "--from-slot",
        "10",
        "--to-slot",
        "12",
        "--sample-limit",
        "7",
        "--dune",
        "--dune-period",
        "quarter",
      ])
    )

    expect(result.rest).toEqual([])
    expect(Option.getOrNull(result.parsed.fromYear)).toBe(2020)
    expect(Option.getOrNull(result.parsed.toYear)).toBe(2025)
    expect(result.parsed.top).toBe(25)
    expect(Option.getOrNull(result.parsed.out)).toBe("tmp/reference-data")
    expect(result.parsed.json).toBe(true)
    expect(result.parsed.signatures).toEqual(["sig-1", "sig-2"])
    expect(result.parsed.programs).toEqual(["program-1"])
    expect(Option.getOrNull(result.parsed.fromSlot)).toBe(10)
    expect(Option.getOrNull(result.parsed.toSlot)).toBe(12)
    expect(result.parsed.sampleLimit).toBe(7)
    expect(result.parsed.dune).toBe(true)
    expect(result.parsed.dunePeriod).toBe("quarter")
  })

  it("writes empty Solana priority artifacts with the default reference-data output", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const result = await runEffect(
      crawlSolanaProgram({
        fromYear: Option.some(2021),
        toYear: Option.some(2024),
        top: 0,
        out: Option.none(),
        json: true,
        signatures: [],
        programs: [],
        fromSlot: Option.none(),
        toSlot: Option.none(),
        sampleLimit: 100,
        dune: false,
        dunePeriod: "year",
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
        )
      )
    )

    expect(result.priorityMapPath).toBe(`${outputDirectory}/${SOLANA_PRIORITY_MAP_FILE_NAME}`)
    expect(result.reportPath).toBe(`${outputDirectory}/${SOLANA_PRIORITY_REPORT_FILE_NAME}`)
    expect(result.priorityMap).toMatchObject({
      schemaVersion: 1,
      chain: "solana",
      source: "mock",
      window: {
        fromYear: 2021,
        toYear: 2024,
      },
      top: 0,
      entries: [],
    })
    expect(result.behaviorSamplesPath).toBeNull()
    expect(result.behaviorSamples).toBeNull()
    expect(result.duneProgramRankingsPath).toBeNull()
    expect(result.duneProgramRankings).toBeNull()
    await expect(
      runEffect(Schema.decodeUnknown(SolanaPriorityMapArtifact)(result.priorityMap))
    ).resolves.toEqual(result.priorityMap)
  })

  it("skips Dune queries when top is zero", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const result = await crawlSolanaProgram({
      fromYear: Option.some(2024),
      toYear: Option.some(2024),
      top: 0,
      out: Option.none(),
      json: true,
      signatures: [],
      programs: [],
      fromSlot: Option.none(),
      toSlot: Option.none(),
      sampleLimit: 100,
      dune: true,
      dunePeriod: "year",
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(
        Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive, unusedDuneClientLive)
      ),
      Effect.runPromise
    )

    expect(result.priorityMap.entries).toEqual([])
    expect(result.duneProgramRankings).toBeNull()
    expect(result.duneProgramRankingsPath).toBeNull()
  })

  it("extracts successful behavior evidence from a transaction payload", async () => {
    const result = await Effect.runPromise(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          slot: 42n,
          signature: "fixture-signature",
          type: "SWAP",
          source: "RAYDIUM",
          transaction: {
            signatures: ["fixture-signature"],
            message: {
              accountKeys: ["payer", "receiver"],
              instructions: [{ programId: "program-1" }],
            },
          },
          meta: {
            err: null,
            preBalances: [2_000_000_000n, 0],
            postBalances: [1_499_995_000n, 500_000_000],
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: "mint-1",
                owner: "owner-1",
                uiTokenAmount: { amount: "100", decimals: 2, uiAmountString: "1" },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint: "mint-1",
                owner: "owner-1",
                uiTokenAmount: { amount: "150", decimals: 2, uiAmountString: "1.5" },
              },
            ],
            innerInstructions: [{ index: 0, instructions: [{ programId: "inner-program" }] }],
          },
        },
      })
    )

    expect(result).toMatchObject({
      signature: "fixture-signature",
      slot: 42,
      status: { ok: true, error: null },
      invokedProgramIds: ["inner-program", "program-1"],
      providerLabels: { type: "SWAP", source: "RAYDIUM" },
    })
    expect(result.nativeBalanceDeltas).toEqual([
      {
        accountIndex: 0,
        account: "payer",
        preLamports: "2000000000",
        postLamports: "1499995000",
        deltaLamports: "-500005000",
      },
      {
        accountIndex: 1,
        account: "receiver",
        preLamports: "0",
        postLamports: "500000000",
        deltaLamports: "500000000",
      },
    ])
    expect(result.tokenBalanceDeltas).toEqual([
      {
        accountIndex: 0,
        owner: "owner-1",
        mint: "mint-1",
        decimals: 2,
        preAmount: "100",
        postAmount: "150",
        deltaAmount: "50",
      },
    ])
  })

  it("extracts failed transaction status evidence", async () => {
    const result = await Effect.runPromise(
      extractSolanaBehaviorSample({
        slot: 7,
        payload: {
          transaction: {
            signatures: ["failed-signature"],
            message: {
              accountKeys: [],
              instructions: [{ programId: "program-1" }],
            },
          },
          meta: {
            err: { InstructionError: [0, "Custom"] },
          },
        },
      })
    )

    expect(result.status).toEqual({
      ok: false,
      error: { InstructionError: [0, "Custom"] },
    })
    expect(result.slot).toBe(7)
  })

  it("marks missing transaction metadata as unknown status evidence", async () => {
    const result = await Effect.runPromise(
      extractSolanaBehaviorSample({
        slot: 7,
        payload: {
          transaction: {
            signatures: ["missing-meta-signature"],
            message: {
              accountKeys: [],
              instructions: [{ programId: "program-1" }],
            },
          },
        },
      })
    )

    expect(result.status).toEqual({
      ok: false,
      error: "missing transaction metadata",
    })
  })

  it("treats missing balance deltas as empty evidence", async () => {
    const result = await Effect.runPromise(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          signature: "missing-balances",
          transaction: {
            message: {
              accountKeys: [],
              instructions: [],
            },
          },
          meta: {
            err: null,
          },
        },
      })
    )

    expect(result.nativeBalanceDeltas).toEqual([])
    expect(result.tokenBalanceDeltas).toEqual([])
  })

  it("fails malformed transaction payloads with a tagged decode error", async () => {
    const result = await Effect.runPromiseExit(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          transaction: {
            message: {
              accountKeys: [],
              instructions: [],
            },
          },
          meta: {
            err: null,
          },
        },
      })
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
    }
  })

  it("fails malformed token amount evidence with a tagged decode error", async () => {
    const result = await Effect.runPromiseExit(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          transaction: {
            signatures: ["malformed-token-amount"],
            message: {
              accountKeys: [],
              instructions: [],
            },
          },
          meta: {
            err: null,
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: "mint-1",
                uiTokenAmount: { amount: "not-an-integer", decimals: 2 },
              },
            ],
            postTokenBalances: [],
          },
        },
      })
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
      expect(result.cause.toString()).toContain("not-an-integer")
    }
  })

  it("fails non-integer lamport evidence with a tagged decode error", async () => {
    const result = await Effect.runPromiseExit(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          transaction: {
            signatures: ["non-integer-lamports"],
            message: {
              accountKeys: ["account-1"],
              instructions: [],
            },
          },
          meta: {
            err: null,
            preBalances: [1.5],
            postBalances: [2],
          },
        },
      })
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
      expect(result.cause.toString()).toContain("preBalances[0]")
    }
  })

  it("writes behavior samples using injected signature and slot-range sampler data", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const samplerClientLive = SolanaBehaviorSamplerClientTestLive({
      fetchTransactionBySignature: ({ signature }) =>
        Effect.succeed({
          signature,
          source: "JUPITER",
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: ["direct-account"],
              instructions: [{ programId: "direct-program" }],
            },
          },
          meta: { err: null, preBalances: [1], postBalances: [2] },
        }),
      fetchFinalizedBlock: ({ slot }) =>
        Effect.succeed({
          transactions: [
            {
              meta: {
                err: null,
                preBalances: [10],
                postBalances: [15],
              },
              transaction: {
                signatures: [`slot-${slot}-match`],
                message: {
                  accountKeys: ["slot-account"],
                  instructions: [{ programId: "program-1" }],
                },
              },
            },
            {
              meta: { err: null },
              transaction: {
                signatures: [`slot-${slot}-ignored`],
                message: {
                  accountKeys: ["slot-account"],
                  instructions: [{ programId: "program-2" }],
                },
              },
            },
          ],
        }),
    })

    const result = await crawlSolanaProgram({
      fromYear: Option.some(2021),
      toYear: Option.some(2024),
      top: 0,
      out: Option.none(),
      json: true,
      signatures: ["direct-signature"],
      programs: ["program-1"],
      fromSlot: Option.some(10),
      toSlot: Option.some(10),
      sampleLimit: 10,
      dune: false,
      dunePeriod: "year",
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(Layer.mergeAll(NodeContext.layer, samplerClientLive, unusedDuneClientLive)),
      Effect.runPromise
    )

    expect(result.behaviorSamplesPath).toBe(
      `${outputDirectory}/${SOLANA_BEHAVIOR_SAMPLES_FILE_NAME}`
    )
    expect(result.behaviorSamples?.sampling).toEqual({
      signatures: ["direct-signature"],
      programs: ["program-1"],
      slotRange: { fromSlot: 10, toSlot: 10 },
      sampleLimit: 10,
    })
    expect(result.behaviorSamples?.samples.map((sample) => sample.signature)).toEqual([
      "direct-signature",
      "slot-10-match",
    ])
    expect(result.behaviorSamples?.samples[1]?.status).toEqual({ ok: true, error: null })
    expect(result.behaviorSamples?.samples[1]?.nativeBalanceDeltas).toEqual([
      {
        accountIndex: 0,
        account: "slot-account",
        preLamports: "10",
        postLamports: "15",
        deltaLamports: "5",
      },
    ])
    await expect(
      runEffect(Schema.decodeUnknown(SolanaBehaviorSamplesArtifact)(result.behaviorSamples))
    ).resolves.toEqual(result.behaviorSamples)
  })

  it("writes Dune ranking artifacts using decoded saved-query rows", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const duneClientLive = SolanaDuneProgramRankingClientTestLive({
      executeQuery: ({ parameters, query }) => {
        if (query.kind === "program-sample-transactions") {
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: {
              rows: [
                { tx_id: `${parameters.program_id}-sample-1` },
                { tx_id: `${parameters.program_id}-sample-2` },
              ],
            },
          })
        }

        if (query.kind === "dex-project-priority") {
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: {
              rows: [
                {
                  project: "jupiter",
                  period: "2024-01-01 to 2025-01-01",
                  retrieved_at: "2026-01-01T00:00:00Z",
                  approx_unique_traders: "2",
                  approx_trade_transactions: "3",
                  trade_rows: "5",
                  canonical_program_ids: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
                },
              ],
            },
          })
        }

        return Effect.succeed({
          state: "QUERY_STATE_COMPLETED",
          result: {
            rows: [
              {
                program_id: "ProgramCandidate111111111111111111111111111",
                period: "2024-01-01 to 2025-01-01",
                retrieved_at: "2026-01-01T00:00:00Z",
                approx_signers: 7,
                approx_transfer_transactions: "11",
                transfer_rows: 13,
              },
            ],
          },
        })
      },
    })

    const result = await crawlSolanaProgram({
      fromYear: Option.some(2024),
      toYear: Option.some(2024),
      top: 10,
      out: Option.none(),
      json: true,
      signatures: [],
      programs: [],
      fromSlot: Option.none(),
      toSlot: Option.none(),
      sampleLimit: 100,
      dune: true,
      dunePeriod: "year",
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive, duneClientLive)),
      Effect.runPromise
    )

    expect(result.duneProgramRankingsPath).toBe(
      `${outputDirectory}/${SOLANA_DUNE_PROGRAM_RANKINGS_FILE_NAME}`
    )
    expect(result.priorityMap.source).toBe("dune")
    expect(result.priorityMap.entries.map((entry) => entry.key)).toEqual([
      "ProgramCandidate111111111111111111111111111",
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ])
    expect(result.duneProgramRankings?.queries).toEqual([
      {
        queryId: 7647495,
        queryName: "solana-dex-project-priority",
        periodGranularity: "year",
        version: 1,
        kind: "dex-project-priority",
      },
      {
        queryId: 7648079,
        queryName: "solana-token-transfer-program-candidates",
        periodGranularity: "year",
        version: 1,
        kind: "token-transfer-program-candidates",
      },
      {
        queryId: 7648230,
        queryName: "solana-program-sample-transactions",
        periodGranularity: "year",
        version: 1,
        kind: "program-sample-transactions",
      },
    ])
    expect(result.duneProgramRankings?.entries[0]).toMatchObject({
      programId: "ProgramCandidate111111111111111111111111111",
      period: "2024-01-01 to 2025-01-01",
      invocationCount: 13,
      uniqueSignerCount: 7,
      transactionCount: 11,
      sampleSignatures: [
        "ProgramCandidate111111111111111111111111111-sample-1",
        "ProgramCandidate111111111111111111111111111-sample-2",
      ],
      queryId: 7648079,
      queryName: "solana-token-transfer-program-candidates",
      periodGranularity: "year",
      queryVersion: 1,
      retrievedAt: "2026-01-01T00:00:00Z",
    })
    await expect(
      runEffect(Schema.decodeUnknown(SolanaDuneProgramRankingsArtifact)(result.duneProgramRankings))
    ).resolves.toEqual(result.duneProgramRankings)
  })

  it("uses quarter Dune periods and records quarter granularity", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const rankingCalls: Array<{
      readonly kind: string
      readonly parameters: Readonly<Record<string, string>>
    }> = []
    const duneClientLive = SolanaDuneProgramRankingClientTestLive({
      executeQuery: ({ parameters, query }) => {
        if (query.kind === "program-sample-transactions") {
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: { rows: [{ tx_id: "quarter-sample-signature" }] },
          })
        }

        rankingCalls.push({ kind: query.kind, parameters })

        if (query.kind === "dex-project-priority") {
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: {
              rows: [
                {
                  project: "jupiter",
                  period: `${parameters.start_date} to ${parameters.end_date}`,
                  retrieved_at: "2026-01-01T00:00:00Z",
                  approx_unique_traders: 1,
                  approx_trade_transactions: 1,
                  trade_rows: 2,
                  canonical_program_ids: ["QuarterProgram1111111111111111111111111111"],
                },
              ],
            },
          })
        }

        return Effect.succeed({
          state: "QUERY_STATE_COMPLETED",
          result: {
            rows: [
              {
                program_id: "QuarterTransfer111111111111111111111111111",
                period: `${parameters.start_date} to ${parameters.end_date}`,
                retrieved_at: "2026-01-01T00:00:00Z",
                approx_signers: 1,
                approx_transfer_transactions: 1,
                transfer_rows: 1,
              },
            ],
          },
        })
      },
    })

    const result = await crawlSolanaProgram({
      fromYear: Option.some(2024),
      toYear: Option.some(2024),
      top: 1,
      out: Option.none(),
      json: true,
      signatures: [],
      programs: [],
      fromSlot: Option.none(),
      toSlot: Option.none(),
      sampleLimit: 100,
      dune: true,
      dunePeriod: "quarter",
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive, duneClientLive)),
      Effect.runPromise
    )

    expect(result.duneProgramRankings?.queries.map((query) => query.periodGranularity)).toEqual([
      "quarter",
      "quarter",
      "quarter",
    ])
    expect(result.duneProgramRankings?.entries[0]).toMatchObject({
      period: "2024-01-01 to 2024-04-01",
      periodGranularity: "quarter",
      sampleSignatures: ["quarter-sample-signature"],
    })
    expect(rankingCalls.map((call) => call.parameters)).toEqual([
      { start_date: "2024-01-01", end_date: "2024-04-01" },
      { start_date: "2024-04-01", end_date: "2024-07-01" },
      { start_date: "2024-07-01", end_date: "2024-10-01" },
      { start_date: "2024-10-01", end_date: "2025-01-01" },
      { start_date: "2024-01-01", end_date: "2024-04-01" },
      { start_date: "2024-04-01", end_date: "2024-07-01" },
      { start_date: "2024-07-01", end_date: "2024-10-01" },
      { start_date: "2024-10-01", end_date: "2025-01-01" },
    ])
  })

  it("aggregates duplicate Dune programs before applying top", async () => {
    const outputDirectory = `/tmp/taxmaxi-crawler-test-${crypto.randomUUID()}`
    const sampleCalls: string[] = []
    const duneClientLive = SolanaDuneProgramRankingClientTestLive({
      executeQuery: ({ parameters, query }) => {
        if (query.kind === "program-sample-transactions") {
          sampleCalls.push(parameters.program_id ?? "")
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: { rows: [{ tx_id: `${parameters.program_id}-sample` }] },
          })
        }

        if (query.kind === "dex-project-priority") {
          return Effect.succeed({
            state: "QUERY_STATE_COMPLETED",
            result: {
              rows: [
                {
                  project: "shared",
                  period: `${parameters.start_date} to ${parameters.end_date}`,
                  retrieved_at: "2026-01-01T00:00:00Z",
                  approx_unique_traders: 1,
                  approx_trade_transactions: 1,
                  trade_rows: 2,
                  canonical_program_ids: ["SharedProgram11111111111111111111111111111"],
                },
              ],
            },
          })
        }

        const transferRows = parameters.start_date === "2024-01-01" ? 7 : 0
        return Effect.succeed({
          state: "QUERY_STATE_COMPLETED",
          result: {
            rows: [
              {
                program_id: "UniqueProgram11111111111111111111111111111",
                period: `${parameters.start_date} to ${parameters.end_date}`,
                retrieved_at: "2026-01-01T00:00:00Z",
                approx_signers: transferRows === 0 ? 0 : 1,
                approx_transfer_transactions: transferRows === 0 ? 0 : 1,
                transfer_rows: transferRows,
              },
            ],
          },
        })
      },
    })

    const result = await crawlSolanaProgram({
      fromYear: Option.some(2024),
      toYear: Option.some(2024),
      top: 1,
      out: Option.none(),
      json: true,
      signatures: [],
      programs: [],
      fromSlot: Option.none(),
      toSlot: Option.none(),
      sampleLimit: 100,
      dune: true,
      dunePeriod: "quarter",
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive, duneClientLive)),
      Effect.runPromise
    )

    expect(result.priorityMap.entries.map((entry) => entry.key)).toEqual([
      "SharedProgram11111111111111111111111111111",
    ])
    expect(result.duneProgramRankings?.entries[0]).toMatchObject({
      programId: "SharedProgram11111111111111111111111111111",
      invocationCount: 8,
      uniqueSignerCount: 4,
      transactionCount: 4,
    })
    expect(sampleCalls).toEqual(["SharedProgram11111111111111111111111111111"])
  })

  it("fails Dune ranking when a saved query returns no rows", async () => {
    const result = await Effect.runPromiseExit(
      crawlSolanaProgram({
        fromYear: Option.some(2024),
        toYear: Option.some(2024),
        top: 10,
        out: Option.none(),
        json: true,
        signatures: [],
        programs: [],
        fromSlot: Option.none(),
        toSlot: Option.none(),
        sampleLimit: 100,
        dune: true,
        dunePeriod: "year",
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", "/tmp/unused"]]))
        ),
        Effect.provide(
          Layer.mergeAll(
            NodeContext.layer,
            unusedSamplerClientLive,
            SolanaDuneProgramRankingClientTestLive({
              executeQuery: () =>
                Effect.succeed({ state: "QUERY_STATE_COMPLETED", result: { rows: [] } }),
            })
          )
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("returned no rows")
    }
  })

  it("fails Dune ranking when rows are malformed", async () => {
    const result = await Effect.runPromiseExit(
      crawlSolanaProgram({
        fromYear: Option.some(2024),
        toYear: Option.some(2024),
        top: 10,
        out: Option.none(),
        json: true,
        signatures: [],
        programs: [],
        fromSlot: Option.none(),
        toSlot: Option.none(),
        sampleLimit: 100,
        dune: true,
        dunePeriod: "year",
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", "/tmp/unused"]]))
        ),
        Effect.provide(
          Layer.mergeAll(
            NodeContext.layer,
            unusedSamplerClientLive,
            SolanaDuneProgramRankingClientTestLive({
              executeQuery: () =>
                Effect.succeed({
                  state: "QUERY_STATE_COMPLETED",
                  result: { rows: [{ program_id: 123 }] },
                }),
            })
          )
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("Failed to decode Dune rows")
    }
  })

  it("maps Dune API failures to structured crawler errors", async () => {
    const result = await Effect.runPromiseExit(
      crawlSolanaProgram({
        fromYear: Option.some(2024),
        toYear: Option.some(2024),
        top: 10,
        out: Option.none(),
        json: true,
        signatures: [],
        programs: [],
        fromSlot: Option.none(),
        toSlot: Option.none(),
        sampleLimit: 100,
        dune: true,
        dunePeriod: "year",
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", "/tmp/unused"]]))
        ),
        Effect.provide(
          Layer.mergeAll(
            NodeContext.layer,
            unusedSamplerClientLive,
            SolanaDuneProgramRankingClientTestLive({
              executeQuery: ({ query }) =>
                Effect.fail(
                  new SolanaDuneProgramRankingError({
                    message: "Dune API request failed (500): unavailable",
                    queryId: query.queryId,
                  })
                ),
            })
          )
        )
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("Dune API request failed")
    }
  })

  it("keeps the checked-in default output under Solana sync-engine reference data", () => {
    expect(DEFAULT_SOLANA_REFERENCE_DATA_DIR).toBe(
      "packages/sync-engine/src/providers/helius-solana/reference-data"
    )
  })
})
