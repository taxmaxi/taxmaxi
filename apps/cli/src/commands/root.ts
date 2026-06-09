import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import * as Option from "effect/Option"
import { syncOnchainSourceProgram, coinbaseCommand } from "./coinbase.ts"

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output machine-readable JSON")
)
const walletAddressArgument = Args.text({ name: "wallet-address" }).pipe(
  Args.optional,
  Args.withDescription("Onchain wallet address to create and sync")
)

export const command = Command.make(
  "tax",
  {
    walletAddress: walletAddressArgument,
    json: jsonOption,
  },
  ({ walletAddress, json }) =>
    Effect.gen(function* () {
      if (Option.isSome(walletAddress)) {
        return yield* syncOnchainSourceProgram({
          walletAddress: walletAddress.value,
          json,
        })
      }

      yield* Console.log("Run `tax coinbase` or pass an onchain wallet address.")
    })
).pipe(Command.withSubcommands([coinbaseCommand]))
