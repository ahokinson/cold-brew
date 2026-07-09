import { createNumericEditor, type NumericEditor } from "@ahokinson/press/models"
import { getHoldDays, setHoldDays } from "@db"
import { createSignal } from "solid-js"

const MAX_HOLD_DAYS = 365

export interface SettingsState {
  settingsOpen: () => boolean
  openSettings: () => void
  closeSettings: () => void
  editingHoldDays: () => string
  setEditingHoldDays: (value: string) => void
  commitHoldDays: () => void
  incrementHoldDays: () => void
  decrementHoldDays: () => void
}

export function createSettingsState(
  reevaluate: () => void,
  showMessage: (message: string, durationMilliseconds?: number) => void,
): SettingsState {
  const [settingsOpen, setSettingsOpen] = createSignal(false)

  const editor: NumericEditor = createNumericEditor({
    initial: () => getHoldDays(),
    min: 0,
    max: MAX_HOLD_DAYS,
    onCommit: (next) => {
      const previous = getHoldDays()
      setHoldDays(next)
      reevaluate()
      showMessage(`Hold days: ${previous} → ${next}`)
    },
  })

  function openSettings() {
    editor.reset()
    setSettingsOpen(true)
  }

  function closeSettings() {
    editor.commit()
    setSettingsOpen(false)
  }

  return {
    settingsOpen,
    openSettings,
    closeSettings,
    editingHoldDays: editor.editing,
    setEditingHoldDays: editor.setEditing,
    commitHoldDays: editor.commit,
    incrementHoldDays: editor.increment,
    decrementHoldDays: editor.decrement,
  }
}
