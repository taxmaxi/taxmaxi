import { compile } from "@inlang/paraglide-js"
import { fileURLToPath } from "node:url"

import { paraglideCompilerOptions } from "../../src/lib/i18n.ts"

const project = fileURLToPath(new URL("../../project.inlang", import.meta.url))
const outdir = fileURLToPath(new URL("../../src/paraglide", import.meta.url))

// Generated Paraglide output is gitignored. Tests import it directly, so compile
// from source messages before those tests run.
export const setup = async () => {
  await compile({
    project,
    outdir,
    ...paraglideCompilerOptions,
  })
}
