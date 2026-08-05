import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ProtocolCandidateReview, Source } from "taxmaxi"

export type ReportRouteType =
  | "sourceOverview"
  | "sourceAssetPnl"
  | "sourceTransactions"
  | "sourceTaxEvents"
  | "sourceFifoLots"

export type Route =
  | { readonly type: "boot" }
  | { readonly type: "bootError"; readonly message: string }
  | { readonly type: "welcome" }
  | { readonly type: "sources" }
  | { readonly type: "protocolCandidates" }
  | { readonly type: "protocolCandidateDetail"; readonly candidate: ProtocolCandidateReview }
  | { readonly type: "connect" }
  | { readonly type: "loggingOut" }
  | { readonly type: ReportRouteType; readonly source: Source }

export type MainTab = "sources" | "protocolCandidates"

export const mainTabForRoute = (route: Route): MainTab =>
  route.type === "protocolCandidates" || route.type === "protocolCandidateDetail"
    ? "protocolCandidates"
    : "sources"

export type RouteContext = Readonly<{
  readonly data: Route
  navigate: (route: Route) => void
}>

const RouteContext = createContext<RouteContext>()

export function RouteProvider(props: ParentProps<{ readonly initialRoute?: Route }>) {
  const [store, setStore] = createStore<Route>(props.initialRoute ?? { type: "boot" })
  const value: RouteContext = {
    get data() {
      return store
    },
    navigate(route) {
      setStore(reconcile(route))
    },
  }

  return <RouteContext.Provider value={value}>{props.children}</RouteContext.Provider>
}

export function useRoute() {
  const value = useContext(RouteContext)
  if (value === undefined) {
    throw new Error("useRoute must be used within RouteProvider")
  }
  return value
}
