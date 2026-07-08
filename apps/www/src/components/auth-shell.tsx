import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { Link } from "@tanstack/react-router"

import { ContentContainer } from "#/components/content-container"
import { Logo } from "#/components/logo"
import { PageShell } from "#/components/page-shell"
import { Heading, Text } from "#/components/ui/typography"

type AuthShellProps = {
  children: ReactNode
  description?: ReactNode
  homeLabel: string
  title: ReactNode
}

export function AuthShell({ children, description, homeLabel, title }: AuthShellProps) {
  return (
    <PageShell tone="auth" className="relative overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[#d9d2bc] opacity-40 blur-3xl dark:bg-[#2a3a35]" />
        <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-[#1e4d40] opacity-10 blur-3xl dark:bg-[#8ab4a3]" />
      </div>

      <div className="absolute left-4 top-4 z-10">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-[#1e4d40] underline-offset-4 hover:underline dark:text-[#8ab4a3]"
        >
          <ArrowLeft className="size-4" />
          {homeLabel}
        </Link>
      </div>

      <ContentContainer width="xs" className="relative flex min-h-screen items-center py-16">
        <div className="w-full">
          <div className="mb-4 flex items-center justify-center">
            <Logo size="large" />
          </div>

          <div className="mb-6 text-center">
            <Heading align="center" as="h1" size="page" tone="auth">
              {title}
            </Heading>
            {description ? (
              <Text align="center" className="mt-1" size="bodySm" tone="auth">
                {description}
              </Text>
            ) : null}
          </div>

          {children}
        </div>
      </ContentContainer>
    </PageShell>
  )
}
