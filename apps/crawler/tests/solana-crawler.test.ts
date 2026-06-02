import * as CliConfig from "@effect/cli/CliConfig"
import * as Options from "@effect/cli/Options"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Option, Schema } from "effect"
import {
  crawlSolanaOptions,
  crawlSolanaProgram,
  DEFAULT_SOLANA_REFERENCE_DATA_DIR,
  SOLANA_PRIORITY_MAP_FILE_NAME,
  SOLANA_PRIORITY_REPORT_FILE_NAME,
  SolanaPriorityMapArtifact,
} from "../src/solana-crawler.ts"

const runEffect = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>): Promise<A> =>
  effect.pipe(Effect.provide(NodeContext.layer), Effect.runPromise)

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
      ])
    )

    expect(result.rest).toEqual([])
    expect(Option.getOrNull(result.parsed.fromYear)).toBe(2020)
    expect(Option.getOrNull(result.parsed.toYear)).toBe(2025)
    expect(result.parsed.top).toBe(25)
    expect(Option.getOrNull(result.parsed.out)).toBe("tmp/reference-data")
    expect(result.parsed.json).toBe(true)
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
    await expect(
      runEffect(Schema.decodeUnknown(SolanaPriorityMapArtifact)(result.priorityMap))
    ).resolves.toEqual(result.priorityMap)
  })

  it("keeps the checked-in default output under Solana sync-engine reference data", () => {
    expect(DEFAULT_SOLANA_REFERENCE_DATA_DIR).toBe(
      "packages/sync-engine/src/providers/helius-solana/reference-data"
    )
  })
})
