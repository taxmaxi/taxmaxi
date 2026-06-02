#!/usr/bin/env node

import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { CrawlerCommandError } from "./CrawlerCommandError.ts"
import { crawlSolanaCommand } from "./solana-crawler.ts"

export { CrawlerCommandError } from "./CrawlerCommandError.ts"

const crawlCommand = Command.make("crawl", {}).pipe(
  Command.withDescription("Crawler commands"),
  Command.withSubcommands([crawlSolanaCommand])
)

const command = Command.make("crawler", {}).pipe(Command.withSubcommands([crawlCommand]))

const cli = Command.run(command, { name: "TaxMaxi crawler", version: "0.0.0" })

const runtimeLayer = Layer.mergeAll(NodeContext.layer)

cli(process.argv).pipe(
  Effect.catchAll((error) => {
    const markFailedExit = Effect.sync(() => {
      process.exitCode = 1
    })

    if (error instanceof CrawlerCommandError) {
      return Console.error(`Error: ${error.message}`).pipe(Effect.zipRight(markFailedExit))
    }

    return Console.error("Unexpected crawler error").pipe(Effect.zipRight(markFailedExit))
  }),
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain
)
