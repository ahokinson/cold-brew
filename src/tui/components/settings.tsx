import { Field } from "@ahokinson/press/components"
import { getAutoBypassThreshold } from "@db"
import { usePackages } from "@tui/context/packages"
import { useTheme } from "@tui/context/theme"
import { Icon } from "@tui/icons"

const LABEL_WIDTH = 16

export function Settings() {
  const store = usePackages()
  const theme = useTheme()

  return (
    <box
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      title={`${Icon.gear.char}  Settings`}
      titleAlignment="left"
    >
      <box flexDirection="column" flexGrow={1} gap={1}>
        <box flexDirection="column">
          <Field label="hold days" labelWidth={LABEL_WIDTH}>
            <text>
              <span style={{ fg: theme.textDim }}>{`${Icon.chevronUp.char} `}</span>
              <span
                style={{ fg: theme.accent, bg: theme.backgroundSelection, attributes: 1 }}
              >{` ${store.editingHoldDays()} `}</span>
              <span style={{ fg: theme.textDim }}>{` ${Icon.chevronDown.char}`}</span>
            </text>
          </Field>
          <box flexDirection="row" paddingLeft={LABEL_WIDTH}>
            <text fg={theme.textFaint}>{"j/k to adjust \u00B7 0\u2013365 days"}</text>
          </box>
        </box>

        <box flexDirection="column">
          <Field label="auto-bypass" labelWidth={LABEL_WIDTH}>
            <text fg={theme.textSub}>{`CVSS \u2265 ${getAutoBypassThreshold().toFixed(1)}`}</text>
          </Field>
          <box flexDirection="row" paddingLeft={LABEL_WIDTH}>
            <text fg={theme.textFaint}>{"cold-brew config auto-bypass-cvss <n>"}</text>
          </box>
        </box>

        <box paddingTop={1} flexDirection="column" gap={1}>
          <box flexDirection="column">
            <text fg={theme.accent}>{`${Icon.upload.char}  R restore tap packages`}</text>
            <text fg={theme.textFaint}>{"Reinstall from official Homebrew taps"}</text>
          </box>
          <box flexDirection="column">
            <text fg={theme.overdue}>{`${Icon.triangleWarning.char}  D reset database`}</text>
            <text fg={theme.textFaint}>{"Clear all cached data and policies"}</text>
          </box>
        </box>
      </box>
    </box>
  )
}
