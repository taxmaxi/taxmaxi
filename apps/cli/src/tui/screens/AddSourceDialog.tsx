import { createSignal, Show } from "solid-js"
import { theme } from "../theme.ts"
import { Dialog, useDialog } from "../ui/Dialog.tsx"
import { DialogSelect, type DialogSelectOption } from "../ui/DialogSelect.tsx"

type ProviderId = "coinbase" | "ethereum" | "kraken" | "solana"

const PROVIDER_OPTIONS: ReadonlyArray<DialogSelectOption<ProviderId>> = [
  { title: "Coinbase", value: "coinbase", badge: "available" },
  { title: "Ethereum", value: "ethereum", badge: "coming soon", muted: true },
  { title: "Kraken", value: "kraken", badge: "coming soon", muted: true },
  { title: "Solana", value: "solana", badge: "coming soon", muted: true },
]

const PROVIDER_TITLES: Record<ProviderId, string> = {
  coinbase: "Coinbase",
  ethereum: "Ethereum",
  kraken: "Kraken",
  solana: "Solana",
}

export function AddSourceDialog(props: { readonly onPickCoinbase: () => void }) {
  const dialog = useDialog()
  const [hint, setHint] = createSignal<string | undefined>(undefined)

  const handleSelect = (provider: ProviderId) => {
    if (provider === "coinbase") {
      props.onPickCoinbase()
      return
    }
    setHint(`${PROVIDER_TITLES[provider]} support is coming soon.`)
  }

  return (
    <Dialog title="Add source">
      <DialogSelect options={PROVIDER_OPTIONS} onSelect={handleSelect} onCancel={dialog.clear} />
      <Show when={hint()}>
        <text fg={theme.warning}>{hint()}</text>
      </Show>
    </Dialog>
  )
}
