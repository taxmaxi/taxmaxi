import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"

export const openBrowser = (url: string) => {
  const command =
    process.platform === "darwin"
      ? { cmd: "open", args: [url] }
      : process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] }

  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(command.cmd, command.args, {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      yield* child.unref.pipe(Effect.asVoid)
      return true
    })
  ).pipe(Effect.orElseSucceed(() => false))
}
