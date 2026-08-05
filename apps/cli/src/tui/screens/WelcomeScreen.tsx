import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { Show } from "solid-js"
import { theme } from "../theme.ts"

export function WelcomeScreen(props: {
  readonly note: string | undefined
  readonly active: () => boolean
  readonly onConnect: () => void
  readonly onQuit: () => void
}) {
  const titleColor = () => theme.accent

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "return") {
      props.onConnect()
      return
    }
    if (evt.name === "q") {
      props.onQuit()
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <box flexDirection="row" gap={3} alignItems="center">
        {/* <text fg={theme.textCream}>{asciilogo}</text> */}
        <ascii_font text="TaxMaxi" font="block" color={titleColor()} selectable={false} />
      </box>
      <box
        flexDirection="column"
        gap={1}
        width={60}
        backgroundColor={theme.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
          Crypto taxes from your terminal
        </text>
        <Show when={props.note}>
          <text fg={theme.warning} wrapMode="word">
            {props.note}
          </text>
        </Show>
        <text fg={theme.textSecondary} wrapMode="word">
          Connect your Coinbase account or Solana wallet to import transactions and calculate crypto
          taxes right from your terminal.
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.accent}>[enter] connect Coinbase</text>
          <text fg={theme.textMuted}>[q] quit</text>
        </box>
      </box>
    </box>
  )
}
