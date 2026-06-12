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
  crawlSolanaBehaviorOptions,
  crawlSolanaBehaviorProgram,
  SOLANA_BEHAVIOR_SAMPLES_FILE_NAME,
  DEFAULT_SOLANA_REFERENCE_DATA_DIR,
} from "../src/solana-crawler.ts"
import { readSolanaBehaviorSamplerClientConfig } from "../src/solana-behavior-sampler-live.ts"
import { readSolanaDuneApiKey } from "../src/solana-dune-client-live.ts"

const unusedSamplerClientLive = SolanaBehaviorSamplerClientTestLive({
  fetchTransactionBySignature: () =>
    Effect.dieMessage("fetchTransactionBySignature should not run"),
  fetchFinalizedBlock: () => Effect.dieMessage("fetchFinalizedBlock should not run"),
})

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext | SolanaBehaviorSamplerClient>
): Promise<A> =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive)),
    Effect.runPromise
  )

const parseOptions = (args: ReadonlyArray<string>) =>
  Options.processCommandLine(crawlSolanaBehaviorOptions, args, CliConfig.defaultConfig).pipe(
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
    expect(Option.getOrNull(result.parsed.out)).toBe("tmp/reference-data")
    expect(result.parsed.json).toBe(true)
    expect(result.parsed.signatures).toEqual(["sig-1", "sig-2"])
    expect(result.parsed.programs).toEqual(["program-1"])
    expect(Option.getOrNull(result.parsed.fromSlot)).toBe(10)
    expect(Option.getOrNull(result.parsed.toSlot)).toBe(12)
    expect(result.parsed.sampleLimit).toBe(7)
  })

  it("requires a signature or slot range before sampling", async () => {
    const result = await Effect.runPromiseExit(
      crawlSolanaBehaviorProgram({
        out: Option.none(),
        json: true,
        signatures: [],
        programs: [],
        fromSlot: Option.none(),
        toSlot: Option.none(),
        sampleLimit: 100,
      }).pipe(Effect.provide(Layer.mergeAll(NodeContext.layer, unusedSamplerClientLive)))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain(
        "Provide `--signature` values or a `--from-slot`/`--to-slot` range"
      )
    }
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

    const result = await crawlSolanaBehaviorProgram({
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
    expect(result.behaviorSamples.sampling).toEqual({
      signatures: ["direct-signature"],
      programs: ["program-1"],
      slotRange: { fromSlot: 10, toSlot: 10 },
      sampleLimit: 10,
    })
    expect(result.behaviorSamples.samples.map((sample) => sample.signature)).toEqual([
      "direct-signature",
      "slot-10-match",
    ])
    expect(result.behaviorSamples.samples[1]?.status).toEqual({ ok: true, error: null })
    expect(result.behaviorSamples.samples[1]?.nativeBalanceDeltas).toEqual([
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

  it("keeps the checked-in default output under Solana sync-engine reference data", () => {
    expect(DEFAULT_SOLANA_REFERENCE_DATA_DIR).toBe(
      "packages/sync-engine/src/providers/helius-solana/reference-data"
    )
  })
})
