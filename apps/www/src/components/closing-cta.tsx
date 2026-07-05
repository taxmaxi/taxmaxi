import { LandingButton } from "#/components/landing-button"
import { MarketingSection, MarketingSectionHeader } from "./marketing-section"
import { ArrowRight } from "lucide-react"
import { m } from "#/paraglide/messages"

export function ClosingCTA() {
  return (
    <MarketingSection
      as="section"
      className="border-b border-[#2a3a35]/30"
      width="md"
      contentClassName="text-center"
    >
      <MarketingSectionHeader
        eyebrow={m["footer.eyebrow"]()}
        heading={m["footer.ctaTitle"]()}
        description={m["footer.ctaDescription"]()}
      />

      <div className="pt-12">
        <LandingButton asChild className="group" variant="cta">
          <a href="https://calendar.app.google/PLa3mhnsHc12npbx7" rel="noreferrer" target="_blank">
            {m["footer.requestPilot"]()}
            <ArrowRight
              data-icon="inline-end"
              className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
            />
          </a>
        </LandingButton>
      </div>
    </MarketingSection>
  )
}
