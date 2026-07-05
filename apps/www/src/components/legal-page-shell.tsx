import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { Link } from "@tanstack/react-router"

import { ContentContainer } from "./content-container"
import { LegalSectionCard } from "./legal-section-card"
import { PageShell } from "./page-shell"
import { SectionHeader } from "./section-header"

type TableOfContentsItem = {
  href: string
  label: ReactNode
}

type LegalPageShellProps = {
  backLabel?: string
  backTo?: "/"
  children: ReactNode
  description?: ReactNode
  tableOfContents?: readonly TableOfContentsItem[]
  title: ReactNode
}

export function LegalPageShell({
  backLabel = "TaxMaxi",
  backTo = "/",
  children,
  description,
  tableOfContents,
  title,
}: LegalPageShellProps) {
  return (
    <PageShell tone="legal">
      <ContentContainer as="main" width="reading" className="py-8 sm:py-10">
        <div className="space-y-8">
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 text-sm text-[#8ab4a3]/70 underline-offset-4 transition-colors hover:text-[#cde4d8] hover:underline"
          >
            <ArrowLeft className="size-4" />
            {backLabel}
          </Link>

          <SectionHeader
            accent
            description={description}
            heading={title}
            titleAs="h1"
            titleSize="page"
            tone="inverse"
          />

          {tableOfContents?.length ? (
            <nav aria-label="Table of contents">
              <LegalSectionCard
                as="div"
                contentClassName="[&_ol]:list-inside [&_ol]:pl-0 [&_ol]:space-y-1"
                headingAs="h2"
                title="Table of contents"
              >
                <ol>
                  {tableOfContents.map((item) => (
                    <li key={item.href}>
                      <a href={item.href}>{item.label}</a>
                    </li>
                  ))}
                </ol>
              </LegalSectionCard>
            </nav>
          ) : null}

          <div className="space-y-6">{children}</div>
        </div>
      </ContentContainer>
    </PageShell>
  )
}
