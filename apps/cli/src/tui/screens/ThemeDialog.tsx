import { setThemeModeLock, useThemeMode, useThemeModeLocked, type ThemeMode } from "../theme.ts"
import { Dialog, useDialog } from "../ui/Dialog.tsx"
import { DialogSelect, type DialogSelectOption } from "../ui/DialogSelect.tsx"

const THEME_OPTIONS: ReadonlyArray<DialogSelectOption<ThemeMode>> = [
  { title: "taxmaxi-dark", value: "dark" },
  { title: "taxmaxi-light", value: "light" },
]

export function ThemeDialog() {
  const dialog = useDialog()
  const options = () =>
    THEME_OPTIONS.map((option): DialogSelectOption<ThemeMode> => {
      if (useThemeMode() !== option.value) {
        return option
      }
      return {
        ...option,
        badge: useThemeModeLocked() ? "locked" : "current",
      }
    })

  const handleSelect = (mode: ThemeMode) => {
    setThemeModeLock(mode)
    dialog.clear()
  }

  return (
    <Dialog title="Themes">
      <DialogSelect
        options={options()}
        filterable
        placeholder="Search"
        onSelect={handleSelect}
        onCancel={dialog.clear}
      />
    </Dialog>
  )
}
