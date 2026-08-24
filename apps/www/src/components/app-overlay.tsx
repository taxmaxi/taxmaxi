import { useRouter } from "@tanstack/react-router"
import { X } from "lucide-react"
import { useReducedMotion } from "motion/react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { useCallback, useEffect, useState, type ReactNode } from "react"

import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { cn } from "#/lib/utils"

const EXIT_DURATION_MS = 120

/**
 * Closes a route-backed overlay without stacking history entries: go back
 * when a previous entry exists (usually the dashboard underneath), otherwise
 * replace the current entry with /app so Back cannot reopen the overlay.
 */
export function useAppOverlayClose() {
  const router = useRouter()

  return useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back()
      return
    }

    void router.navigate({ replace: true, to: "/app" })
  }, [router])
}

/**
 * Modal shell for overlay routes nested under /app. The dashboard stays
 * mounted underneath; this only draws the dimmed backdrop and the panel.
 * Radix Dialog supplies focus trapping, Escape/outside dismissal, body
 * scroll locking, and inert background content.
 *
 * Dismissal plays the exit animation first and calls onClose when it ends,
 * since the route (and this component) unmount on navigation.
 */
export function AppOverlay({
  bodyClassName = "min-h-0 flex-1 overflow-y-auto",
  children,
  closeLabel,
  icon,
  onClose,
  onOpenAutoFocus,
  subtitle,
  surfaceProps,
  title,
}: {
  readonly bodyClassName?: string
  readonly children: ReactNode
  readonly closeLabel: string
  readonly icon: ReactNode
  readonly onClose: () => void
  readonly onOpenAutoFocus?: (event: Event) => void
  readonly subtitle: string
  readonly surfaceProps?: { readonly "data-asset-catalog-surface"?: string }
  readonly title: string
}) {
  const reduceMotion = useReducedMotion()
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (open) {
      return
    }

    const timeout = window.setTimeout(onClose, reduceMotion ? 0 : EXIT_DURATION_MS)
    return () => window.clearTimeout(timeout)
  }, [onClose, open, reduceMotion])

  return (
    <DialogPrimitive.Root onOpenChange={setOpen} open={open}>
      <DialogPrimitive.Portal>
        {/* Enter uses a strong ease-out (quart, same curve as styles.css) so
            most of the motion lands in the first frames and the open feels
            instant; the exit is a faster fade with the same curve. */}
        {/* No backdrop blur here on purpose: fading a backdrop-filter layer
            over the dashboard's blurred glass surfaces re-composites the
            whole viewport every frame and drops animation frames. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)] data-closed:duration-[120ms] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
        {/* data-page keeps the app theme tokens, which are scoped to the
            /app subtree the portal escapes. */}
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center sm:p-3"
          data-page="app"
        >
          <DialogPrimitive.Content
            className="pointer-events-auto flex h-full min-h-0 w-full flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl outline-none duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)] data-closed:duration-[120ms] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-97 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98 motion-reduce:animate-none sm:h-[min(46rem,100%)] sm:max-w-5xl sm:rounded-[1.75rem] sm:ring-1 sm:ring-foreground/10"
            onOpenAutoFocus={onOpenAutoFocus}
            {...surfaceProps}
          >
            <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                  {icon}
                </span>
                <div className="min-w-0">
                  <DialogPrimitive.Title className="truncate text-sm font-medium">
                    {title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="truncate text-xs text-muted-foreground">
                    {subtitle}
                  </DialogPrimitive.Description>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="hidden text-xs text-muted-foreground md:inline">Esc</span>
                <DialogPrimitive.Close asChild>
                  <Button
                    aria-label={closeLabel}
                    className="relative before:absolute before:-inset-0.5"
                    size="icon-lg"
                    variant="secondary"
                  >
                    <X />
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </header>
            <Separator />
            <div className={cn(bodyClassName)}>{children}</div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
