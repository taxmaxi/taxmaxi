import * as React from "react"

import { cn } from "#/lib/utils"

import { ContentContainer } from "./content-container"
import { PageSection } from "./page-section"
import { SectionHeader } from "./section-header"

type MarketingSectionElement = "div" | "section"

type MarketingSectionProps = React.HTMLAttributes<HTMLElement> & {
  as?: MarketingSectionElement
  border?: boolean
  contentClassName?: string
  spacing?: "sm" | "md" | "lg"
  width?: NonNullable<React.ComponentProps<typeof ContentContainer>["width"]>
}

export function MarketingSection({
  as = "section",
  border = true,
  children,
  className,
  contentClassName,
  spacing = "lg",
  width = "xl",
  ...props
}: MarketingSectionProps) {
  return (
    <PageSection
      as={as}
      spacing={spacing}
      className={cn(
        "relative w-full py-32 sm:py-36 lg:py-40",
        border ? "border-t border-[#2a3a35]/30" : null,
        className
      )}
      {...props}
    >
      <ContentContainer width={width} className={contentClassName}>
        {children}
      </ContentContainer>
    </PageSection>
  )
}

type MarketingSectionHeaderProps = Omit<
  React.ComponentProps<typeof SectionHeader>,
  "align" | "descriptionSize" | "titleSize" | "tone"
> & {
  align?: "left" | "center"
  descriptionSize?: "body" | "bodyLg" | "bodySm" | "lead"
  titleSize?: "display" | "hero" | "page" | "section"
  tone?: "brand" | "inverse"
}

export function MarketingSectionHeader({
  align = "center",
  className,
  descriptionSize = "bodyLg",
  titleSize = "display",
  tone = "brand",
  ...props
}: MarketingSectionHeaderProps) {
  return (
    <SectionHeader
      align={align}
      className={cn(
        align === "center" ? "mx-auto max-w-(--content-width-lg)" : "max-w-(--content-width-md)",
        className
      )}
      descriptionSize={descriptionSize}
      titleSize={titleSize}
      tone={tone}
      {...props}
    />
  )
}
