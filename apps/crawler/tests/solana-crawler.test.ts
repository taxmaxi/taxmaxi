import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { nextTestUuid } from "./TestUuid.ts"
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
  fetchTransactionBySignature: () => Effect.die("fetchTransactionBySignature should not run"),
  fetchFinalizedBlock: () => Effect.die("fetchFinalizedBlock should not run"),
})

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | SolanaBehaviorSamplerClient>
): Promise<A> =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, unusedSamplerClientLive)),
    Effect.runPromise
  )

const parseOptions = (args: ReadonlyArray<string>) => {
  const flags: Record<string, Array<string>> = {}

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined || !token.startsWith("--")) {
      continue
    }

    const name = token.slice(2)
    const next = args[index + 1]
    const value = next === undefined || next.startsWith("--") ? "true" : next
    flags[name] = [...(flags[name] ?? []), value]
    if (value === next) {
      index += 1
    }
  }

  const parsedArgs = { arguments: [], flags }
  return Effect.gen(function* () {
    const [, out] = yield* crawlSolanaBehaviorOptions.out.parse(parsedArgs)
    const [, json] = yield* crawlSolanaBehaviorOptions.json.parse(parsedArgs)
    const [, signatures] = yield* crawlSolanaBehaviorOptions.signatures.parse(parsedArgs)
    const [, programs] = yield* crawlSolanaBehaviorOptions.programs.parse(parsedArgs)
    const [, fromSlot] = yield* crawlSolanaBehaviorOptions.fromSlot.parse(parsedArgs)
    const [, toSlot] = yield* crawlSolanaBehaviorOptions.toSlot.parse(parsedArgs)
    const [, sampleLimit] = yield* crawlSolanaBehaviorOptions.sampleLimit.parse(parsedArgs)

    return {
      rest: parsedArgs.arguments,
      parsed: { out, json, signatures, programs, fromSlot, toSlot, sampleLimit },
    }
  })
}

describe("solana crawler", () => {
  it.effect("uses a configured Solana RPC URL without requiring a Helius API key", () =>
    Effect.gen(function* () {
      const result = yield* readSolanaBehaviorSamplerClientConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ SOLANA_RPC_URL: "http://127.0.0.1:8899" })
        )
      )

      expect(result).toEqual({
        apiKey: null,
        rpcUrl: "http://127.0.0.1:8899",
      })
    })
  )

  it.effect("uses the Helius API key with a configured Solana RPC URL when both are provided", () =>
    Effect.gen(function* () {
      const result = yield* readSolanaBehaviorSamplerClientConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/",
            HELIUS_API_KEY: "helius-key",
          })
        )
      )

      expect(result).toEqual({
        apiKey: "helius-key",
        rpcUrl: "https://mainnet.helius-rpc.com/",
      })
    })
  )

  it.effect("requires a Helius API key when no Solana RPC URL is configured", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          readSolanaBehaviorSamplerClientConfig.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))
          )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("HELIUS_API_KEY is not configured")
      }
    })
  )

  it.effect("reads a non-empty Dune API key from Effect Config", () =>
    Effect.gen(function* () {
      const result = yield* readSolanaDuneApiKey.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ DUNE_API_KEY: " dune-key " })
        )
      )

      expect(result).toBe("dune-key")
    })
  )

  it.effect("requires a non-empty Dune API key", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          readSolanaDuneApiKey.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ DUNE_API_KEY: " " })
            )
          )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("DUNE_API_KEY is empty")
      }
    })
  )

  it.effect("parses crawl solana options", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runEffect(
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
  )

  it.effect("requires a signature or slot range before sampling", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          crawlSolanaBehaviorProgram({
            out: Option.none(),
            json: true,
            signatures: [],
            programs: [],
            fromSlot: Option.none(),
            toSlot: Option.none(),
            sampleLimit: 100,
          }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, unusedSamplerClientLive)))
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain(
          "Provide `--signature` values or a `--from-slot`/`--to-slot` range"
        )
      }
    })
  )

  it.effect("extracts successful behavior evidence from a transaction payload", () =>
    Effect.gen(function* () {
      const result = yield* extractSolanaBehaviorSample({
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
  )

  it.effect("extracts failed transaction status evidence", () =>
    Effect.gen(function* () {
      const result = yield* extractSolanaBehaviorSample({
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

      expect(result.status).toEqual({
        ok: false,
        error: { InstructionError: [0, "Custom"] },
      })
      expect(result.slot).toBe(7)
    })
  )

  it.effect("marks missing transaction metadata as unknown status evidence", () =>
    Effect.gen(function* () {
      const result = yield* extractSolanaBehaviorSample({
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

      expect(result.status).toEqual({
        ok: false,
        error: "missing transaction metadata",
      })
    })
  )

  it.effect("treats missing balance deltas as empty evidence", () =>
    Effect.gen(function* () {
      const result = yield* extractSolanaBehaviorSample({
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

      expect(result.nativeBalanceDeltas).toEqual([])
      expect(result.tokenBalanceDeltas).toEqual([])
    })
  )

  it.effect("fails malformed transaction payloads with a tagged decode error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
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
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
      }
    })
  )

  it.effect("fails malformed token amount evidence with a tagged decode error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
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
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
        expect(result.cause.toString()).toContain("not-an-integer")
      }
    })
  )

  it.effect("fails non-integer lamport evidence with a tagged decode error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Effect.runPromiseExit(
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
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SolanaBehaviorPayloadDecodeError")
        expect(result.cause.toString()).toContain("preBalances[0]")
      }
    })
  )

  it.effect("writes behavior samples using injected signature and slot-range sampler data", () =>
    Effect.gen(function* () {
      const outputDirectory = `/tmp/taxmaxi-crawler-test-${nextTestUuid()}`
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

      const result = yield* Effect.promise(() =>
        crawlSolanaBehaviorProgram({
          out: Option.none(),
          json: true,
          signatures: ["direct-signature"],
          programs: ["program-1"],
          fromSlot: Option.some(10),
          toSlot: Option.some(10),
          sampleLimit: 10,
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ CRAWLER_SOLANA_REFERENCE_DATA_DIR: outputDirectory })
          ),
          Effect.provide(Layer.mergeAll(NodeServices.layer, samplerClientLive)),
          Effect.runPromise
        )
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
      yield* Effect.promise(() =>
        expect(
          runEffect(Schema.decodeEffect(SolanaBehaviorSamplesArtifact)(result.behaviorSamples))
        ).resolves.toEqual(result.behaviorSamples)
      )
    })
  )

  it("keeps the checked-in default output under Solana sync-engine reference data", () => {
    expect(DEFAULT_SOLANA_REFERENCE_DATA_DIR).toBe(
      "packages/sync-engine/src/providers/helius-solana/reference-data"
    )
  })
})
