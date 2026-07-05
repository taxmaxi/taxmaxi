import type { ReactNode } from "react"
import { Terminal as TerminalIcon } from "lucide-react"
import { m } from "#/paraglide/messages"
import { MarketingSection } from "./marketing-section"
import { Terminal, TerminalCommand, TerminalComment } from "./terminal"

const PREVIEWS = [InstallGlobally, SyncCommand, AgenticWorkflow] as const

export function CliSection() {
  const steps = [
    {
      id: "one",
      label: m["cli.steps.one.label"](),
      title: m["cli.steps.one.title"](),
      description: m["cli.steps.one.description"](),
    },
    {
      id: "two",
      label: m["cli.steps.two.label"](),
      title: m["cli.steps.two.title"](),
      description: m["cli.steps.two.description"](),
    },
    {
      id: "three",
      label: m["cli.steps.three.label"](),
      title: m["cli.steps.three.title"](),
      description: m["cli.steps.three.description"](),
    },
  ] as const

  return (
    <MarketingSection id="cli" border={true} contentClassName="space-y-16">
      <div className="grid items-start md:grid-cols-6">
        <div className="overflow-hidden md:col-span-4 space-y-28">
          {steps.map((step, index) => {
            const Preview = PREVIEWS[index] ?? InstallGlobally

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

        <div className="order-first md:order-0 md:sticky md:top-28 md:col-span-2 md:self-start">
          <div className="space-y-8 p-8 sm:p-10 lg:p-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#2a3a35] bg-[#151a18] px-4 py-2 text-xs font-medium uppercase text-[#8ab4a3]">
              <TerminalIcon className="size-4" />
              {m["cli.eyebrow"]()}
            </div>

            <div className="space-y-4">
              <h3 className="max-w-xs text-3xl font-display tracking-[-0.04em] text-off-white sm:text-4xl text-balance">
                {m["cli.stickyTitle"]()}
              </h3>
              <p className="max-w-md text-base leading-7 text-[#8ab4a3] text-pretty">
                {m["cli.stickyDescription"]()}
              </p>
            </div>
          </div>
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

function InstallGlobally() {
  return (
    <div className="relative px-6">
      <Terminal className="max-w-md">
        <div className="px-5 py-4 font-mono text-sm space-y-3">
          <div>
            <TerminalComment comment="# Install the TaxMaxi CLI" />
            <TerminalCommand command="npm i -g tax" />
          </div>
          <div>
            <TerminalComment comment="# Authenticate" />
            <TerminalCommand command="tax login" />
          </div>
        </div>
      </Terminal>
    </div>
  )
}

function SyncCommand() {
  return (
    <div className="relative px-6">
      <Terminal className="max-w-md">
        <div className="px-5 py-4 font-mono text-sm space-y-3">
          <div>
            <TerminalComment comment="# Connect any exchange or onchain wallet" />
            <TerminalCommand command="tax coinbase connect" />
          </div>
          <div>
            <TerminalComment comment="# Sync your sources" />
            <TerminalCommand command="tax coinbase sync" />
          </div>
          <div>
            <TerminalComment comment="# Calculate taxes for a given year" />
            <TerminalCommand command="tax coinbase calculate --year 2025" />
          </div>
        </div>
      </Terminal>
    </div>
  )
}

function AgenticWorkflow() {
  return (
    <div className="relative px-6">
      <Terminal className="max-w-xl">
        <div className="px-5 py-4 font-mono text-[13px] space-y-3">
          <TerminalComment comment="# Sync → calculate → LLM summary → Slack" />
          <TerminalCommand
            command={[
              "REPORT=$(tax sync --all --quiet \\",
              "  && tax calculate --year 2025 --jurisdiction germany --json)",
            ]}
          />
          <TerminalCommand
            command={[
              'claude -p "Tax report: $REPORT. \\',
              '  Summarize as a weekly Slack digest." \\',
              "  | jq -Rs '{text: .}' \\",
              '  | curl -s -H "Content-Type: application/json" \\',
              '    -d @- "$SLACK_WEBHOOK"',
            ]}
          />
          <div>
            <TerminalComment comment="# Run every Monday at 9am UTC" />
            <TerminalCommand command='(crontab -l; echo "0 9 * * 1 ./workflow.sh") | crontab -' />
          </div>
        </div>
      </Terminal>
    </div>
  )
}
