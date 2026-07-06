import type { ReactNode } from "react"

import { ContentContainer } from "#/components/content-container"
import { Footer } from "#/components/footer"
import { LandingHeader } from "#/components/landing-header"
import { PageShell } from "#/components/page-shell"

export function AssetsPageShell({ children }: { readonly children: ReactNode }) {
  return (
    <PageShell
      data-page="assets"
      tone="marketing"
      className="relative isolate min-h-screen w-full overflow-x-clip"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-linear-to-b from-[#0d1210] via-[#111d18] to-[#0d1210]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(rgba(163, 196, 181, 0.5) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(163, 196, 181, 0.5) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        <LandingHeader />
        <ContentContainer as="main" className="flex flex-1 flex-col py-28 sm:py-32" width="xl">
          {children}
        </ContentContainer>
        <Footer />
      </div>
    </PageShell>
  )
}
