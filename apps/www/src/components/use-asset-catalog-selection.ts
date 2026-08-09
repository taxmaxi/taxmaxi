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
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const mobileBackButtonRef = useRef<HTMLButtonElement>(null)
  const [selectedKey, setSelectedKey] = useState(() => getCatalogItemKey(visibleItems[0]))
  const selectedItem =
    visibleItems.find((item) => getCatalogItemKey(item) === selectedKey) ??
    (selectedKey.length === 0 ? visibleItems[0] : undefined)
  const selectedItemKey = getCatalogItemKey(selectedItem)

  useEffect(() => {
    if (selectedKey.length === 0 || selectedItem !== undefined) {
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
  }, [mobileDetailOpen, selectedItem, selectedKey, visibleItems])

  useEffect(() => {
    if (mobileDetailOpen) {
      mobileBackButtonRef.current?.focus()
    }
  }, [mobileDetailOpen])

  const selectItem = useCallback((item: CatalogItem) => {
    setSelectedKey(getCatalogItemKey(item))

    if (!window.matchMedia(ASSET_CATALOG_DESKTOP_MEDIA_QUERY).matches) {
      setMobileDetailOpen(true)
    }
  }, [])

  const showMobileList = useCallback(() => {
    setMobileDetailOpen(false)

    if (selectedItem === undefined) {
      return
    }

    window.requestAnimationFrame(() => {
      document.getElementById(getCatalogItemDomId(selectedItem))?.focus()
    })
  }, [selectedItem])

  useEffect(() => {
    const desktopQuery = window.matchMedia(ASSET_CATALOG_DESKTOP_MEDIA_QUERY)
    const moveFocusToDesktopList = (matches: boolean) => {
      if (!matches || !mobileDetailOpen || selectedItem === undefined) {
        return
      }

      setMobileDetailOpen(false)
      window.requestAnimationFrame(() => {
        document.getElementById(getCatalogItemDomId(selectedItem))?.focus()
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
    mobileBackButtonRef,
    mobileDetailOpen,
    selectedItem,
    selectedItemKey,
    selectItem,
    showMobileList,
  }
}
