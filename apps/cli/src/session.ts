import { FileSystem, Path } from "@effect/platform"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import { CliCommandError } from "./errors.ts"

const SESSION_FILE_RELATIVE_PATH = ".config/tax/session.json"

export const CliSession = Schema.Struct({
  apiUrl: Schema.String,
  sessionToken: Schema.String,
  userId: Schema.String,
  connectedAt: Schema.String,
})
export type CliSession = typeof CliSession.Type

const CliSessionJson = Schema.parseJson(CliSession)

export const getSessionFilePath = Effect.gen(function* () {
  const path = yield* Path.Path
  return path.join(homedir(), SESSION_FILE_RELATIVE_PATH)
})

export const saveSession = (session: CliSession) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sessionFilePath = yield* getSessionFilePath
    const sessionDir = path.dirname(sessionFilePath)
    const encoded = yield* Schema.encode(CliSessionJson)(session).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to encode CLI session",
          })
      )
    )

    yield* fs.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to create CLI config directory",
          })
      )
    )

    yield* fs.writeFileString(sessionFilePath, encoded).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to persist CLI session",
          })
      )
    )
  })

export const readSession = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sessionFilePath = yield* getSessionFilePath
    const raw = yield* fs.readFileString(sessionFilePath).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "No local CLI session found. Run `tax coinbase connect` first.",
          })
      )
    )

    return yield* Schema.decodeUnknown(CliSessionJson)(raw).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "CLI session file is invalid. Run `tax coinbase connect` again.",
          })
      )
    )
  })

export const readSessionOption = () => readSession().pipe(Effect.option)

export const deleteSession = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sessionFilePath = yield* getSessionFilePath
    const exists = yield* fs.exists(sessionFilePath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return
    }

    yield* fs.remove(sessionFilePath).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to delete the local CLI session file.",
          })
      )
    )
  })
