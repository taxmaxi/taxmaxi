#!/usr/bin/env node

import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"

import { command } from "./commands/root.ts"
import { CliCommandError, getErrorMessage } from "./errors.ts"
import { launchTui, shouldLaunchTui } from "./tuiLaunch.ts"
import packageJson from "../package.json" with { type: "json" }

const cli = Command.run(command, { name: "TaxMaxi CLI", version: packageJson.version })

const program = shouldLaunchTui(process.argv) ? launchTui : cli(process.argv)

program.pipe(
  Effect.catchAll((error) => {
    const markFailedExit = Effect.sync(() => {
      process.exitCode = 1
    })

    if (error instanceof CliCommandError) {
      return Console.error(`Error: ${error.message}`).pipe(Effect.zipRight(markFailedExit))
    }

    return Console.error(`Unexpected error: ${getErrorMessage(error, "unknown")}`).pipe(
      Effect.zipRight(markFailedExit)
    )
  }),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
