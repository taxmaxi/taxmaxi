import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "#/lib/utils"

const pageShellVariants = cva("flex w-full flex-col", {
  variants: {
    tone: {
      default: "min-h-full bg-background text-foreground",
      auth: "min-h-screen bg-[#f5f2e8] text-[#1e4d40] dark:bg-[#1a1f1d] dark:text-[#f7f0e3]",
      legal: "min-h-screen bg-[#1a1f1d] text-[#a3c4b5]",
      marketing: "min-h-screen bg-[#0d1210] text-[#cde4d8]",
    },
  },
  defaultVariants: {
    tone: "default",
  },
})

type PageShellElement = "div" | "main"

type PageShellProps = React.HTMLAttributes<HTMLElement> &
  VariantProps<typeof pageShellVariants> & {
    as?: PageShellElement
  }

export function PageShell({
  as: Comp = "div",
  className,
  tone = "default",
  ...props
}: PageShellProps) {
  return (
    <Comp
      data-slot="page-shell"
      data-tone={tone}
      className={cn(pageShellVariants({ tone }), className)}
      {...props}
    />
  )
}
