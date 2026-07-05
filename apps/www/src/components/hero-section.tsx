import { ArrowRight } from "lucide-react"
import { MarketingSection, MarketingSectionHeader } from "./marketing-section"
import { LandingButton } from "#/components/landing-button"
import { m } from "#/paraglide/messages"
import TerminalInstall from "./terminal-install"

export function HeroSection() {
  return (
    <MarketingSection border={false} contentClassName="space-y-12">
      <MarketingSectionHeader
        className="mx-auto max-w-(--content-width-lg)"
        description={
          <>
            {m["hero.descriptionLead"]()}
            <br />
            <span>{m["hero.descriptionTarget"]()}</span>
          </>
        }
        descriptionSize="lead"
        heading={m["hero.title"]()}
        titleAs="h1"
        titleSize="hero"
      />

      <TerminalInstall />

      <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
        <LandingButton asChild className="group" variant="cta">
          <a href="https://calendar.app.google/PLa3mhnsHc12npbx7" rel="noreferrer" target="_blank">
            {m["hero.requestPilot"]()}
            <ArrowRight
              data-icon="inline-end"
              className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
            />
          </a>
        </LandingButton>
        <LandingButton asChild variant="contrast">
          <a href="#api">{m["hero.seeHowItWorks"]()}</a>
        </LandingButton>
      </div>
    </MarketingSection>
  )
}
