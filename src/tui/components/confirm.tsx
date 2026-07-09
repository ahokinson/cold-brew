import { ConfirmDialog as PressConfirmDialog } from "@ahokinson/press/components"
import { usePackages } from "@tui/context/packages"

export function ConfirmDialog() {
  const store = usePackages()
  // Suppress the dialog's built-in key hints — the status bar is the canonical
  // key reference. press falls back to DEFAULT_HINTS unless keyHints is set, so
  // pass an explicit empty list.
  const action = () => {
    const a = store.dialogAction()
    return a ? { ...a, keyHints: [] } : null
  }
  return <PressConfirmDialog action={action} />
}
