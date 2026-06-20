// Regenerates src/tui/logo.ts from the TaxMaxi brand SVG.
//
// The terminal logo is the brand falcon mark rendered with half-block glyphs
// (▀ ▄ █), which pack two vertical pixels per character cell. That keeps the
// mark's proportions correct — one character cell is about twice as tall as it
// is wide, so a naive one-cell-per-pixel rendering stretches the figure.
//
// Prerequisites (not repo dependencies; this is a manual asset step):
//   - rsvg-convert on PATH (brew install librsvg)
//   - pngjs available, e.g. run via: npx --yes --package pngjs node scripts/generate-logo.mjs
//
// Usage:
//   SVG=/path/to/taxmaxi.svg node apps/cli/scripts/generate-logo.mjs
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const { PNG } = require("pngjs")

// Output pixel grid. Square mark → square pixel grid. Height must be even so
// rows pack cleanly into half-blocks; final art is GRID_W cols × GRID_H/2 rows.
const GRID_W = 40
const GRID_H = 40
const RASTER = 640 // SVG raster size before downsampling
const FILL_THRESHOLD = 0.38 // fraction of dark source pixels to light a cell
const DARK_LUMA = 135 // luminance below this counts as a figure stroke

const svgPath = process.env.SVG
if (svgPath === undefined) {
  console.error("Set SVG=/path/to/taxmaxi.svg")
  process.exit(1)
}

const pngPath = path.join(os.tmpdir(), "taxmaxi-logo-raster.png")
execFileSync("rsvg-convert", ["-w", String(RASTER), "-h", String(RASTER), svgPath, "-o", pngPath])

const png = PNG.sync.read(fs.readFileSync(pngPath))
const { width: W, height: H, data } = png

const luminance = (x, y) => {
  const i = (y * W + x) * 4
  if (data[i + 3] < 128) return null // transparent
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
}

const cellIsOn = (tx, ty) => {
  const x0 = Math.floor((tx * W) / GRID_W)
  const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * W) / GRID_W))
  const y0 = Math.floor((ty * H) / GRID_H)
  const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * H) / GRID_H))
  let dark = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++
      const l = luminance(x, y)
      if (l !== null && l < DARK_LUMA) dark++
    }
  }
  return total > 0 && dark / total >= FILL_THRESHOLD
}

const bitmap = []
for (let ty = 0; ty < GRID_H; ty++) {
  const row = []
  for (let tx = 0; tx < GRID_W; tx++) row.push(cellIsOn(tx, ty))
  bitmap.push(row)
}

const lines = []
for (let ty = 0; ty < GRID_H; ty += 2) {
  let line = ""
  for (let tx = 0; tx < GRID_W; tx++) {
    const top = bitmap[ty][tx]
    const bottom = ty + 1 < GRID_H ? bitmap[ty + 1][tx] : false
    line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
  }
  lines.push(line.replace(/\s+$/, ""))
}
while (lines.length && lines[0].trim() === "") lines.shift()
while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()

const width = Math.max(...lines.map((l) => l.length))
const body = lines.map((l) => `  ${JSON.stringify(l)}`).join(",\n")
const out = `/**
 * TaxMaxi falcon mark for the TUI welcome screen.
 *
 * Rendered with half-block glyphs so the figure keeps its proportions in the
 * terminal. Generated from the brand SVG — edit the SVG and rerun
 * scripts/generate-logo.mjs rather than hand-tweaking these lines.
 */
export const LOGO_LINES: ReadonlyArray<string> = [
${body},
]

export const LOGO_WIDTH = ${width}
export const LOGO_HEIGHT = ${lines.length}
`

const target = path.join(import.meta.dirname, "..", "src", "tui", "logo.ts")
fs.writeFileSync(target, out)
console.log(`Wrote ${target} (${width}×${lines.length})`)
