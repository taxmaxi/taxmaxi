import type { ReactNode } from "react"

import { PageShell } from "#/components/page-shell"
import { cn } from "#/lib/utils"

export const appSurfaceClassName =
  "border border-marketing-border text-marketing-foreground ring-0 [background:var(--app-content-background)] [box-shadow:var(--app-content-shadow)] supports-[backdrop-filter]:backdrop-blur-[48px]"

export const appPanelClassName =
  "rounded-2xl bg-card text-card-foreground [box-shadow:var(--app-panel-shadow)] supports-[backdrop-filter]:backdrop-blur-[24px]"

export function AppWorkspace({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <PageShell
      as="main"
      className={cn(
        "relative isolate min-h-screen w-full overflow-x-clip bg-[var(--app-page-fallback)] text-marketing-text",
        className
      )}
      data-page="app"
      tone="marketing"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 [background:var(--app-page-background)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: `linear-gradient(var(--app-grid-line) 1px, transparent 1px),
                           linear-gradient(90deg, var(--app-grid-line) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />
      <div className="relative z-10">{children}</div>
    </PageShell>
  )
}
