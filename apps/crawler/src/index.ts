#!/usr/bin/env node

import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { PgClientLive, ProtocolCandidateRepositoryLive } from "@my/persistence/layers"
import { CrawlerCommandError } from "./errors.ts"
import { SolanaBehaviorSamplerClientLive } from "./solana-behavior-sampler-live.ts"
import {
  crawlSolanaBehaviorCommand,
  makeCrawlSolanaCommand,
  makeCrawlSolanaReplayCommand,
} from "./solana-crawler.ts"
import { SolanaDuneClientLive } from "./solana-dune-client-live.ts"

export { CrawlerCommandError } from "./errors.ts"

const protocolCandidateRepositoryLayer = ProtocolCandidateRepositoryLive.pipe(
  Layer.provide(PgClientLive)
)

const crawlCommand = Command.make("crawl", {}).pipe(
  Command.withDescription("Crawler commands"),
  Command.withSubcommands([
    crawlSolanaBehaviorCommand,
    makeCrawlSolanaCommand(protocolCandidateRepositoryLayer),
    makeCrawlSolanaReplayCommand(protocolCandidateRepositoryLayer),
  ])
)

const command = Command.make("crawler", {}).pipe(Command.withSubcommands([crawlCommand]))

const cli = Command.runWith(command, { version: "0.0.0" })

const runtimeLayer = Layer.mergeAll(
  NodeServices.layer,
  SolanaBehaviorSamplerClientLive,
  SolanaDuneClientLive.pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
)

cli(process.argv.slice(2)).pipe(
  Effect.catch((error) => {
    const markFailedExit = Effect.sync(() => {
      process.exitCode = 1
    })

    if (Schema.is(CrawlerCommandError)(error)) {
      return Console.error(`Error: ${error.message}`).pipe(Effect.andThen(markFailedExit))
    }

    return Console.error("Unexpected crawler error").pipe(Effect.andThen(markFailedExit))
  }),
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain
)
