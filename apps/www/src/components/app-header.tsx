import { startTransition, type ReactNode, useEffect, useRef, useState } from "react"

import { Logo } from "#/components/logo"
import ThemeToggle from "#/components/theme-toggle"
import { cn } from "#/lib/utils"

const COMPACT_SCROLL_THRESHOLD = 72

const headerWidthClasses = {
  compact: "max-w-[var(--content-width-xl)]",
  expanded: "max-w-[var(--content-width-2xl)]",
} as const

export function AppHeader({ children }: { readonly children?: ReactNode }) {
  const [isCompact, setIsCompact] = useState(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const syncHeaderState = () => {
      const nextIsCompact = window.scrollY > COMPACT_SCROLL_THRESHOLD

      startTransition(() => {
        setIsCompact((currentIsCompact) =>
          currentIsCompact === nextIsCompact ? currentIsCompact : nextIsCompact
        )
      })
    }

    const scheduleSync = () => {
      if (frameRef.current !== null) {
        return
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        syncHeaderState()
      })
    }

    syncHeaderState()

    window.addEventListener("scroll", scheduleSync, { passive: true })
    window.addEventListener("resize", scheduleSync)

    return () => {
      window.removeEventListener("scroll", scheduleSync)
      window.removeEventListener("resize", scheduleSync)

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
      <div
        className={cn(
          "w-[calc(100vw-3rem)] transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:w-[calc(100vw-4rem)]",
          isCompact ? headerWidthClasses.compact : headerWidthClasses.expanded
        )}
      >
        <div
          className={cn(
            "relative flex flex-col overflow-hidden rounded-[1.75rem] border py-0 text-marketing-foreground transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            isCompact
              ? "border-marketing-border [background:var(--app-header-background)] [box-shadow:var(--app-header-shadow)] supports-[backdrop-filter]:backdrop-blur-[48px]"
              : "border-transparent bg-transparent shadow-none max-md:border-marketing-border max-md:[background:var(--app-header-background)] max-md:[box-shadow:var(--app-header-shadow)] max-md:supports-[backdrop-filter]:backdrop-blur-[48px]"
          )}
        >
          <div
            className={cn(
              "relative z-10 flex h-16 items-center",
              isCompact ? "px-4" : "px-4 md:px-0"
            )}
          >
            <Logo size="small" />
            <div className="ml-auto flex items-center gap-2">
              {children}
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
