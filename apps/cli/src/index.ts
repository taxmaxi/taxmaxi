#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { command } from "./commands/root.ts"
import { CliCommandError, getErrorMessage } from "./errors.ts"
import { launchTui, shouldLaunchTui } from "./tuiLaunch.ts"
import packageJson from "../package.json" with { type: "json" }

const cli = Command.runWith(command, { version: packageJson.version })

const program = shouldLaunchTui(process.argv) ? launchTui : cli(process.argv.slice(2))

program.pipe(
  Effect.catch((error) => {
    const markFailedExit = Effect.sync(() => {
      process.exitCode = 1
    })

    if (error instanceof CliCommandError) {
      return Console.error(`Error: ${error.message}`).pipe(Effect.andThen(markFailedExit))
    }

    return Console.error(`Unexpected error: ${getErrorMessage(error, "unknown")}`).pipe(
      Effect.andThen(markFailedExit)
    )
  }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
