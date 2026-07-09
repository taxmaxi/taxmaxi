import * as React from "react"

import { cn } from "#/lib/utils"

const widthClasses = {
  xs: "max-w-[var(--content-width-xs)]",
  sm: "max-w-[var(--content-width-sm)]",
  md: "max-w-[var(--content-width-md)]",
  lg: "max-w-[var(--content-width-lg)]",
  xl: "max-w-[var(--content-width-xl)]",
  "2xl": "max-w-[var(--content-width-2xl)]",
  reading: "max-w-[var(--content-width-reading)]",
} as const

type ContentContainerElement = "article" | "div" | "footer" | "header" | "main" | "nav" | "section"

type ContentContainerProps = React.HTMLAttributes<HTMLElement> & {
  as?: ContentContainerElement
  width?: keyof typeof widthClasses
}

export function ContentContainer({
  as: Comp = "div",
  className,
  width = "xl",
  ...props
}: ContentContainerProps) {
  return (
    <Comp
      className={cn("mx-auto w-full px-6 sm:px-8", widthClasses[width], className)}
      {...props}
    />
  )
}
