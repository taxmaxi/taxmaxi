import { ArrowRight, CalendarDays, CheckCircle2, FileText } from "lucide-react"

import { CmsRichText } from "#/components/cms-rich-text"
import { Footer } from "#/components/footer"
import { LandingButton } from "#/components/landing-button"
import { Logo } from "#/components/logo"
import { PageShell } from "#/components/page-shell"
import {
  formatCmsDate,
  getCmsPagePath,
  type CmsContentPage as CmsContentPageModel,
  type PayloadLocale,
  type PayloadNewsCategory,
} from "#/integrations/payload/content"
import { localizeHref } from "#/paraglide/runtime"

const labels = {
  en: {
    accessed: "Accessed",
    article: "Article",
    author: "By",
    effective: "Effective from",
    faq: "Frequently asked questions",
    lastReviewed: "Last reviewed",
    lastUpdated: "Last updated",
    published: "Published",
    reviewedBy: "Reviewed by",
    sources: "Sources",
  },
  de: {
    accessed: "Abgerufen am",
    article: "Artikel",
    author: "Von",
    effective: "Gültig ab",
    faq: "Häufig gestellte Fragen",
    lastReviewed: "Zuletzt geprüft",
    lastUpdated: "Zuletzt aktualisiert",
    published: "Veröffentlicht",
    reviewedBy: "Geprüft von",
    sources: "Quellen",
  },
} as const satisfies Record<PayloadLocale, Record<string, string>>

const newsCategoryLabels = {
  en: {
    "general-news": "News",
    "regulatory-update": "Regulatory update",
    "exchange-update": "Exchange update",
    "blockchain-update": "Blockchain update",
    "company-news": "Company news",
    "product-launch": "Product launch",
  },
  de: {
    "general-news": "Nachrichten",
    "regulatory-update": "Regulatorisches Update",
    "exchange-update": "Börsen-Update",
    "blockchain-update": "Blockchain-Update",
    "company-news": "Unternehmensnews",
    "product-launch": "Produktneuheit",
  },
} as const satisfies Record<PayloadLocale, Record<PayloadNewsCategory, string>>

export function CmsContentPage({ page }: { readonly page: CmsContentPageModel }) {
  const text = labels[page.locale]

  return (
    <PageShell
      data-page="cms-content"
      tone="marketing"
      className="relative isolate overflow-x-clip"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-linear-to-b from-[#0d1210] via-[#111d18] to-[#0d1210]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(163,196,181,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(163,196,181,.5) 1px,transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        <CmsHeader page={page} />

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
          <article>
            <header className="mx-auto max-w-4xl text-center">
              <p className="m-0 text-sm font-semibold uppercase tracking-[0.2em] text-marketing-accent">
                {page.eyebrow ??
                  (page.category
                    ? newsCategoryLabels[page.locale][page.category]
                    : page.kind === "landing"
                      ? "TaxMaxi"
                      : text.article)}
              </p>
              <h1 className="mt-5 text-balance font-display text-4xl font-semibold leading-[1.06] text-marketing-foreground sm:text-6xl lg:text-7xl">
                {page.title}
              </h1>
              {page.excerpt ? (
                <p className="mx-auto mt-6 max-w-3xl text-pretty text-lg leading-8 text-marketing-text sm:text-xl">
                  {page.excerpt}
                </p>
              ) : null}
              <ContentDates page={page} />
              <ContentActions page={page} />
            </header>

            {page.image ? (
              <figure className="mx-auto mt-14 max-w-5xl overflow-hidden rounded-[2rem] border border-marketing-border-muted bg-marketing-surface">
                <img
                  alt={page.image.alt}
                  className="aspect-video w-full object-cover"
                  fetchPriority="high"
                  height={page.image.height}
                  src={page.image.url}
                  width={page.image.width}
                />
              </figure>
            ) : null}

            <div className="cms-rich-text mx-auto mt-14 max-w-3xl text-marketing-text">
              <CmsRichText document={page.content} locale={page.locale} />
            </div>

            {page.faqs.length > 0 ? (
              <section aria-labelledby="faq-heading" className="mx-auto mt-20 max-w-3xl">
                <h2
                  className="text-balance font-display text-3xl font-semibold text-marketing-foreground sm:text-4xl"
                  id="faq-heading"
                >
                  {text.faq}
                </h2>
                <div className="mt-8 divide-y divide-marketing-border-muted rounded-[2rem] border border-marketing-border-muted bg-marketing-surface px-6 sm:px-8">
                  {page.faqs.map((faq) => (
                    <details className="group py-2" key={faq.question}>
                      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 font-medium text-marketing-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-marketing-accent">
                        {faq.question}
                        <span aria-hidden="true" className="text-xl text-marketing-accent">
                          +
                        </span>
                      </summary>
                      <div className="cms-rich-text pb-6 text-marketing-text">
                        <CmsRichText document={faq.answer} locale={page.locale} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}

            {page.sources.length > 0 ? (
              <section aria-labelledby="sources-heading" className="mx-auto mt-16 max-w-3xl">
                <h2
                  className="font-display text-2xl font-semibold text-marketing-foreground"
                  id="sources-heading"
                >
                  {text.sources}
                </h2>
                <ol className="mt-5 space-y-3 text-sm leading-6 text-marketing-muted">
                  {page.sources.map((source) => (
                    <li key={source.url}>
                      <a
                        className="break-words underline decoration-marketing-border underline-offset-4 hover:text-marketing-foreground"
                        href={source.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {source.label}
                      </a>
                      {source.accessedAt ? (
                        <span>
                          {" "}
                          ({text.accessed}{" "}
                          <time dateTime={source.accessedAt}>
                            {formatCmsDate(source.accessedAt, page.locale)}
                          </time>
                          )
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </article>
        </main>

        <Footer />
      </div>
    </PageShell>
  )
}

function CmsHeader({ page }: { readonly page: CmsContentPageModel }) {
  return (
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
      <Logo size="small" theme="dark" />
      <nav
        aria-label="Language"
        className="flex items-center gap-1 rounded-full border border-marketing-border-muted bg-marketing-surface p-1"
      >
        {page.translations.map((translation) => {
          const active = translation.locale === page.locale
          return (
            <a
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 text-xs font-semibold uppercase transition-[background-color,color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marketing-accent ${
                active
                  ? "bg-marketing-surface-active text-marketing-foreground"
                  : "text-marketing-muted hover:text-marketing-foreground"
              }`}
              href={getCmsPagePath({ kind: page.kind, ...translation })}
              hrefLang={translation.locale}
              key={translation.locale}
            >
              {translation.locale}
            </a>
          )
        })}
      </nav>
    </header>
  )
}

function ContentDates({ page }: { readonly page: CmsContentPageModel }) {
  const text = labels[page.locale]
  const items = [
    page.publishedAt
      ? { label: text.published, value: page.publishedAt, icon: CalendarDays }
      : undefined,
    page.effectiveFrom
      ? { label: text.effective, value: page.effectiveFrom, icon: CheckCircle2 }
      : undefined,
    page.lastReviewedAt
      ? { label: text.lastReviewed, value: page.lastReviewedAt, icon: CheckCircle2 }
      : undefined,
    { label: text.lastUpdated, value: page.updatedAt, icon: FileText },
  ].filter((item) => item !== undefined)

  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-marketing-muted">
      {items.map((item) => {
        const Icon = item.icon
        return (
          <span className="inline-flex items-center gap-2" key={item.label}>
            <Icon aria-hidden="true" className="size-4" />
            {item.label} <time dateTime={item.value}>{formatCmsDate(item.value, page.locale)}</time>
          </span>
        )
      })}
      {page.author ? (
        <span>
          {text.author} {page.author}
        </span>
      ) : null}
      {page.reviewedBy ? (
        <span>
          {text.reviewedBy} {page.reviewedBy}
        </span>
      ) : null}
    </div>
  )
}

function ContentActions({ page }: { readonly page: CmsContentPageModel }) {
  if (!page.primaryCta && !page.secondaryCta) return null

  return (
    <div className="mt-9 flex flex-wrap justify-center gap-3">
      {page.primaryCta ? (
        <LandingButton asChild size="modal-action">
          <a href={contentHref(page.primaryCta.href)}>
            {page.primaryCta.label}
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </a>
        </LandingButton>
      ) : null}
      {page.secondaryCta ? (
        <LandingButton asChild size="modal-action" variant="contrast">
          <a href={contentHref(page.secondaryCta.href)}>{page.secondaryCta.label}</a>
        </LandingButton>
      ) : null}
    </div>
  )
}

function contentHref(href: string): string {
  return href.startsWith("/") ? localizeHref(href) : href
}
