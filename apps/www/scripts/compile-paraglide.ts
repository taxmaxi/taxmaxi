import { compile } from "@inlang/paraglide-js"

import { paraglideCompilerOptions } from "../src/lib/i18n.ts"

await compile({
  project: "./project.inlang",
  outdir: "./src/paraglide",
  ...paraglideCompilerOptions,
})
