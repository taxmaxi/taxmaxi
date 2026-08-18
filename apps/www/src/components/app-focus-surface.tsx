import { X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, type ReactNode } from "react"

import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { cn } from "#/lib/utils"

const SURFACE_OPEN_TRANSFORM = "translate3d(0, 0, 0) scale(1)"
const SURFACE_CLOSED_TRANSFORM = "translate3d(0, 4px, 0) scale(0.992)"
const SURFACE_ENTER_TRANSITION = { bounce: 0, duration: 0.32, type: "spring" } as const
const REDUCED_MOTION_TRANSITION = { duration: 0.15 } as const

export function AppFocusSurface({
  bodyClassName = "min-h-0 flex-1 overflow-hidden",
  children,
  closeLabel,
  icon,
  onClose,
  subtitle,
  surfaceProps,
  title,
  titleId,
}: {
  readonly bodyClassName?: string
  readonly children: ReactNode
  readonly closeLabel: string
  readonly icon: ReactNode
  readonly onClose: () => void
  readonly subtitle: string
  readonly surfaceProps?: { readonly "data-asset-catalog-surface"?: string }
  readonly title: string
  readonly titleId: string
}) {
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const surfaceVariants = useMemo(
    () => ({
      initial: {
        opacity: 0,
        transform: reduceMotion ? SURFACE_OPEN_TRANSFORM : SURFACE_CLOSED_TRANSFORM,
      },
      open: {
        opacity: 1,
        transform: SURFACE_OPEN_TRANSFORM,
        transition: reduceMotion ? REDUCED_MOTION_TRANSITION : SURFACE_ENTER_TRANSITION,
      },
    }),
    [reduceMotion]
  )

  return (
    <div
      className="relative isolate min-h-dvh overflow-hidden bg-[var(--app-page-fallback)] text-foreground"
      data-page="app"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden [background:var(--app-page-background)]"
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(var(--app-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--app-grid-line) 1px, transparent 1px)`,
            backgroundSize: "64px 64px",
          }}
        />
      </div>
      <motion.div
        aria-hidden="true"
        animate={{ opacity: 1 }}
        className="fixed inset-0 bg-foreground/20"
        initial={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.main
        animate="open"
        aria-labelledby={titleId}
        className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl outline-none sm:inset-3 sm:rounded-[1.75rem] sm:ring-1 sm:ring-foreground/10"
        initial="initial"
        style={{ transformOrigin: "calc(100% - 3rem) 2rem" }}
        variants={surfaceVariants}
        {...surfaceProps}
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              {icon}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium" id={titleId}>
                {title}
              </h1>
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground md:inline">Esc</span>
            <Button
              aria-label={closeLabel}
              className="relative before:absolute before:-inset-0.5"
              onClick={onClose}
              size="icon-lg"
              variant="secondary"
            >
              <X />
            </Button>
          </div>
        </header>
        <Separator />
        <div className={cn(bodyClassName)}>{children}</div>
      </motion.main>
    </div>
  )
}
