import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, type PlatformError } from "effect"
import { parseSync, type Span, Visitor } from "oxc-parser"

const maintainedBackendRootPaths = [
  "packages/core/src",
  "packages/persistence/src",
  "packages/rest-api/src",
  "packages/sync-engine/src",
  "apps/server/src",
  "apps/worker/src",
  "apps/cli/src",
] as const

const restrictedInfrastructureImportPaths = [
  {
    root: "packages/core/src",
    packages: ["bullmq", "ioredis", "@my/persistence", "@my/rest-api", "@my/api"],
  },
  {
    root: "packages/persistence/src",
    packages: ["bullmq"],
  },
  {
    root: "packages/rest-api/src",
    packages: ["bullmq"],
  },
  {
    root: "apps/worker/src",
    // `server` is the legacy app package name from apps/server/package.json.
    packages: ["server", "@my/api"],
  },
] as const

interface Violation {
  readonly filePath: string
  readonly line: number
  readonly column: number
  readonly message: string
}

const importMatches = ({
  imported,
  restrictedPackage,
}: {
  readonly imported: string
  readonly restrictedPackage: string
}) => imported === restrictedPackage || imported.startsWith(`${restrictedPackage}/`)

describe("backend effectfulness guardrails", () => {
  it.effect("blocks protected backend imports and direct Error throws", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = path.resolve(import.meta.dirname, "../../../..")
      const maintainedBackendRoots = maintainedBackendRootPaths.map((relativePath) =>
        path.resolve(repoRoot, relativePath)
      )
      const restrictedInfrastructureImports = restrictedInfrastructureImportPaths.map(
        ({ root, packages }) => ({ root: path.resolve(repoRoot, root), packages })
      )
      const files: Array<string> = []

      const collectTypeScriptFiles: (
        directory: string
      ) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fnUntraced(
        function* (directory) {
          const entries = yield* fileSystem.readDirectory(directory)
          for (const entry of entries) {
            if (entry === "dist" || entry === "node_modules") {
              continue
            }
            const entryPath = path.join(directory, entry)
            const info = yield* fileSystem.stat(entryPath)
            if (info.type === "Directory") {
              yield* collectTypeScriptFiles(entryPath)
            } else if (info.type === "File" && entry.endsWith(".ts")) {
              files.push(entryPath)
            }
          }
        }
      )

      const isInside = ({ filePath, root }: { readonly filePath: string; readonly root: string }) =>
        filePath === root || filePath.startsWith(`${root}${path.sep}`)

      const findRestrictedImport = (filePath: string, imported: string): string | null => {
        const restriction = restrictedInfrastructureImports.find(
          ({ root, packages }) =>
            isInside({ filePath, root }) &&
            packages.some((restrictedPackage) => importMatches({ imported, restrictedPackage }))
        )
        return restriction === undefined ? null : imported
      }

      const analyzeFile = Effect.fnUntraced(function* (filePath: string) {
        const sourceText = yield* fileSystem.readFileString(filePath)
        const parsed = parseSync(filePath, sourceText, { lang: "ts" })
        const violations: Array<Violation> = []

        const pushViolation = (span: Span, message: string): void => {
          const sourceBeforeViolation = sourceText.slice(0, span.start)
          const lines = sourceBeforeViolation.split("\n")
          violations.push({
            filePath,
            line: lines.length,
            column: (lines.at(-1)?.length ?? 0) + 1,
            message,
          })
        }

        for (const error of parsed.errors) {
          if (error.severity === "Error") {
            const start = error.labels[0]?.start ?? 0
            pushViolation({ start, end: start }, `Oxc could not parse this file: ${error.message}`)
          }
        }

        for (const imported of parsed.module.staticImports) {
          const restrictedImport = findRestrictedImport(filePath, imported.moduleRequest.value)
          if (restrictedImport !== null) {
            pushViolation(
              imported,
              `${restrictedImport} crosses a protected backend architecture boundary`
            )
          }
        }

        new Visitor({
          ThrowStatement(node) {
            if (
              node.argument.type === "NewExpression" &&
              node.argument.callee.type === "Identifier" &&
              node.argument.callee.name === "Error"
            ) {
              pushViolation(node, "throw new Error is banned in maintained backend runtime code")
            }
          },
        }).visit(parsed.program)

        return violations
      })

      for (const root of maintainedBackendRoots) {
        yield* collectTypeScriptFiles(root)
      }

      const violations: Array<string> = []
      for (const file of files) {
        const fileViolations = yield* analyzeFile(file)
        violations.push(
          ...fileViolations.map(
            ({ filePath, line, column, message }) =>
              `${path.relative(repoRoot, filePath)}:${line}:${column} ${message}`
          )
        )
      }

      expect(violations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
