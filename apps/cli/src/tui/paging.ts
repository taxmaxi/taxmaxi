/**
 * List state helpers for the report screens: cursor-based "load more"
 * pagination and selection-following windowing for height-bound lists.
 */
import { createSignal, type Accessor } from "solid-js"

export type PageData<Row> = {
  readonly rows: ReadonlyArray<Row>
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export type PagedFetchResult<Row> =
  | { readonly _tag: "ok"; readonly page: PageData<Row> }
  | { readonly _tag: "error"; readonly message: string }

export type PagedListState<Row> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "error"; readonly message: string }
  | {
      readonly _tag: "ok"
      readonly rows: ReadonlyArray<Row>
      readonly nextCursor: string | null
      readonly hasMore: boolean
      readonly loadingMore: boolean
      readonly loadMoreError: string | undefined
    }

export type PagedList<Row> = {
  readonly state: Accessor<PagedListState<Row>>
  readonly reload: () => Promise<void>
  readonly loadMore: () => Promise<void>
}

/**
 * Wraps a cursor-page fetcher in reload/load-more list state. Loaded rows
 * accumulate across pages; reload starts over from the first page.
 */
export const createPagedList = <Row>(
  fetchPage: (cursor: string | null) => Promise<PagedFetchResult<Row>>
): PagedList<Row> => {
  const [state, setState] = createSignal<PagedListState<Row>>({ _tag: "loading" })
  // Bumped on every reload so a slow in-flight page cannot clobber newer state.
  let generation = 0

  const reload = async () => {
    const requested = ++generation
    setState({ _tag: "loading" })
    const result = await fetchPage(null)
    if (generation !== requested) {
      return
    }
    setState(
      result._tag === "ok"
        ? {
            _tag: "ok",
            rows: result.page.rows,
            nextCursor: result.page.nextCursor,
            hasMore: result.page.hasMore,
            loadingMore: false,
            loadMoreError: undefined,
          }
        : result
    )
  }

  const loadMore = async () => {
    const current = state()
    if (current._tag !== "ok" || !current.hasMore || current.loadingMore) {
      return
    }
    const requested = generation
    setState({ ...current, loadingMore: true, loadMoreError: undefined })
    const result = await fetchPage(current.nextCursor)
    if (generation !== requested) {
      return
    }
    if (result._tag === "error") {
      setState({ ...current, loadingMore: false, loadMoreError: result.message })
      return
    }
    setState({
      _tag: "ok",
      rows: [...current.rows, ...result.page.rows],
      nextCursor: result.page.nextCursor,
      hasMore: result.page.hasMore,
      loadingMore: false,
      loadMoreError: undefined,
    })
  }

  void reload()
  return { state, reload, loadMore }
}

export type ListViewport = {
  readonly bounds: (args: { readonly length: number; readonly visible: number }) => {
    readonly start: number
    readonly end: number
  }
  readonly scrollBy: (args: {
    readonly delta: number
    readonly length: number
    readonly visible: number
  }) => void
  readonly ensureVisible: (args: { readonly index: number; readonly visible: number }) => void
  readonly reset: () => void
}

/**
 * Scroll state for height-bound lists. The mouse wheel moves the window
 * directly (the selection may scroll out of view); keyboard selection
 * moves pull the window along just enough to keep the selected row
 * visible. Terminals emit one scroll event per line, so the wheel
 * scrolls at the native rate.
 */
export const createListViewport = (): ListViewport => {
  const [offset, setOffset] = createSignal(0)

  const maxOffset = (length: number, visible: number) => Math.max(0, length - visible)

  return {
    bounds: ({ length, visible }) => {
      const start = Math.min(offset(), maxOffset(length, visible))
      return { start, end: Math.min(length, start + visible) }
    },
    scrollBy: ({ delta, length, visible }) => {
      setOffset((current) => Math.min(Math.max(0, current + delta), maxOffset(length, visible)))
    },
    ensureVisible: ({ index, visible }) => {
      setOffset((current) => {
        if (index < current) {
          return index
        }
        if (index >= current + visible) {
          return index - visible + 1
        }
        return current
      })
    },
    reset: () => setOffset(0),
  }
}

/**
 * Returns the slice bounds that keep the selected row visible when a list
 * is taller than the rows the terminal can show.
 */
export const windowBounds = ({
  length,
  selected,
  visible,
}: {
  readonly length: number
  readonly selected: number
  readonly visible: number
}): { readonly start: number; readonly end: number } => {
  if (length <= visible) {
    return { start: 0, end: length }
  }
  const half = Math.floor(visible / 2)
  const start = Math.min(Math.max(0, selected - half), length - visible)
  return { start, end: start + visible }
}
