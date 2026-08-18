import type { ReactNode } from "react"
import { ArrowRight, Building2, Check, Plus, UserRound, UsersRound } from "lucide-react"
import type { BillingCatalog } from "taxmaxi"

import { Badge } from "#/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card"
import { LandingButton } from "#/components/landing-button"
import { MarketingSection, MarketingSectionHeader } from "#/components/marketing-section"
import { m } from "#/paraglide/messages"
import { getLocale, localizeHref } from "#/paraglide/runtime"

const PROFESSIONAL_CALL_URL = "https://calendar.app.google/PLa3mhnsHc12npbx7"

type CatalogPrice = BillingCatalog["prices"][number]

export const STRIPE_PRICE_LOOKUP_KEYS = {
  individualAnnual: "taxmaxi_annual_10k_eur",
  individualTopUp: "taxmaxi_topup_1k_eur",
  professionalAnnual: "taxmaxi_professional_annual_100k_eur",
  professionalMatter: "taxmaxi_professional_matter_annual_10k_eur",
  professionalTopUp: "taxmaxi_professional_topup_20k_eur",
  enterprisePilot: "taxmaxi_enterprise_pilot_eur",
} as const

const individualFeatures = [
  "pricing.individual.features.transactions",
  "pricing.individual.features.api",
  "pricing.individual.features.reports",
  "pricing.individual.features.auditTrail",
] as const

const professionalFeatures = [
  "pricing.professional.features.users",
  "pricing.professional.features.matters",
  "pricing.professional.features.transactions",
  "pricing.professional.features.support",
] as const

const enterpriseFeatures = [
  "pricing.enterprise.features.scope",
  "pricing.enterprise.features.procurement",
  "pricing.enterprise.features.security",
  "pricing.enterprise.features.contract",
] as const

export function PricingSection({ catalog }: { readonly catalog: BillingCatalog | null }) {
  const priceByLookupKey = new Map(catalog?.prices.map((price) => [price.lookupKey, price]))
  const individualAnnual = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.individualAnnual)
  const individualTopUp = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.individualTopUp)
  const professionalAnnual = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.professionalAnnual)
  const professionalMatter = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.professionalMatter)
  const professionalTopUp = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.professionalTopUp)
  const enterprisePilot = priceByLookupKey.get(STRIPE_PRICE_LOOKUP_KEYS.enterprisePilot)

  return (
    <MarketingSection id="pricing" contentClassName="flex flex-col gap-12">
      <MarketingSectionHeader
        eyebrow={m["pricing.eyebrow"]()}
        heading={m["pricing.title"]()}
        description={m["pricing.description"]()}
      />

      <div className="mx-auto grid w-full max-w-6xl gap-x-5 gap-y-6 xl:grid-cols-3 xl:grid-rows-[auto_auto_auto_auto]">
        <PricingPlanCard
          badge={m["pricing.individual.badge"]()}
          description={m["pricing.individual.description"]()}
          features={individualFeatures.map((key) => m[key]())}
          icon={<UserRound aria-hidden="true" />}
          lookupKey={STRIPE_PRICE_LOOKUP_KEYS.individualAnnual}
          name={m["pricing.individual.name"]()}
          price={
            individualAnnual === undefined
              ? m["pricing.individual.price"]()
              : formatCatalogPrice(individualAnnual)
          }
          priceSuffix={catalogPriceSuffix(individualAnnual, m["pricing.individual.priceSuffix"]())}
          featured
          footer={
            <>
              <LandingButton asChild className="group w-full" variant="cta">
                <a href={localizeHref("/sign-up")}>
                  {m["pricing.individual.cta"]()}
                  <ArrowRight
                    data-icon="inline-end"
                    className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
                  />
                </a>
              </LandingButton>
              <p className="text-xs leading-5 text-[#6b9484]">{m["pricing.individual.note"]()}</p>
            </>
          }
        />

        <PricingPlanCard
          badge={m["pricing.professional.badge"]()}
          description={m["pricing.professional.description"]()}
          features={professionalFeatures.map((key) => m[key]())}
          icon={<UsersRound aria-hidden="true" />}
          lookupKey={STRIPE_PRICE_LOOKUP_KEYS.professionalAnnual}
          name={m["pricing.professional.name"]()}
          price={
            professionalAnnual === undefined
              ? m["pricing.professional.price"]()
              : formatCatalogPrice(professionalAnnual)
          }
          priceSuffix={catalogPriceSuffix(
            professionalAnnual,
            m["pricing.professional.priceSuffix"]()
          )}
          footer={
            <>
              <LandingButton asChild className="group w-full" variant="contrast">
                <a href={PROFESSIONAL_CALL_URL} rel="noreferrer" target="_blank">
                  {m["pricing.professional.cta"]()}
                  <ArrowRight
                    data-icon="inline-end"
                    className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
                  />
                </a>
              </LandingButton>
              <p className="text-xs leading-5 text-[#6b9484]">{m["pricing.professional.note"]()}</p>
            </>
          }
        />

        <PricingPlanCard
          badge={m["pricing.enterprise.badge"]()}
          description={m["pricing.enterprise.description"]()}
          features={enterpriseFeatures.map((key) => m[key]())}
          icon={<Building2 aria-hidden="true" />}
          lookupKey={STRIPE_PRICE_LOOKUP_KEYS.enterprisePilot}
          name={m["pricing.enterprise.name"]()}
          price={
            enterprisePilot === undefined
              ? m["pricing.enterprise.price"]()
              : formatCatalogPrice(enterprisePilot)
          }
          priceSuffix={catalogPriceSuffix(enterprisePilot, m["pricing.enterprise.priceSuffix"]())}
          footer={
            <>
              <LandingButton asChild className="group w-full" variant="contrast">
                <a href={PROFESSIONAL_CALL_URL} rel="noreferrer" target="_blank">
                  {m["pricing.enterprise.cta"]()}
                  <ArrowRight
                    data-icon="inline-end"
                    className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
                  />
                </a>
              </LandingButton>
              <p className="text-xs leading-5 text-[#6b9484]">{m["pricing.enterprise.note"]()}</p>
            </>
          }
        />
      </div>

      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-5 flex items-center gap-3">
          <Plus aria-hidden="true" className="text-emerald-300" />
          <h3 className="font-display text-xl tracking-[-0.035em] text-[#e8f5ee]">
            {m["pricing.addOns.title"]()}
          </h3>
        </div>

        <div className="grid gap-4 md:grid-cols-3 md:grid-rows-[auto_auto]">
          <PricingAddOn
            description={m["pricing.addOns.individual.description"]()}
            lookupKey={STRIPE_PRICE_LOOKUP_KEYS.individualTopUp}
            name={m["pricing.addOns.individual.name"]()}
            price={
              individualTopUp === undefined
                ? m["pricing.addOns.individual.price"]()
                : formatCatalogPrice(individualTopUp)
            }
            suffix={catalogPriceSuffix(individualTopUp, m["pricing.addOns.individual.suffix"]())}
          />
          <PricingAddOn
            description={m["pricing.addOns.matter.description"]()}
            lookupKey={STRIPE_PRICE_LOOKUP_KEYS.professionalMatter}
            name={m["pricing.addOns.matter.name"]()}
            price={
              professionalMatter === undefined
                ? m["pricing.addOns.matter.price"]()
                : formatCatalogPrice(professionalMatter)
            }
            suffix={catalogPriceSuffix(professionalMatter, m["pricing.addOns.matter.suffix"]())}
          />
          <PricingAddOn
            description={m["pricing.addOns.professional.description"]()}
            lookupKey={STRIPE_PRICE_LOOKUP_KEYS.professionalTopUp}
            name={m["pricing.addOns.professional.name"]()}
            price={
              professionalTopUp === undefined
                ? m["pricing.addOns.professional.price"]()
                : formatCatalogPrice(professionalTopUp)
            }
            suffix={catalogPriceSuffix(
              professionalTopUp,
              m["pricing.addOns.professional.suffix"]()
            )}
          />
        </div>
      </div>

      <div className="mx-auto flex max-w-3xl flex-col gap-2 text-center text-sm leading-6 text-[#6b9484]">
        <p>
          {catalogTaxNote(catalog, {
            fallback: m["pricing.taxNote"](),
            live: m["pricing.taxNoteLive"](),
          })}
        </p>
        <p>{m["pricing.explanation"]()}</p>
      </div>
    </MarketingSection>
  )
}

function PricingPlanCard({
  badge,
  description,
  featured = false,
  features,
  footer,
  icon,
  lookupKey,
  name,
  price,
  priceSuffix,
}: {
  readonly badge: string
  readonly description: string
  readonly featured?: boolean
  readonly features: ReadonlyArray<string>
  readonly footer: ReactNode
  readonly icon: ReactNode
  readonly lookupKey: string
  readonly name: string
  readonly price: string
  readonly priceSuffix: string
}) {
  const alignmentClassName =
    "xl:row-span-4 xl:row-start-1 xl:grid xl:grid-cols-[minmax(0,1fr)] xl:grid-rows-subgrid"

  return (
    <Card
      className={
        featured
          ? `border border-emerald-400/20 bg-[linear-gradient(180deg,rgba(20,50,41,0.96),rgba(12,18,16,0.98))] text-[#e8f5ee] shadow-[0_24px_70px_rgba(9,38,29,0.32)] ring-0 ${alignmentClassName}`
          : `border border-[#2a3a35] bg-[#111d18]/70 text-[#e8f5ee] ring-0 ${alignmentClassName}`
      }
      data-stripe-lookup-key={lookupKey}
    >
      <CardHeader className="min-w-0 content-start" data-pricing-row="header">
        <CardTitle className="flex items-center gap-2 font-display text-xl tracking-[-0.035em]">
          {icon}
          {name}
        </CardTitle>
        <CardAction className="col-span-full col-start-1 row-span-1 row-start-2 justify-self-start @sm/card-header:col-span-1 @sm/card-header:col-start-2 @sm/card-header:row-start-1 @sm/card-header:justify-self-end">
          <Badge className="border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
            {badge}
          </Badge>
        </CardAction>
        <CardDescription className="col-span-full row-start-3 leading-6 text-[#8ab4a3] @sm/card-header:row-start-2">
          {description}
        </CardDescription>
      </CardHeader>

      <CardContent data-pricing-row="price">
        <div>
          <p className="font-display text-4xl tracking-[-0.05em] tabular-nums text-[#f3fbf7]">
            {price}
          </p>
          <p className="mt-2 min-h-10 text-sm leading-5 text-[#8ab4a3]">{priceSuffix}</p>
        </div>
      </CardContent>

      <CardContent data-pricing-row="features">
        <ul className="flex flex-col gap-3">
          {features.map((feature) => (
            <PricingFeature key={feature}>{feature}</PricingFeature>
          ))}
        </ul>
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-3" data-pricing-row="footer">
        {footer}
      </CardFooter>
    </Card>
  )
}

function PricingAddOn({
  description,
  lookupKey,
  name,
  price,
  suffix,
}: {
  readonly description: string
  readonly lookupKey: string
  readonly name: string
  readonly price: string
  readonly suffix: string
}) {
  return (
    <Card
      className="border border-[#2a3a35] bg-[#0d1210]/70 text-[#e8f5ee] ring-0 md:row-span-2 md:row-start-1 md:grid md:grid-cols-[minmax(0,1fr)] md:grid-rows-subgrid"
      data-stripe-lookup-key={lookupKey}
      size="sm"
    >
      <CardHeader className="min-w-0 content-start" data-pricing-row="header">
        <CardTitle className="text-base">{name}</CardTitle>
        <CardDescription className="leading-5 text-[#8ab4a3]">{description}</CardDescription>
      </CardHeader>
      <CardContent data-pricing-row="price">
        <p className="font-display text-3xl tracking-[-0.045em] tabular-nums text-[#f3fbf7]">
          {price}
        </p>
        <p className="mt-2 text-xs leading-5 text-[#6b9484]">{suffix}</p>
      </CardContent>
    </Card>
  )
}

function formatCatalogPrice(price: CatalogPrice): string {
  return new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.amountMinor / 100)
}

export function catalogPriceSuffix(price: CatalogPrice | undefined, fallback: string): string {
  if (price === undefined) return fallback
  const isGerman = getLocale() === "de"
  const unit = isGerman
    ? fallback
        .replace(/^netto\s+/i, "")
        .replace(/inklusive MwSt\.\s*/i, "")
        .replace(/,?\s*zzgl\. MwSt\. soweit anwendbar/i, "")
        .replace(/,\s*$/, "")
        .trim()
    : fallback
        .replace(/^net\s+/i, "")
        .replace(/including VAT\s*/i, "")
        .replace(/,?\s*plus VAT where applicable/i, "")
        .replace(/,\s*$/, "")
        .trim()
  const withTax = (tax: string) => (unit === "" ? tax : `${unit}, ${tax}`)
  switch (price.taxBehavior) {
    case "inclusive":
      return withTax(isGerman ? "Steuern enthalten" : "tax included")
    case "exclusive":
      return withTax(isGerman ? "zzgl. anwendbarer Steuern" : "plus applicable tax")
    case "unspecified":
      return withTax(isGerman ? "Steuern werden im Checkout angezeigt" : "tax shown at checkout")
  }
}

export function catalogTaxNote(
  catalog: BillingCatalog | null,
  copy: { readonly fallback: string; readonly live: string }
): string {
  return catalog === null ? copy.fallback : copy.live
}

function PricingFeature({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm text-[#cfe8dc]">
      <Check aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-300" />
      <span>{children}</span>
    </li>
  )
}
