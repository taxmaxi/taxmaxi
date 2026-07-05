import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "#/lib/utils"

const pageSectionVariants = cva("flex flex-col", {
  variants: {
    spacing: {
      sm: "gap-3",
      md: "gap-4",
      lg: "gap-6",
    },
  },
  defaultVariants: {
    spacing: "md",
  },
})

type PageSectionElement = "article" | "div" | "section"

type PageSectionProps = React.HTMLAttributes<HTMLElement> &
  VariantProps<typeof pageSectionVariants> & {
    as?: PageSectionElement
  }

export function PageSection({
  as: Comp = "section",
  className,
  spacing = "md",
  ...props
}: PageSectionProps) {
  return <Comp className={cn(pageSectionVariants({ spacing }), className)} {...props} />
}
