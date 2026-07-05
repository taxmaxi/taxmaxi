import type { ReactNode } from "react"
import { ArrowRight, Check } from "lucide-react"
import { LandingButton } from "#/components/landing-button"
import { MarketingSection, MarketingSectionHeader } from "#/components/marketing-section"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

export function PricingSection() {
  const included = [
    m["pricing.included.unit"](),
    m["pricing.included.minimum"](),
    m["pricing.included.rate"](),
    m["pricing.included.autoscale"](),
    m["pricing.included.sharedCapabilities"](),
    m["pricing.included.enterpriseSupport"](),
  ]
  const tiers = [
    {
      id: "build",
      name: m["pricing.tiers.build.name"](),
      audience: m["pricing.tiers.build.audience"](),
      price: m["pricing.tiers.build.price"](),
      priceSuffix: m["pricing.tiers.build.priceSuffix"](),
      description: m["pricing.tiers.build.description"](),
      cta: m["pricing.tiers.build.cta"](),
      stats: [
        {
          label: m["pricing.tiers.build.stats.monthlyMinimum.label"](),
          value: m["pricing.tiers.build.stats.monthlyMinimum.value"](),
        },
        {
          label: m["pricing.tiers.build.stats.includedCapacity.label"](),
          value: m["pricing.tiers.build.stats.includedCapacity.value"](),
        },
        {
          label: m["pricing.tiers.build.stats.additionalUsage.label"](),
          value: m["pricing.tiers.build.stats.additionalUsage.value"](),
        },
      ],
      features: [
        m["pricing.tiers.build.features.one"](),
        m["pricing.tiers.build.features.two"](),
        m["pricing.tiers.build.features.three"](),
        m["pricing.tiers.build.features.four"](),
      ],
      highlight: false,
    },
    {
      id: "scale",
      name: m["pricing.tiers.scale.name"](),
      audience: m["pricing.tiers.scale.audience"](),
      badge: m["pricing.tiers.scale.badge"](),
      price: m["pricing.tiers.scale.price"](),
      priceSuffix: m["pricing.tiers.scale.priceSuffix"](),
      description: m["pricing.tiers.scale.description"](),
      cta: m["pricing.tiers.scale.cta"](),
      stats: [
        {
          label: m["pricing.tiers.scale.stats.monthlyMinimum.label"](),
          value: m["pricing.tiers.scale.stats.monthlyMinimum.value"](),
        },
        {
          label: m["pricing.tiers.scale.stats.includedCapacity.label"](),
          value: m["pricing.tiers.scale.stats.includedCapacity.value"](),
        },
        {
          label: m["pricing.tiers.scale.stats.additionalUsage.label"](),
          value: m["pricing.tiers.scale.stats.additionalUsage.value"](),
        },
      ],
      features: [
        m["pricing.tiers.scale.features.one"](),
        m["pricing.tiers.scale.features.two"](),
        m["pricing.tiers.scale.features.three"](),
        m["pricing.tiers.scale.features.four"](),
      ],
      highlight: true,
    },
    {
      id: "enterprise",
      name: m["pricing.tiers.enterprise.name"](),
      audience: m["pricing.tiers.enterprise.audience"](),
      price: m["pricing.tiers.enterprise.price"](),
      priceSuffix: m["pricing.tiers.enterprise.priceSuffix"](),
      description: m["pricing.tiers.enterprise.description"](),
      cta: m["pricing.tiers.enterprise.cta"](),
      stats: [
        {
          label: m["pricing.tiers.enterprise.stats.monthlyMinimum.label"](),
          value: m["pricing.tiers.enterprise.stats.monthlyMinimum.value"](),
        },
        {
          label: m["pricing.tiers.enterprise.stats.includedCapacity.label"](),
          value: m["pricing.tiers.enterprise.stats.includedCapacity.value"](),
        },
        {
          label: m["pricing.tiers.enterprise.stats.additionalUsage.label"](),
          value: m["pricing.tiers.enterprise.stats.additionalUsage.value"](),
        },
      ],
      features: [
        m["pricing.tiers.enterprise.features.one"](),
        m["pricing.tiers.enterprise.features.two"](),
        m["pricing.tiers.enterprise.features.three"](),
        m["pricing.tiers.enterprise.features.four"](),
      ],
      highlight: false,
    },
  ]
  const overages = [
    {
      id: "effective-rate",
      label: m["pricing.overages.rows.effectiveRate.label"](),
      build: m["pricing.overages.rows.effectiveRate.build"](),
      scale: m["pricing.overages.rows.effectiveRate.scale"](),
      enterprise: m["pricing.overages.rows.effectiveRate.enterprise"](),
    },
    {
      id: "monthly-minimum",
      label: m["pricing.overages.rows.monthlyMinimum.label"](),
      build: m["pricing.overages.rows.monthlyMinimum.build"](),
      scale: m["pricing.overages.rows.monthlyMinimum.scale"](),
      enterprise: m["pricing.overages.rows.monthlyMinimum.enterprise"](),
    },
    {
      id: "included-capacity",
      label: m["pricing.overages.rows.includedCapacity.label"](),
      build: m["pricing.overages.rows.includedCapacity.build"](),
      scale: m["pricing.overages.rows.includedCapacity.scale"](),
      enterprise: m["pricing.overages.rows.includedCapacity.enterprise"](),
    },
    {
      id: "autoscaling",
      label: m["pricing.overages.rows.autoscaling.label"](),
      build: m["pricing.overages.rows.autoscaling.build"](),
      scale: m["pricing.overages.rows.autoscaling.scale"](),
      enterprise: m["pricing.overages.rows.autoscaling.enterprise"](),
    },
  ]

  return (
    <MarketingSection id="pricing" contentClassName="space-y-12">
      <MarketingSectionHeader
        eyebrow={m["pricing.eyebrow"]()}
        heading={m["pricing.title"]()}
        description={m["pricing.description"]()}
      />

      <div className="space-y-5 rounded-[28px] border border-[#2a3a35] bg-[#0d1210]/80 p-5 shadow-[0_24px_100px_rgba(0,0,0,0.24)] sm:p-6">
        <article className="relative overflow-hidden rounded-[24px] border border-[#2a3a35] bg-[#111d18]/60 p-6 sm:p-7">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.55fr)] lg:gap-10">
            <div className="flex h-full flex-col">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-display tracking-[-0.04em] text-[#e8f5ee]">
                    {m["pricing.includedLabel"]()}
                  </h3>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-[#8ab4a3]">
                    {m["pricing.billingNote"]()}
                  </p>
                </div>
              </div>
            </div>

            <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
              {included.map((item) => (
                <PricingFeature key={item}>{item}</PricingFeature>
              ))}
            </ul>
          </div>
        </article>

        <div className="grid gap-5 xl:grid-cols-3">
          {tiers.map((tier) => (
            <PricingTierCard key={tier.id} tier={tier} />
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-[#2a3a35] bg-[#111d18]/40">
        <div className="border-b border-[#2a3a35]/70 px-6 py-5 sm:px-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#6b9484]">
            {m["pricing.overages.title"]()}
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#8ab4a3]">
            {m["pricing.overages.description"]()}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="border-b border-[#2a3a35]/70 bg-[#0d1210]/75">
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-[11px] font-medium uppercase tracking-[0.24em] text-[#6b9484] sm:px-8"
                >
                  {m["pricing.overages.label"]()}
                </th>
                <th scope="col" className="px-4 py-4 text-left text-sm font-medium text-[#e8f5ee]">
                  {m["pricing.tiers.build.name"]()}
                </th>
                <th
                  scope="col"
                  className="px-4 py-4 text-left text-sm font-medium text-emerald-300"
                >
                  {m["pricing.tiers.scale.name"]()}
                </th>
                <th scope="col" className="px-4 py-4 text-left text-sm font-medium text-[#e8f5ee]">
                  {m["pricing.tiers.enterprise.name"]()}
                </th>
              </tr>
            </thead>
            <tbody>
              {overages.map((item, index) => (
                <tr
                  key={item.id}
                  className={index < overages.length - 1 ? "border-b border-[#2a3a35]/60" : ""}
                >
                  <th
                    scope="row"
                    className="px-6 py-4 text-left text-sm font-medium text-[#e8f5ee] sm:px-8"
                  >
                    {item.label}
                  </th>
                  <TableCell>{item.build}</TableCell>
                  <TableCell highlight>{item.scale}</TableCell>
                  <TableCell>{item.enterprise}</TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MarketingSection>
  )
}

type PricingTier = {
  id: string
  name: string
  audience: string
  badge?: string
  price: string
  priceSuffix: string
  description: string
  cta: string
  stats: Array<{
    label: string
    value: string
  }>
  features: string[]
  highlight: boolean
}

function PricingTierCard({ tier }: { tier: PricingTier }) {
  return (
    <article
      className={cn(
        "relative flex h-full overflow-hidden rounded-[24px] border p-6 sm:p-7",
        tier.highlight
          ? "border-emerald-500/30 bg-[linear-gradient(180deg,rgba(20,50,41,0.96),rgba(12,18,16,0.98))] shadow-[0_24px_70px_rgba(9,38,29,0.32)]"
          : "border-[#2a3a35] bg-[#111d18]/60"
      )}
    >
      {tier.highlight ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 h-24 rounded-full bg-emerald-400/10 blur-3xl"
        />
      ) : null}

      <div className="relative flex min-h-full flex-1 flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-2xl font-display tracking-[-0.04em] text-[#e8f5ee]">
                {tier.name}
              </h3>
              {tier.badge ? (
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-300">
                  {tier.badge}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-[#a3c4b5]">{tier.audience}</p>
          </div>
        </div>

        <div className="mt-8">
          <p className="text-4xl font-display tracking-[-0.05em] text-[#f3fbf7] tabular-nums">
            {tier.price}
          </p>
          <p className="mt-2 text-sm text-[#6b9484]">{tier.priceSuffix}</p>
          <p className="mt-4 text-sm leading-6 text-[#8ab4a3]">{tier.description}</p>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-[#2a3a35]/80 bg-[#0d1210]/75">
          {tier.stats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                "flex items-center justify-between gap-4 px-4 py-3 sm:px-5",
                index > 0 ? "border-t border-[#2a3a35]/70" : null
              )}
            >
              <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#6b9484]">
                {stat.label}
              </span>
              <span className="text-sm font-medium tabular-nums text-[#e8f5ee]">{stat.value}</span>
            </div>
          ))}
        </div>

        <ul className="mt-6 flex-1 space-y-3">
          {tier.features.map((feature) => (
            <PricingFeature key={feature} highlight={tier.highlight}>
              {feature}
            </PricingFeature>
          ))}
        </ul>

        <LandingButton
          asChild
          className="group mt-8 w-full"
          variant={tier.highlight ? "cta" : "contrast"}
        >
          <a href="https://calendar.app.google/PLa3mhnsHc12npbx7" rel="noreferrer" target="_blank">
            {tier.cta}
            <ArrowRight
              data-icon="inline-end"
              className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
            />
          </a>
        </LandingButton>
      </div>
    </article>
  )
}

function PricingFeature({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <Check
        className={cn("mt-0.5 h-4 w-4 shrink-0", highlight ? "text-emerald-300" : "text-[#4a6b5d]")}
      />
      <span className={highlight ? "text-[#cfe8dc]" : "text-[#8ab4a3]/85"}>{children}</span>
    </li>
  )
}

function TableCell({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <td
      className={cn(
        "px-4 py-4 text-sm tabular-nums",
        highlight ? "bg-emerald-500/5 text-[#d9f7e8]" : "text-[#a3c4b5]"
      )}
    >
      {children}
    </td>
  )
}
