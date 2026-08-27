import { useCallback, useEffect, useRef, useState } from "react"

import {
  ASSET_CATALOG_SEARCH_ID,
  getCatalogItemDomId,
  getCatalogItemKey,
  type CatalogItem,
} from "./asset-catalog-model"

const ASSET_CATALOG_DESKTOP_MEDIA_QUERY = "(min-width: 64rem)"

export function useAssetCatalogSelection({
  visibleItems,
}: {
  readonly visibleItems: ReadonlyArray<CatalogItem>
}) {
  const [exactLookupOpen, setExactLookupOpen] = useState(false)
  // Remount key for the lookup pane: every "open exact lookup" action starts
  // a fresh lookup, even when the pane already shows a previous result.
  const [exactLookupKey, setExactLookupKey] = useState(0)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const mobileBackButtonRef = useRef<HTMLButtonElement>(null)
  const [selectedKey, setSelectedKey] = useState(() => getCatalogItemKey(visibleItems[0]))
  const selectedItem =
    visibleItems.find((item) => getCatalogItemKey(item) === selectedKey) ??
    (selectedKey.length === 0 ? visibleItems[0] : undefined)
  const selectedItemKey = getCatalogItemKey(selectedItem)

  useEffect(() => {
    if (exactLookupOpen) {
      return
    }

    if (selectedKey.length === 0) {
      if (selectedItemKey.length > 0) {
        setSelectedKey(selectedItemKey)
      }
      return
    }

    if (selectedItem !== undefined) {
      return
    }

    const shouldRestoreFocus = mobileDetailOpen || document.activeElement === document.body
    const nextItem = visibleItems[0]
    setMobileDetailOpen(false)
    setSelectedKey(getCatalogItemKey(nextItem))

    if (shouldRestoreFocus) {
      window.requestAnimationFrame(() => {
        const focusTargetId =
          nextItem === undefined ? ASSET_CATALOG_SEARCH_ID : getCatalogItemDomId(nextItem)
        document.getElementById(focusTargetId)?.focus()
      })
    }
  }, [exactLookupOpen, mobileDetailOpen, selectedItem, selectedItemKey, selectedKey, visibleItems])

  useEffect(() => {
    if (mobileDetailOpen) {
      mobileBackButtonRef.current?.focus()
    }
  }, [mobileDetailOpen])

  const selectItem = useCallback((item: CatalogItem) => {
    setExactLookupOpen(false)
    setSelectedKey(getCatalogItemKey(item))

    if (!window.matchMedia(ASSET_CATALOG_DESKTOP_MEDIA_QUERY).matches) {
      setMobileDetailOpen(true)
    }
  }, [])

  const showMobileList = useCallback(() => {
    setExactLookupOpen(false)
    setMobileDetailOpen(false)

    if (selectedItem === undefined) {
      window.requestAnimationFrame(() => {
        document.getElementById(ASSET_CATALOG_SEARCH_ID)?.focus()
      })
      return
    }

    window.requestAnimationFrame(() => {
      document.getElementById(getCatalogItemDomId(selectedItem))?.focus()
    })
  }, [selectedItem])

  const openExactLookup = useCallback(() => {
    setExactLookupOpen(true)
    setExactLookupKey((key) => key + 1)

    // Only mobile needs the detail pane state; on desktop it would trigger
    // the media-query effect, which pulls focus back into the catalog list.
    if (!window.matchMedia(ASSET_CATALOG_DESKTOP_MEDIA_QUERY).matches) {
      setMobileDetailOpen(true)
    }
  }, [])

  // A scope change leaves the lookup context behind; keeping the pane open
  // would also keep selection repair disabled in the new scope.
  const closeExactLookup = useCallback(() => {
    setExactLookupOpen(false)
  }, [])

  useEffect(() => {
    const desktopQuery = window.matchMedia(ASSET_CATALOG_DESKTOP_MEDIA_QUERY)
    const moveFocusToDesktopList = (matches: boolean) => {
      if (!matches || !mobileDetailOpen) {
        return
      }

      setMobileDetailOpen(false)
      window.requestAnimationFrame(() => {
        const focusTargetId =
          selectedItem === undefined ? ASSET_CATALOG_SEARCH_ID : getCatalogItemDomId(selectedItem)
        document.getElementById(focusTargetId)?.focus()
      })
    }
    const onDesktopChange = (event: MediaQueryListEvent) => {
      moveFocusToDesktopList(event.matches)
    }

    moveFocusToDesktopList(desktopQuery.matches)
    desktopQuery.addEventListener("change", onDesktopChange)
    return () => desktopQuery.removeEventListener("change", onDesktopChange)
  }, [mobileDetailOpen, selectedItem])

  useEffect(() => {
    if (selectedItem === undefined) {
      return
    }

    document.getElementById(getCatalogItemDomId(selectedItem))?.scrollIntoView({ block: "nearest" })
  }, [selectedItem])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const searchTarget =
        target instanceof HTMLInputElement && target.getAttribute("role") === "combobox"
      const optionTarget =
        target instanceof HTMLElement ? target.closest("[data-asset-catalog-option]") : null
      const isArrowKey = event.key === "ArrowDown" || event.key === "ArrowUp"
      const activatesSearchSelection = event.key === "Enter" && searchTarget

      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        mobileDetailOpen ||
        (!isArrowKey && !activatesSearchSelection) ||
        (!searchTarget && optionTarget === null) ||
        visibleItems.length === 0
      ) {
        return
      }

      if (activatesSearchSelection) {
        if (selectedItem !== undefined) {
          event.preventDefault()
          selectItem(selectedItem)
        }
        return
      }

      event.preventDefault()
      const currentIndex = Math.max(
        visibleItems.findIndex((item) => getCatalogItemKey(item) === selectedItemKey),
        0
      )
      const nextIndex =
        event.key === "ArrowDown"
          ? Math.min(currentIndex + 1, visibleItems.length - 1)
          : Math.max(currentIndex - 1, 0)
      const nextItem = visibleItems[nextIndex]

      if (nextItem === undefined) {
        return
      }

      setSelectedKey(getCatalogItemKey(nextItem))

      if (optionTarget !== null) {
        window.requestAnimationFrame(() => {
          document.getElementById(getCatalogItemDomId(nextItem))?.focus()
        })
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [mobileDetailOpen, selectItem, selectedItem, selectedItemKey, visibleItems])

  return {
    closeExactLookup,
    exactLookupKey,
    exactLookupOpen,
    mobileBackButtonRef,
    mobileDetailOpen,
    openExactLookup,
    selectedItem,
    selectedItemKey,
    selectItem,
    showMobileList,
  }
}
