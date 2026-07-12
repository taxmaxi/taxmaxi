import type * as React from "react"

import { cn } from "#/lib/utils"

type ValueToneName = "neutral" | "positive" | "negative" | "warning"

export function ValueTone({ children, tone }: { children: React.ReactNode; tone: ValueToneName }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        tone === "positive" && "text-emerald-700 dark:text-emerald-300",
        tone === "negative" && "text-red-700 dark:text-red-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300"
      )}
    >
      {children}
    </span>
  )
}
