import * as React from "react"

import { Eyebrow, Heading, Text } from "#/components/ui/typography"
import { cn } from "#/lib/utils"

const accentClasses = {
  default: "bg-foreground/15",
  brand: "bg-off-white",
  inverse: "bg-[#8ab4a3]",
  auth: "bg-[#1e4d40] dark:bg-[#8ab4a3]",
} as const

type SectionTone = keyof typeof accentClasses

type SectionHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  actions?: React.ReactNode
  accent?: boolean
  align?: "left" | "center"
  description?: React.ReactNode
  descriptionSize?: "body" | "bodyLg" | "bodySm" | "lead"
  eyebrow?: React.ReactNode
  heading: React.ReactNode
  titleAs?: "h1" | "h2" | "h3"
  titleSize?: "display" | "hero" | "page" | "section"
  tone?: SectionTone
}

function getDescriptionTone(tone: SectionTone): "auth" | "inverse" | "muted" {
  if (tone === "auth") {
    return "auth"
  }

  if (tone === "inverse" || tone === "brand") {
    return "inverse"
  }

  return "muted"
}

export function SectionHeader({
  actions,
  accent = false,
  align = "left",
  className,
  description,
  descriptionSize = "body",
  eyebrow,
  heading,
  titleAs = "h2",
  titleSize = "section",
  tone = "default",
  ...props
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        actions ? "sm:flex-row sm:items-end sm:justify-between" : null,
        className
      )}
      {...props}
    >
      <div className="space-y-3">
        {eyebrow ? (
          <Eyebrow align={align} tone={tone === "default" ? "muted" : tone}>
            {eyebrow}
          </Eyebrow>
        ) : null}
        <Heading align={align} as={titleAs} size={titleSize} tone={tone}>
          {heading}
        </Heading>
        {description ? (
          <Text align={align} size={descriptionSize} tone={getDescriptionTone(tone)}>
            {description}
          </Text>
        ) : null}
        {accent ? <div className={cn("h-1 w-16 rounded-full", accentClasses[tone])} /> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  )
}
