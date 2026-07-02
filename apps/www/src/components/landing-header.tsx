import { CalendarDays, Clock3, Database, Menu, ShieldCheck } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import useMeasure from "react-use-measure"
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Logo } from "#/components/logo"
import { LandingDrawerContent } from "#/components/landing-drawer-content"
import { Card } from "#/components/ui/card"
import { Button } from "#/components/ui/button"
import { Drawer, DrawerClose, DrawerDescription, DrawerTitle } from "#/components/ui/drawer"
import { Heading, Text } from "#/components/ui/typography"
import { CloseIcon } from "#/components/ui/icons/close"
import { Separator } from "#/components/ui/separator"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

const COMPACT_SCROLL_THRESHOLD = 72
const EXPANDED_WIDTH = "min(70rem, calc(100vw - 2rem))"
const COMPACT_WIDTH = "min(54rem, calc(100vw - 2rem))"

type IndicatorState = {
  left: number
  ready: boolean
  width: number
}

function getActiveSectionId(sectionIds: string[]): string {
  const probeLine = Math.max(140, window.innerHeight * 0.28)
  let activeSectionId = sectionIds[0]

  for (const sectionId of sectionIds) {
    const sectionElement = document.getElementById(sectionId)

    if (!sectionElement) {
      continue
    }

    if (sectionElement.getBoundingClientRect().top <= probeLine) {
      activeSectionId = sectionId
    }
  }

  return activeSectionId
}

const navItems = [
  { id: "api", label: m["header.apiProduct"] },
  { id: "cli", label: m["header.cliProduct"] },
  { id: "chat", label: m["header.chatProduct"] },
  { id: "roadmap", label: m["header.roadmap"] },
  { id: "pricing", label: m["header.pricing"] },
]

export function LandingHeader() {
  const [headerState, setHeaderState] = useState({
    activeId: navItems[0]?.id ?? "product",
    isCompact: false,
  })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [indicator, setIndicator] = useState<IndicatorState>({
    left: 8,
    ready: false,
    width: 0,
  })

  const navRef = useRef<HTMLUListElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLLIElement | null>>({})
  const frameRef = useRef<number | null>(null)

  const measureIndicator = useEffectEvent((activeId: string) => {
    const navElement = navRef.current
    const activeItem = itemRefs.current[activeId]

    if (!navElement || !activeItem) {
      return
    }

    const navRect = navElement.getBoundingClientRect()
    const itemRect = activeItem.getBoundingClientRect()
    const nextLeft = itemRect.left - navRect.left
    const nextWidth = itemRect.width

    setIndicator((currentIndicator) => {
      const leftChanged = Math.abs(currentIndicator.left - nextLeft) > 0.5
      const widthChanged = Math.abs(currentIndicator.width - nextWidth) > 0.5

      if (currentIndicator.ready && !leftChanged && !widthChanged) {
        return currentIndicator
      }

      return {
        left: nextLeft,
        ready: true,
        width: nextWidth,
      }
    })
  })

  const syncHeaderState = useEffectEvent(() => {
    const activeId = getActiveSectionId(navItems.map((item) => item.id))
    const isCompact = window.scrollY > COMPACT_SCROLL_THRESHOLD

    startTransition(() => {
      setHeaderState((currentState) => {
        if (currentState.activeId === activeId && currentState.isCompact === isCompact) {
          return currentState
        }

        return { activeId, isCompact }
      })
    })
  })

  useEffect(() => {
    syncHeaderState()

    const scheduleSync = () => {
      if (frameRef.current !== null) {
        return
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        syncHeaderState()
      })
    }

    window.addEventListener("scroll", scheduleSync, { passive: true })
    window.addEventListener("resize", scheduleSync)

    return () => {
      window.removeEventListener("scroll", scheduleSync)
      window.removeEventListener("resize", scheduleSync)

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [syncHeaderState])

  useLayoutEffect(() => {
    measureIndicator(headerState.activeId)
  }, [headerState.activeId, headerState.isCompact, measureIndicator])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return
    }

    const navElement = navRef.current

    if (!navElement) {
      return
    }

    const observer = new ResizeObserver(() => {
      measureIndicator(headerState.activeId)
    })

    observer.observe(navElement)

    for (const navItem of navItems) {
      const navItemElement = itemRefs.current[navItem.id]

      if (navItemElement) {
        observer.observe(navItemElement)
      }
    }

    return () => observer.disconnect()
  }, [headerState.activeId, navItems, measureIndicator])

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
      <div
        className="w-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width: headerState.isCompact ? COMPACT_WIDTH : EXPANDED_WIDTH }}
      >
        <Card className="transition-[background-color,border-color,box-shadow,padding,backdrop-filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]">
          <div className="flex h-16 items-center justify-between gap-4 px-3 sm:px-4">
            <Logo theme="dark" size="small" />

            <nav
              aria-label="Landing sections"
              className="hidden min-w-0 flex-1 justify-center md:flex"
            >
              <ul
                ref={navRef}
                className="relative flex h-11 w-fit items-center justify-center rounded-full px-2"
              >
                <Card
                  aria-hidden="true"
                  role="presentation"
                  className={cn(
                    "pointer-events-none absolute inset-y-1.5 transition-[left,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                    indicator.ready ? "opacity-100" : "opacity-0"
                  )}
                  style={{
                    left: `${indicator.left}px`,
                    width: `${indicator.width}px`,
                  }}
                />

                {navItems.map((item) => {
                  const isActive = headerState.activeId === item.id

                  return (
                    <li
                      key={item.id}
                      ref={(node) => {
                        itemRefs.current[item.id] = node
                      }}
                      className="relative z-10 flex h-full items-center justify-center"
                    >
                      <Button asChild data-active={isActive ? "true" : "false"}>
                        <a href={`#${item.id}`} aria-current={isActive ? "location" : undefined}>
                          {item.label()}
                        </a>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </nav>

            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              {/* <Card className="px-1">
                <Button asChild>
                  <Link resetScroll={false} to="/">
                    EN
                  </Link>
                </Button>
                <Button asChild>
                  <Link resetScroll={false} to="/de">
                    DE
                  </Link>
                </Button>
              </Card> */}

              <FamilyMobileNavDrawer
                activeId={headerState.activeId}
                open={mobileMenuOpen}
                onOpenChange={setMobileMenuOpen}
              />

              <div className="md:hidden">
                <Button
                  aria-label="Open navigation"
                  onClick={() => {
                    setMobileMenuOpen(true)
                  }}
                >
                  <Menu className="size-4" />
                </Button>
              </div>

              <Button asChild className="hidden sm:inline-flex">
                <a
                  href="https://calendar.app.google/PLa3mhnsHc12npbx7"
                  rel="noreferrer"
                  target="_blank"
                >
                  {m["header.startPilot"]()}
                </a>
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </header>
  )
}

function FamilyMobileNavDrawer({
  activeId,
  onOpenChange,
  open,
}: {
  activeId: string
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [view, setView] = useState<"navigation" | "pilot">("navigation")
  const [contentRef, bounds] = useMeasure()
  const previousHeightRef = useRef<number | null>(null)

  useEffect(() => {
    if (!open) {
      setView("navigation")
      previousHeightRef.current = null
    }
  }, [open])

  const content = useMemo(() => {
    switch (view) {
      case "pilot":
        return (
          <MobileDrawerPilotView
            onCancel={() => {
              setView("navigation")
            }}
          />
        )
      default:
        return (
          <MobileDrawerNavigationView
            activeId={activeId}
            onStartPilot={() => {
              setView("pilot")
            }}
          />
        )
    }
  }, [activeId, navItems, view])

  const opacityDuration = useMemo(() => {
    const currentHeight = bounds.height
    const previousHeight = previousHeightRef.current

    const MIN_DURATION = 0.15
    const MAX_DURATION = 0.27

    if (previousHeight === null) {
      previousHeightRef.current = currentHeight
      return MIN_DURATION
    }

    const heightDifference = Math.abs(currentHeight - previousHeight)
    previousHeightRef.current = currentHeight

    return Math.min(Math.max(heightDifference / 500, MIN_DURATION), MAX_DURATION)
  }, [bounds.height])

  return (
    <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <LandingDrawerContent data-family-mobile-nav="">
        <motion.div
          animate={
            bounds.height === 0
              ? undefined
              : {
                  height: bounds.height,
                  transition: {
                    duration: 0.24,
                    ease: [0.25, 1, 0.5, 1],
                  },
                }
          }
          initial={false}
        >
          <DrawerTitle className="sr-only">Landing navigation</DrawerTitle>
          <DrawerDescription className="sr-only">
            Jump between the main landing page sections and start a pilot conversation.
          </DrawerDescription>

          <DrawerClose asChild>
            <Button
              aria-label="Close navigation"
              className="absolute right-6 top-9 z-10"
              data-vaul-no-drag=""
              size="icon"
            >
              <CloseIcon />
            </Button>
          </DrawerClose>

          <div ref={contentRef} className="px-5 pb-5">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={view}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                initial={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: opacityDuration, ease: [0.26, 0.08, 0.25, 1] }}
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      </LandingDrawerContent>
    </Drawer>
  )
}

function MobileDrawerNavigationView({
  activeId,
  onStartPilot,
}: {
  activeId: string
  onStartPilot: () => void
}) {
  return (
    <div className="px-1">
      <Logo theme="dark" size="small" />

      <div className="flex flex-col gap-2.5 pr-12 pt-4">
        {navItems.map((item) => {
          const isActive = activeId === item.id

          return (
            <DrawerClose asChild key={item.id}>
              <Button asChild data-active={isActive ? "true" : "false"} data-vaul-no-drag="">
                <a href={`#${item.id}`}>{item.label()}</a>
              </Button>
            </DrawerClose>
          )
        })}
      </div>

      <Separator className="mt-5" />

      <div className="pt-5">
        <Button className="w-full" data-vaul-no-drag="" onClick={onStartPilot}>
          {m["header.startPilot"]()}
        </Button>
      </div>
    </div>
  )
}

function MobileDrawerPilotView({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-6 px-1 pt-6">
      <div className="pr-12">
        <Card aria-hidden="true" className="inline-flex size-12 items-center justify-center">
          <CalendarDays className="size-5" />
        </Card>

        <Heading as="h2" className="mt-4" size="page" tone="inverse">
          {m["header.pilotSheet.title"]()}
        </Heading>
        <Text className="mt-3 max-w-68" size="body" tone="inverse">
          {m["header.pilotSheet.description"]()}
        </Text>
      </div>

      <Separator />

      <ul className="flex flex-col gap-3">
        <li className="flex items-center gap-3 text-[#8fa89d]">
          <Clock3 className="size-4 shrink-0" />
          <Text size="bodySm" tone="inverse">
            {m["header.pilotSheet.meeting"]()}
          </Text>
        </li>
        <li className="flex items-center gap-3 text-[#8fa89d]">
          <Database className="size-4 shrink-0" />
          <Text size="bodySm" tone="inverse">
            {m["header.pilotSheet.dataReview"]()}
          </Text>
        </li>
        <li className="flex items-center gap-3 text-[#8fa89d]">
          <ShieldCheck className="size-4 shrink-0" />
          <Text size="bodySm" tone="inverse">
            {m["header.pilotSheet.nextSteps"]()}
          </Text>
        </li>
      </ul>

      <div className="flex gap-3">
        <Button className="flex-1" data-vaul-no-drag="" onClick={onCancel}>
          {m["header.pilotSheet.cancel"]()}
        </Button>

        <DrawerClose asChild>
          <Button asChild className="flex-1" data-vaul-no-drag="">
            <a
              href="https://calendar.app.google/PLa3mhnsHc12npbx7"
              rel="noreferrer"
              target="_blank"
            >
              <CalendarDays className="size-4.5" />
              {m["header.pilotSheet.schedule"]()}
            </a>
          </Button>
        </DrawerClose>
      </div>
    </div>
  )
}
