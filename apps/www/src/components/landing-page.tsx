import { HeroSection } from "#/components/hero-section"
import { LandingHeader } from "#/components/landing-header"
import { ApiSection } from "#/components/api-section"
import { PricingSection } from "#/components/pricing-section"
import { Footer } from "#/components/footer"
import { PageShell } from "#/components/page-shell"
import type { BillingCatalog } from "taxmaxi"

import { ClosingCTA } from "./closing-cta"
import { CliSection } from "./cli-section"

export function LandingPage({
  billingCatalog,
}: {
  readonly billingCatalog: BillingCatalog | null
}) {
  return (
    <PageShell
      data-page="landing"
      tone="marketing"
      className="relative isolate w-full overflow-x-clip"
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

      <div className="relative z-10">
        <LandingHeader />
        <main>
          <HeroSection />
          <ApiSection />
          <CliSection />
          <PricingSection catalog={billingCatalog} />
          <ClosingCTA />
        </main>
        <Footer />
      </div>
    </PageShell>
  )
}
