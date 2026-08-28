/**
 * Best-effort system clipboard writes.
 *
 * Two layers, modeled after opencode: always emit an OSC 52 escape
 * sequence (understood by most terminals, including over SSH and inside
 * tmux/screen), then pipe the text into the platform clipboard tool for
 * terminals that ignore OSC 52.
 */
import { Config, Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class ClipboardCommandError extends Data.TaggedError("ClipboardCommandError")<{
  readonly command: string
  readonly exitCode: number
}> {}

const envIsSet = (name: string): Effect.Effect<boolean> =>
  Config.string(name).pipe(
    Effect.map((value) => value.length > 0),
    Effect.orElseSucceed(() => false)
  )

const writeOsc52 = (text: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!process.stdout.isTTY) {
      return
    }
    const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
    const multiplexed = (yield* envIsSet("TMUX")) || (yield* envIsSet("STY"))
    // tmux and screen drop OSC sequences unless wrapped in a DCS passthrough.
    process.stdout.write(multiplexed ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence)
  })

const feedInto =
  (text: string) =>
  (command: string, ...args: Array<string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const childProcess = ChildProcess.make(command, args, {
        stdin: {
          stream: Stream.succeed(new TextEncoder().encode(text)),
        },
      })
      const exitCode = yield* spawner.exitCode(childProcess)

      if (exitCode !== 0) {
        return yield* new ClipboardCommandError({ command, exitCode })
      }
    })

const nativeCopy = (text: string) => {
  const run = feedInto(text)
  switch (process.platform) {
    case "darwin":
      return run("pbcopy")
    case "win32":
      return run(
        "powershell.exe",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
      )
    case "linux":
      return Effect.gen(function* () {
        const wayland = yield* envIsSet("WAYLAND_DISPLAY")
        const x11 = run("xclip", "-selection", "clipboard").pipe(
          Effect.catch(() => run("xsel", "--clipboard", "--input"))
        )
        yield* wayland ? run("wl-copy").pipe(Effect.catch(() => x11)) : x11
      })
    default:
      return Effect.void
  }
}

/**
 * Writes text to the system clipboard. The OSC 52 write always goes out;
 * the native tool write runs on top and its failures are swallowed
 * because OSC 52 already covers most terminals.
 */
export const writeClipboard = (
  text: string
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  writeOsc52(text).pipe(Effect.andThen(nativeCopy(text)), Effect.ignore)
