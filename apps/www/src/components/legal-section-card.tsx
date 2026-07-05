import * as React from "react"

import { Card, CardContent } from "./ui/card"
import { Heading } from "./ui/typography"
import { cn } from "#/lib/utils"

type LegalSectionElement = "div" | "nav" | "section"

type LegalSectionCardProps = {
  as?: LegalSectionElement
  children: React.ReactNode
  className?: string
  contentClassName?: string
  headingAs?: "h2" | "h3" | "h4"
  id?: string
  title?: React.ReactNode
}

export function LegalSectionCard({
  as: Comp = "section",
  children,
  className,
  contentClassName,
  headingAs = "h2",
  id,
  title,
}: LegalSectionCardProps) {
  return (
    <Comp className={className} id={id}>
      <Card className="border border-[#2a3a35] bg-[#232a27] gap-5 rounded-lg py-5 text-sm/relaxed text-[#a3c4b5] shadow-[var(--shadow-sm)] ring-0">
        <CardContent
          className={cn(
            "space-y-4 text-sm/relaxed text-[#8ab4a3] [&_a]:underline [&_a]:decoration-[#8ab4a3]/60 [&_a]:underline-offset-4 [&_address]:not-italic [&_h3]:text-lg [&_h3]:font-medium [&_h3]:tracking-tight [&_h3]:text-[#cde4d8] [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_strong]:font-medium [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6",
            contentClassName
          )}
        >
          {title ? (
            <Heading as={headingAs} size="section" tone="brand">
              {title}
            </Heading>
          ) : null}
          {children}
        </CardContent>
      </Card>
    </Comp>
  )
}
