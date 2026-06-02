import * as CliConfig from "@effect/cli/CliConfig"
import * as Options from "@effect/cli/Options"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import {
  extractSolanaBehaviorSample,
  SolanaBehaviorSamplerClientTestLive,
  SolanaBehaviorSamplesArtifact,
} from "../src/solana-behavior-sampler.ts"
import {
  crawlSolanaOptions,
  crawlSolanaProgram,
  SOLANA_BEHAVIOR_SAMPLES_FILE_NAME,
  DEFAULT_SOLANA_REFERENCE_DATA_DIR,
  SOLANA_PRIORITY_MAP_FILE_NAME,
  SOLANA_PRIORITY_REPORT_FILE_NAME,
  SolanaPriorityMapArtifact,
} from "../src/solana-crawler.ts"

const unusedSamplerClientLive = SolanaBehaviorSamplerClientTestLive({
  fetchTransactionBySignature: () => Effect.dieMessage("fetchTransactionBySignature should not run"),
  fetchFinalizedBlock: () => Effect.dieMessage("fetchFinalizedBlock should not run"),
})

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext | never>
): Promise<A> =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive)),
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
    await expect(
      runEffect(Schema.decodeUnknown(SolanaPriorityMapArtifact)(result.priorityMap))
    ).resolves.toEqual(result.priorityMap)
  })

  it("extracts successful behavior evidence from a transaction payload", async () => {
    const result = await Effect.runPromise(
      extractSolanaBehaviorSample({
        slot: null,
        payload: {
          slot: 42,
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
            preBalances: [2_000_000_000, 0],
            postBalances: [1_499_995_000, 500_000_000],
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
              transaction: {
                slot,
                signature: `slot-${slot}-match`,
                transaction: {
                  signatures: [`slot-${slot}-match`],
                  message: {
                    accountKeys: ["slot-account"],
                    instructions: [{ programId: "program-1" }],
                  },
                },
                meta: { err: null },
              },
            },
            {
              transaction: {
                slot,
                signature: `slot-${slot}-ignored`,
                transaction: {
                  signatures: [`slot-${slot}-ignored`],
                  message: {
                    accountKeys: ["slot-account"],
                    instructions: [{ programId: "program-2" }],
                  },
                },
                meta: { err: null },
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
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["CRAWLER_SOLANA_REFERENCE_DATA_DIR", outputDirectory]]))
      ),
      Effect.provide(Layer.mergeAll(NodeContext.layer, samplerClientLive)),
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
    await expect(
      runEffect(Schema.decodeUnknown(SolanaBehaviorSamplesArtifact)(result.behaviorSamples))
    ).resolves.toEqual(result.behaviorSamples)
  })

  it("keeps the checked-in default output under Solana sync-engine reference data", () => {
    expect(DEFAULT_SOLANA_REFERENCE_DATA_DIR).toBe(
      "packages/sync-engine/src/providers/helius-solana/reference-data"
    )
  })
})
