import { LibraryBig, X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo } from "react"

import {
  AssetCatalogProvider,
  type AssetCatalogFeeds,
  useAssetCatalog,
} from "#/components/asset-catalog-context"
import { AssetCatalogDetailPane } from "#/components/asset-catalog-detail-pane"
import { AssetCatalogListPane } from "#/components/asset-catalog-list-pane"
import { ASSET_CATALOG_SEARCH_ID } from "#/components/asset-catalog-model"
import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { m } from "#/paraglide/messages"

export type { AssetCatalogFeeds }

const SURFACE_OPEN_TRANSFORM = "translate3d(0, 0, 0) scale(1)"
const SURFACE_CLOSED_TRANSFORM = "translate3d(0, 4px, 0) scale(0.992)"
const SURFACE_ENTER_TRANSITION = { bounce: 0, duration: 0.32, type: "spring" } as const
const REDUCED_MOTION_TRANSITION = { duration: 0.15 } as const

export function AssetCatalog({
  feeds,
  onClose,
  onQueryChange,
}: {
  readonly feeds: AssetCatalogFeeds
  readonly onClose: () => void
  readonly onQueryChange?: (query: string) => void
}) {
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 })

    if (document.activeElement === document.body) {
      document.getElementById(ASSET_CATALOG_SEARCH_ID)?.focus()
    }
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
      <AppBackdrop />
      <motion.div
        aria-hidden="true"
        animate={{ opacity: 1 }}
        className="fixed inset-0 bg-foreground/20"
        initial={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.main
        animate="open"
        aria-labelledby="asset-catalog-title"
        className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl outline-none sm:inset-3 sm:rounded-[1.75rem] sm:ring-1 sm:ring-foreground/10"
        data-asset-catalog-surface=""
        initial="initial"
        style={{ transformOrigin: "calc(100% - 3rem) 2rem" }}
        variants={surfaceVariants}
      >
        <FocusSurfaceHeader onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <AssetCatalogProvider feeds={feeds} onQueryChange={onQueryChange}>
            <AssetCatalogNavigator />
          </AssetCatalogProvider>
        </div>
      </motion.main>
    </div>
  )
}

function AppBackdrop() {
  return (
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
  )
}

function FocusSurfaceHeader({ onClose }: { readonly onClose: () => void }) {
  return (
    <>
      <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <LibraryBig aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium" id="asset-catalog-title">
              {m["assetCatalog.title"]()}
            </h1>
            <p className="truncate text-xs text-muted-foreground">{m["assetCatalog.subtitle"]()}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground md:inline">Esc</span>
          <Button
            aria-label={m["assetCatalog.close"]()}
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
    </>
  )
}

function AssetCatalogNavigator() {
  const { mobileDetailOpen } = useAssetCatalog()

  return (
    <div
      className="grid h-full min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]"
      data-mobile-view={mobileDetailOpen ? "detail" : "list"}
    >
      <AssetCatalogListPane />
      <AssetCatalogDetailPane />
    </div>
  )
}
