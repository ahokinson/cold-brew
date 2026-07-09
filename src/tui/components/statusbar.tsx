import { type KeyHint, StatusBar as PressStatusBar, Spinners } from "@ahokinson/press/components"
import { usePackages } from "@tui/context/packages"
import { useTheme } from "@tui/context/theme"

interface StatusBarProps {
  hints: () => KeyHint[]
}

export function StatusBar(props: StatusBarProps) {
  const store = usePackages()
  const theme = useTheme()
  const spinnerFrame = Spinners.useFrame()

  const trailing = () => {
    const reason = store.busy.reason() ?? store.message() ?? ""
    const trail = store.trail()
    if (!reason && !trail) return null
    return (
      <span style={{ fg: theme.accent }}>
        {reason}
        <span style={{ fg: theme.textDim }}>{trail}</span>
      </span>
    )
  }

  return (
    <PressStatusBar hints={props.hints} trailing={trailing} busy={() => store.busy.active()} spinner={spinnerFrame} />
  )
}
