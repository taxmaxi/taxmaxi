import { MarketingSection, MarketingSectionHeader } from "#/components/marketing-section"
import { m } from "#/paraglide/messages"

const useCaseApiExamples = {
  taxFirms: `POST /v1/batch/classify
{
  "wallets": ["0x1a2b...", "0x3c4d..."],
  "jurisdiction": "DE"
}`,
  wallets: `GET /v1/wallets/{address}/summary
{
  "year": 2025,
  "jurisdiction": "DE"
}`,
  exchanges: `POST /v1/reports/dac8
{
  "user_id": "usr_abc123",
  "period": "2025"
}`,
  neobanks: `GET /v1/portfolios/{id}/tax-events
{
  "jurisdiction": "DE",
  "method": "FIFO"
}`,
} as const

export function UseCasesSection() {
  const cards = [
    {
      id: "tax-firms",
      title: m["useCases.cards.taxFirms.title"](),
      subtitle: m["useCases.cards.taxFirms.subtitle"](),
      description: m["useCases.cards.taxFirms.description"](),
      apiExample: useCaseApiExamples.taxFirms,
      highlight: true,
      badge: m["useCases.cards.taxFirms.badge"](),
    },
    {
      id: "wallets",
      title: m["useCases.cards.wallets.title"](),
      subtitle: m["useCases.cards.wallets.subtitle"](),
      description: m["useCases.cards.wallets.description"](),
      apiExample: useCaseApiExamples.wallets,
    },
    {
      id: "exchanges",
      title: m["useCases.cards.exchanges.title"](),
      subtitle: m["useCases.cards.exchanges.subtitle"](),
      description: m["useCases.cards.exchanges.description"](),
      apiExample: useCaseApiExamples.exchanges,
    },
    {
      id: "neobanks",
      title: m["useCases.cards.neobanks.title"](),
      subtitle: m["useCases.cards.neobanks.subtitle"](),
      description: m["useCases.cards.neobanks.description"](),
      apiExample: useCaseApiExamples.neobanks,
    },
  ]

  return (
    <MarketingSection id="use-cases" contentClassName="space-y-16">
      <MarketingSectionHeader
        eyebrow={m["useCases.eyebrow"]()}
        heading={m["useCases.title"]()}
        description={m["useCases.description"]()}
      />

      <div className="grid md:grid-cols-2 gap-6">
        {cards.map((card) => (
          <UseCaseCard
            key={card.id}
            title={card.title}
            subtitle={card.subtitle}
            description={card.description}
            apiExample={card.apiExample}
            highlight={card.highlight}
            badge={card.badge}
          />
        ))}
      </div>
    </MarketingSection>
  )
}

function UseCaseCard({
  title,
  subtitle,
  description,
  apiExample,
  highlight,
  badge,
}: {
  title: string
  subtitle: string
  description: string
  apiExample: string
  highlight?: boolean
  badge?: string
}) {
  return (
    <div
      className={`h-full rounded-2xl p-6 sm:p-8 flex flex-col ${
        highlight
          ? "bg-emerald-500/5 border border-emerald-500/20"
          : "bg-[#111d18]/50 border border-[#2a3a35]/50"
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-xl font-semibold text-[#e8f5ee] mb-1">{title}</h3>
          <p className={`text-sm ${highlight ? "text-emerald-400/80" : "text-[#6b9484]"}`}>
            {subtitle}
          </p>
        </div>
        {highlight && badge ? (
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
            {badge}
          </span>
        ) : null}
      </div>

      <p className="text-sm text-[#8ab4a3]/80 leading-relaxed mb-6 flex-1">{description}</p>

      {/* API example */}
      <div className="rounded-lg bg-[#0d1210] border border-[#2a3a35]/50 p-3 font-mono text-xs text-[#6b9484] overflow-x-auto">
        <pre className="whitespace-pre">{apiExample}</pre>
      </div>
    </div>
  )
}
