import { Dialog, useDialog } from "../ui/Dialog.tsx"
import { DialogSelect, type DialogSelectOption } from "../ui/DialogSelect.tsx"
import { ThemeDialog } from "./ThemeDialog.tsx"

type CommandAction = "logout" | "switchTheme" | "quit"

const COMMAND_OPTIONS: ReadonlyArray<DialogSelectOption<CommandAction>> = [
  { title: "Log out", value: "logout", category: "Session" },
  { title: "Switch theme", value: "switchTheme", category: "System" },
  { title: "Quit TaxMaxi", value: "quit", category: "System" },
]

export function CommandPaletteDialog(props: {
  readonly onLogout: () => void
  readonly onQuit: () => void
}) {
  const dialog = useDialog()
  const handleSelect = (action: CommandAction) => {
    if (action === "logout") {
      props.onLogout()
      return
    }
    if (action === "quit") {
      props.onQuit()
      return
    }
    dialog.replace(() => <ThemeDialog />)
  }

  return (
    <Dialog title="Commands" width={72}>
      <DialogSelect
        options={COMMAND_OPTIONS}
        filterable
        placeholder="Search"
        onSelect={handleSelect}
        onCancel={dialog.clear}
      />
    </Dialog>
  )
}
