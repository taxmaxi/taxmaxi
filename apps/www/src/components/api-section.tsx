import type { ReactNode } from "react"
import { Cloud } from "lucide-react"
import { MarketingSection } from "#/components/marketing-section"
import { m } from "#/paraglide/messages"
import { IngestionGraph } from "./ingestion-graph"
import { OptimizationGraph } from "./optimization-graph"
import { PipelineGraph } from "./pipeline-graph"

const PREVIEWS = [RawIngestion, JurisdictionMapping, ReportPreview] as const

export function ApiSection() {
  const steps = [
    {
      id: "one",
      label: m["api.steps.one.label"](),
      title: m["api.steps.one.title"](),
      description: m["api.steps.one.description"](),
    },
    {
      id: "two",
      label: m["api.steps.two.label"](),
      title: m["api.steps.two.title"](),
      description: m["api.steps.two.description"](),
    },
    {
      id: "three",
      label: m["api.steps.three.label"](),
      title: m["api.steps.three.title"](),
      description: m["api.steps.three.description"](),
    },
  ] as const

  return (
    <MarketingSection id="api" border={true} contentClassName="space-y-16">
      <div className="grid items-start md:grid-cols-6">
        <div className="md:sticky md:top-28 md:col-span-2 md:self-start">
          <div className="space-y-8 p-8 sm:p-10 lg:p-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#2a3a35] bg-[#151a18] px-4 py-2 text-xs font-medium uppercase text-[#8ab4a3]">
              <Cloud className="size-4" />
              {m["api.eyebrow"]()}
            </div>

            <div className="space-y-4">
              <h3 className="max-w-xs text-3xl font-display tracking-[-0.04em] text-off-white sm:text-4xl text-balance">
                {m["api.stickyTitle"]()}
              </h3>
              <p className="max-w-md text-base leading-7 text-[#8ab4a3] text-pretty">
                {m["api.stickyDescription"]()}
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-hidden md:col-span-4 space-y-28">
          {steps.map((step, index) => {
            const Preview = PREVIEWS[index] ?? ReportPreview

            return (
              <StepCard
                key={step.id}
                description={step.description}
                label={step.label}
                title={step.title}
              >
                <Preview />
              </StepCard>
            )
          })}
        </div>
      </div>
    </MarketingSection>
  )
}

function StepCard({
  children,
  description,
  label,
  title,
}: {
  children: ReactNode
  description: string
  label: string
  title: string
}) {
  return (
    <article className="relative">
      {children}
      <div className="px-6 py-6 sm:px-8 sm:py-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#6b9484]">
          {label}
        </p>
        <h4 className="mt-3 max-w-2xl text-2xl font-display tracking-[-0.04em] text-off-white text-balance">
          {title}
        </h4>
        <p className="mt-3 max-w-2xl text-base leading-7 text-[#8ab4a3] text-pretty">
          {description}
        </p>
      </div>
    </article>
  )
}

function RawIngestion() {
  return (
    <div className="relative px-8 py-4">
      <IngestionGraph />
    </div>
  )
}

function JurisdictionMapping() {
  return (
    <div className="relative px-8">
      <PipelineGraph />
    </div>
  )
}

function ReportPreview() {
  return (
    <div className="relative px-8 py-4">
      <OptimizationGraph />
    </div>
  )
}
