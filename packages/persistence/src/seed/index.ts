/**
 * Persistence seed runner.
 *
 * @module seed
 */

import { NodeRuntime } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { PgClientLive } from "../layers/PgClientLive.ts"
import { seedSolanaReferenceData } from "./SolanaReferenceData.ts"

const program = Effect.gen(function* () {
  yield* seedSolanaReferenceData
  yield* Console.log("Persistence seed data applied.")
})

program.pipe(Effect.provide(PgClientLive), NodeRuntime.runMain)
