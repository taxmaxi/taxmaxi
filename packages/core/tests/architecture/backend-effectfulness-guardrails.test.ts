import { readdir } from "node:fs/promises"
import path from "node:path"
import {
  type ArrowFunction,
  type FunctionExpression,
  type Identifier,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNewExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isThrowStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast"
import { API } from "typescript/unstable/sync"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

const maintainedBackendRoots = [
  "packages/core/src",
  "packages/persistence/src",
  "packages/rest-api/src",
  "packages/sync-engine/src",
  "apps/server/src",
  "apps/worker/src",
  "apps/cli/src",
].map((relativePath) => path.resolve(repoRoot, relativePath))

const allowedDateNowCallSites = new Set([
  path.resolve(repoRoot, "packages/core/src/shared/values/Timestamp.ts"),
])

const restrictedInfrastructureImports = [
  {
    root: path.resolve(repoRoot, "packages/core/src"),
    packages: ["bullmq", "ioredis", "@my/persistence", "@my/rest-api", "@my/api"],
  },
  {
    root: path.resolve(repoRoot, "packages/persistence/src"),
    packages: ["bullmq"],
  },
  {
    root: path.resolve(repoRoot, "packages/rest-api/src"),
    packages: ["bullmq"],
  },
  {
    root: path.resolve(repoRoot, "apps/worker/src"),
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

const collectTypeScriptFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") {
          return []
        }

        return collectTypeScriptFiles(entryPath)
      }

      if (entry.isFile() && entry.name.endsWith(".ts")) {
        return [entryPath]
      }

      return []
    })
  )

  return files.flat()
}

const formatViolation = ({ filePath, line, column, message }: Violation): string =>
  `${path.relative(repoRoot, filePath)}:${line}:${column} ${message}`

const isAsyncFunctionLike = (node: Node | undefined): node is ArrowFunction | FunctionExpression =>
  node !== undefined &&
  (isArrowFunction(node) || isFunctionExpression(node)) &&
  node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true

const isIdentifierNamed = (node: Node, text: string): node is Identifier =>
  isIdentifier(node) && node.text === text

const isInside = ({ filePath, root }: { readonly filePath: string; readonly root: string }) =>
  filePath === root || filePath.startsWith(`${root}${path.sep}`)

const importMatches = ({
  imported,
  restrictedPackage,
}: {
  readonly imported: string
  readonly restrictedPackage: string
}) => imported === restrictedPackage || imported.startsWith(`${restrictedPackage}/`)

const findRestrictedImport = (filePath: string, imported: string): string | null => {
  const restriction = restrictedInfrastructureImports.find(
    ({ root, packages }) =>
      isInside({ filePath, root }) &&
      packages.some((restrictedPackage) => importMatches({ imported, restrictedPackage }))
  )

  return restriction === undefined ? null : imported
}

const analyzeFile = ({
  filePath,
  sourceFile,
}: {
  readonly filePath: string
  readonly sourceFile: SourceFile
}): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []

  const pushViolation = (node: Node, message: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({
      filePath,
      line: line + 1,
      column: character + 1,
      message,
    })
  }

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      const restrictedImport = findRestrictedImport(filePath, node.moduleSpecifier.text)

      if (restrictedImport !== null) {
        pushViolation(node, `${restrictedImport} crosses a protected backend architecture boundary`)
      }
    }

    if (
      isThrowStatement(node) &&
      node.expression !== undefined &&
      isNewExpression(node.expression) &&
      isIdentifierNamed(node.expression.expression, "Error")
    ) {
      pushViolation(node, "throw new Error is banned in maintained backend runtime code")
    }

    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const callee = node.expression

      if (
        isIdentifierNamed(callee.expression, "Effect") &&
        callee.name.text === "promise" &&
        isAsyncFunctionLike(node.arguments[0])
      ) {
        pushViolation(node, "Effect.promise(async ...) is banned; use Effect.tryPromise instead")
      }

      if (
        isIdentifierNamed(callee.expression, "Date") &&
        callee.name.text === "now" &&
        !allowedDateNowCallSites.has(filePath)
      ) {
        pushViolation(node, "Date.now() is banned in maintained backend runtime code")
      }

      if (
        isIdentifierNamed(callee.expression, "console") &&
        ["log", "info", "warn", "error", "debug"].includes(callee.name.text)
      ) {
        pushViolation(
          node,
          `console.${callee.name.text} bypasses Effect runtime observability in maintained backend code`
        )
      }
    }

    node.forEachChild(visit)
  }

  visit(sourceFile)
  return violations
}

describe("backend effectfulness guardrails", () => {
  it("blocks the runtime escape hatches called out by the backend effectfulness audit", async () => {
    const files = (await Promise.all(maintainedBackendRoots.map(collectTypeScriptFiles))).flat()
    const api = new API({ cwd: repoRoot })

    try {
      const snapshot = api.updateSnapshot({ openFiles: files })
      const violations = files
        .flatMap((filePath) => {
          const sourceFile = snapshot
            .getDefaultProjectForFile(filePath)
            ?.program.getSourceFile(filePath)

          return sourceFile === undefined
            ? [{ filePath, line: 1, column: 1, message: "TypeScript did not parse this file" }]
            : analyzeFile({ filePath, sourceFile })
        })
        .map(formatViolation)

      expect(violations).toEqual([])
    } finally {
      api.close()
    }
  }, 15_000)
})
