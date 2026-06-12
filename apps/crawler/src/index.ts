#!/usr/bin/env node

import { Command } from "@effect/cli"
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { PgClientLive, ProtocolCandidateRepositoryLive } from "@my/persistence/layers"
import { ProtocolCandidateRepository, SyncEngineStorageError } from "@my/sync-engine/services"
import { CrawlerCommandError } from "./errors.ts"
import { SolanaBehaviorSamplerClientLive } from "./solana-behavior-sampler-live.ts"
import { crawlSolanaBehaviorCommand, crawlSolanaCommand } from "./solana-crawler.ts"
import { SolanaDuneClientLive } from "./solana-dune-client-live.ts"

export { CrawlerCommandError } from "./errors.ts"

const crawlCommand = Command.make("crawl", {}).pipe(
  Command.withDescription("Crawler commands"),
  Command.withSubcommands([crawlSolanaBehaviorCommand, crawlSolanaCommand])
)

const command = Command.make("crawler", {}).pipe(Command.withSubcommands([crawlCommand]))

const cli = Command.run(command, { name: "TaxMaxi crawler", version: "0.0.0" })

const ProtocolCandidateRepositoryCliLive = Layer.succeed(
  ProtocolCandidateRepository,
  ProtocolCandidateRepository.of({
    importObservations: (params) =>
      Effect.flatMap(ProtocolCandidateRepository, (repository) =>
        repository.importObservations(params)
      ).pipe(
        Effect.provide(ProtocolCandidateRepositoryLive.pipe(Layer.provide(PgClientLive))),
        Effect.mapError(
          (error) =>
            new SyncEngineStorageError({
              operation: "protocolCandidateRepository.importObservations",
              cause: error,
            })
        )
      ),
  })
)

const runtimeLayer = Layer.mergeAll(
  NodeContext.layer,
  SolanaBehaviorSamplerClientLive,
  SolanaDuneClientLive.pipe(Layer.provide(NodeHttpClient.layer)),
  ProtocolCandidateRepositoryCliLive
)

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
