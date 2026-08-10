export const ASSET_CATALOG_OPENER_ID = "asset-catalog-opener"

const ASSET_CATALOG_SURFACE_SELECTOR = "[data-asset-catalog-surface]"
const RETURN_FOCUS_FALLBACK_SELECTOR = "main, [data-asset-catalog-return-focus]"

export function restoreAssetCatalogReturnFocus(): () => void {
  let animationFrame: number | undefined
  let observer: MutationObserver | undefined
  let stopped = false

  const stop = () => {
    stopped = true
    observer?.disconnect()
    if (animationFrame !== undefined) {
      window.cancelAnimationFrame(animationFrame)
    }
  }

  const restoreFocus = () => {
    animationFrame = undefined
    if (stopped) {
      return
    }

    const opener = document.getElementById(ASSET_CATALOG_OPENER_ID)

    if (opener instanceof HTMLElement) {
      opener.focus()
      stop()
      return
    }

    if (document.querySelector(ASSET_CATALOG_SURFACE_SELECTOR) !== null) {
      return
    }

    const fallback = document.querySelector(RETURN_FOCUS_FALLBACK_SELECTOR)
    if (fallback instanceof HTMLElement) {
      fallback.tabIndex = -1
      fallback.focus()
      stop()
    }
  }

  const scheduleRestore = () => {
    if (!stopped && animationFrame === undefined) {
      animationFrame = window.requestAnimationFrame(restoreFocus)
    }
  }

  observer = new MutationObserver(scheduleRestore)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  scheduleRestore()

  return stop
}
