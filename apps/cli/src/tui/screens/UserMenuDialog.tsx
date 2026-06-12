import type { CliSession } from "../../session.ts"
import { theme } from "../theme.ts"
import { Dialog } from "../ui/Dialog.tsx"
import { DialogSelect, type DialogSelectOption } from "../ui/DialogSelect.tsx"

type UserMenuAction = "reconnect" | "logout" | "quit" | "close"

const MENU_OPTIONS: ReadonlyArray<DialogSelectOption<UserMenuAction>> = [
  { title: "Re-connect Coinbase", value: "reconnect", badge: "new login" },
  { title: "Log out", value: "logout" },
  { title: "Quit TaxMaxi", value: "quit" },
  { title: "Close menu", value: "close" },
]

export function UserMenuDialog(props: {
  readonly session: CliSession
  readonly onReconnect: () => void
  readonly onLogout: () => void
  readonly onQuit: () => void
  readonly onClose: () => void
}) {
  const handleSelect = (action: UserMenuAction) => {
    if (action === "reconnect") {
      props.onReconnect()
      return
    }
    if (action === "logout") {
      props.onLogout()
      return
    }
    if (action === "quit") {
      props.onQuit()
      return
    }
    props.onClose()
  }

  return (
    <Dialog title="Session">
      <box flexDirection="column">
        <text fg={theme.textSecondary}>user {props.session.userId}</text>
        <text fg={theme.textMuted}>api {props.session.apiUrl}</text>
        <text fg={theme.textMuted}>connected {props.session.connectedAt.slice(0, 10)}</text>
      </box>
      <DialogSelect options={MENU_OPTIONS} onSelect={handleSelect} onCancel={props.onClose} />
      <text fg={theme.textMuted}>[enter] select · [esc] close</text>
    </Dialog>
  )
}
