import { Box, Callout, Field, Picker, Progress, Truncated } from "@ahokinson/press/components"
import { Severity } from "@ahokinson/press/theme"
import { commitDateToAgeDays, formatDate } from "@brew/format"
import { formatAgeDays } from "@brew/policy"
import { Status } from "@brew/status"
import { Advisory, Hold, type Package } from "@brew/types"
import { getHoldDays } from "@db"
import { usePackages } from "@tui/context/packages"
import { useTheme } from "@tui/context/theme"
import { Icon, placeholder } from "@tui/icons"
import type { JSX } from "solid-js"
import { Show } from "solid-js"

const layout = {
  labelWidth: 12,
  iconLabelWidth: 15,
  selectorWidth: 4,
  versionWidth: 14,
  ageWidth: 12,
  leftColumnWidth: 36,
  cvssWidth: 5,
} as const

const MAX_ADVISORIES_SHOWN = 5
const MAX_TYPOSQUATS_SHOWN = 3

type ThemeType = ReturnType<typeof useTheme>

function AdvisoryList(props: { pkg: Package.WithStatus; theme: ThemeType }) {
  const vulns = () => Advisory.Kind.vulnerabilities(props.pkg.advisories)
  return (
    <box flexDirection="column">
      <text fg={props.theme.textDim} height={1}>{`${Icon.bug.char} advisories`}</text>
      <Truncated
        items={vulns}
        max={MAX_ADVISORIES_SHOWN}
        moreIndent={layout.cvssWidth}
        renderItem={(entry) => (
          <box flexDirection="column">
            <box flexDirection="row" height={1}>
              <box width={layout.cvssWidth} overflow="hidden">
                <text fg={Status.severityColor(entry.severity, props.theme)} attributes={1}>
                  {entry.cvss != null
                    ? entry.cvss.toFixed(1).padStart(4)
                    : entry.severity.slice(0, 4).toUpperCase().padStart(4)}
                </text>
              </box>
              <box flexGrow={1} overflow="hidden" flexDirection="row">
                <text fg={props.theme.textSub}>{entry.id}</text>
                <Show when={entry.epss != null}>
                  <text fg={props.theme.textDim}>{`  EPSS ${entry.epss!.toFixed(2)}`}</text>
                </Show>
                <Show when={entry.kev}>
                  <text fg={Status.severityColor("critical", props.theme)} attributes={1}>
                    {"  KEV"}
                  </text>
                </Show>
              </box>
            </box>
            <Show when={entry.summary && entry.summary !== entry.id}>
              <box flexDirection="row" height={1} paddingLeft={layout.cvssWidth}>
                <text fg={props.theme.textDim}>{entry.summary}</text>
              </box>
            </Show>
          </box>
        )}
      />
    </box>
  )
}

function TyposquatList(props: { pkg: Package.WithStatus; theme: ThemeType }) {
  const entries = () => Advisory.Kind.typosquats(props.pkg.advisories)
  return (
    <box flexDirection="column">
      <text fg={props.theme.textDim} height={1}>{`${Icon.triangleWarning.char} typosquats`}</text>
      <Truncated
        items={entries}
        max={MAX_TYPOSQUATS_SHOWN}
        moreIndent={layout.cvssWidth}
        renderItem={(entry) => (
          <box flexDirection="row" height={1} paddingLeft={layout.cvssWidth}>
            <text fg={props.theme.textDim} wrapMode="none">
              {entry.summary}
            </text>
          </box>
        )}
      />
    </box>
  )
}

function PackageDetails() {
  const store = usePackages()
  const theme = useTheme()

  const pkg = () => store.selectedPackage()
  const loaded = () => !!pkg()

  return (
    <Box flexGrow={1} padding={1} title={loaded() ? `${Status.glyph(pkg()!.status)} ${pkg()!.name}` : undefined}>
      <box flexDirection="column" flexGrow={1} gap={1}>
        <text fg={loaded() ? theme.textMuted : theme.textFaint} wrapMode="word" height={2} overflow="hidden">
          {loaded() ? pkg()!.description || " " : placeholder(layout.labelWidth * 2)}
        </text>

        <box flexDirection="row" flexGrow={1} gap={4}>
          <box flexDirection="column" gap={1} width={layout.leftColumnWidth}>
            <box flexDirection="column" height={2}>
              <Field label="installed" labelWidth={layout.labelWidth}>
                <text fg={loaded() ? theme.textSub : theme.textFaint}>
                  {loaded() ? pkg()!.installedVersion : placeholder(layout.versionWidth)}
                </text>
              </Field>
              <Show when={!loaded() || (pkg()!.outdated && pkg()!.latestVersion)}>
                <Field label="latest" labelWidth={layout.labelWidth}>
                  {loaded() ? (
                    <text>
                      <span style={{ fg: theme.textDim }}>{`${Icon.caretRight.char} `}</span>
                      <span style={{ fg: theme.accent }}>{pkg()!.latestVersion}</span>
                    </text>
                  ) : (
                    <text fg={theme.textFaint}>{placeholder(layout.versionWidth)}</text>
                  )}
                </Field>
              </Show>
            </box>

            <box flexDirection="column">
              <Field label={`${Icon.clock.char}  published`} labelWidth={layout.iconLabelWidth}>
                {loaded() ? (
                  <text>
                    <span style={{ fg: theme.textMuted }}>
                      {pkg()!.sourceModifiedAt > 0 ? formatDate(pkg()!.sourceModifiedAt) : "unknown"}
                    </span>
                    <Show when={pkg()!.sourceModifiedAt > 0 && pkg()!.status !== Hold.Held}>
                      <span style={{ fg: theme.textDim }}>{` (${formatAgeDays(pkg()!.sourceAgeDays)} ago)`}</span>
                    </Show>
                  </text>
                ) : (
                  <text fg={theme.textFaint}>{placeholder(layout.labelWidth)}</text>
                )}
              </Field>
              <box flexDirection="row" paddingLeft={2} height={1}>
                {loaded() && Status.isTooNew(pkg()! as Package.WithStatus, getHoldDays()) ? (
                  <Callout severity={Severity.Error} glyph={Icon.triangleWarning.char} variant="rail">
                    not yet trusted
                  </Callout>
                ) : (
                  <text> </text>
                )}
              </box>
            </box>

            <Show when={loaded() && pkg()!.status === Hold.Held}>
              <box flexDirection="column" height={2}>
                <Progress value={() => pkg()!.sourceAgeDays} max={() => getHoldDays()} filledColor={theme.ready} />
                <text fg={theme.textDim} height={1}>
                  {`${formatAgeDays(pkg()!.sourceAgeDays)} / ${formatAgeDays(getHoldDays())}`}
                </text>
              </box>
            </Show>

            <Show when={loaded() && pkg()!.bypassReason !== null}>
              <Callout severity={Severity.Warning} glyph={Icon.triangleWarning.char} variant="rail">
                {(() => {
                  const reason = pkg()!.bypassReason
                  if (reason === "kev") return "Hold bypassed\u2009\u2014\u2009actively exploited (CISA KEV)"
                  if (reason === "epss") {
                    const maxEpss = pkg()!.advisories?.maxEpss
                    const score = maxEpss != null ? ` EPSS ${maxEpss.toFixed(2)}` : ""
                    return `Hold bypassed\u2009\u2014\u2009high exploit probability${score}`
                  }
                  const top = pkg()!.advisories?.entries[0]
                  const cvss = top?.cvss != null ? ` CVSS ${top.cvss.toFixed(1)}` : ""
                  return `Hold bypassed\u2009\u2014\u2009security fix${cvss}`
                })()}
              </Callout>
            </Show>
          </box>

          <box flexDirection="column" flexGrow={1} overflow="hidden" gap={1}>
            <Show
              when={loaded() && Advisory.Kind.vulnerabilities(pkg()!.advisories).length > 0}
              fallback={
                <Show
                  when={loaded() && Advisory.Kind.typosquats(pkg()!.advisories).length > 0}
                  fallback={
                    <Show when={loaded()} fallback={<text> </text>}>
                      <box flexDirection="row" height={1}>
                        <text fg={theme.ready}>{`${Icon.check.char} `}</text>
                        <text fg={theme.textDim}>{"no known advisories"}</text>
                      </box>
                    </Show>
                  }
                >
                  <TyposquatList pkg={pkg()!} theme={theme} />
                </Show>
              }
            >
              <AdvisoryList pkg={pkg()!} theme={theme} />
              <Show when={Advisory.Kind.typosquats(pkg()!.advisories).length > 0}>
                <TyposquatList pkg={pkg()!} theme={theme} />
              </Show>
            </Show>
          </box>
        </box>

        <box flexDirection="column">
          <text fg={theme.textFaint} height={1}>
            {Icon.lineHorizontal.char.repeat(layout.leftColumnWidth)}
          </text>
          <text>
            {loaded() ? (
              (() => {
                const p = pkg()!
                const parts: JSX.Element[] = [
                  <span style={{ fg: theme.textDim }}>
                    {p.isCask ? `${Icon.cask.char}  cask` : `${Icon.formula.char}  formula`}
                  </span>,
                  <span style={{ fg: theme.textDim }}>{p.isLeaf ? "top-level" : `${Icon.link.char}  dependency`}</span>,
                  <span style={{ fg: Status.tapColor(p.originTap, theme) }}>{`${Icon.tap.char}  ${p.originTap}`}</span>,
                ]
                if (!p.trusted) {
                  parts.push(
                    <span style={{ fg: Status.untrustedColor(theme) }}>{`${Icon.untrusted.char}  untrusted tap`}</span>,
                  )
                } else if (p.shadowedBy) {
                  parts.push(
                    <span style={{ fg: Status.shadowColor(theme) }}>
                      {`${Icon.ghost.char}  shadowed by ${p.shadowedBy}`}
                    </span>,
                  )
                }
                return parts.flatMap((el, i) =>
                  i === 0 ? [el] : [<span style={{ fg: theme.textDim }}>{` ${Icon.dot.char} `}</span>, el],
                )
              })()
            ) : (
              <span style={{ fg: theme.textFaint }}>{placeholder(layout.labelWidth)}</span>
            )}
          </text>
        </box>
      </box>
    </Box>
  )
}

export function VersionPickerModal() {
  const store = usePackages()
  const theme = useTheme()

  return (
    <Picker
      state={store.versionPicker}
      title={`${store.selectedPackage()?.name ?? ""} \u00B7 versions`}
      placeholder={"filter versions\u2026"}
      renderItem={(ctx) => {
        const entry = ctx.item
        const selected = store.selectedPackage()
        const isInstalled = selected != null && entry.version === selected.installedVersion
        const isLatest = selected != null && entry.version === selected.latestVersion

        return (
          <box flexDirection="row" height={1}>
            <box width={layout.selectorWidth}>
              <text fg={theme.accent} attributes={ctx.active() ? 1 : 0}>
                {ctx.active() ? ` ${Icon.play.char} ` : ""}
              </text>
            </box>
            <box width={layout.versionWidth} overflow="hidden">
              <text fg={ctx.active() ? theme.text : theme.textSub} attributes={ctx.active() ? 1 : 0}>
                {entry.version}
              </text>
            </box>
            <box width={layout.ageWidth}>
              <text fg={theme.textDim}>{`${formatAgeDays(commitDateToAgeDays(entry.commitDate))} ago`}</text>
            </box>
            <box width={Icon.check.columns} overflow="hidden">
              {isInstalled && <text fg={theme.ready}>{Icon.check.char}</text>}
            </box>
            <box width={Icon.upload.columns} overflow="hidden">
              {isLatest && <text fg={theme.accent}>{Icon.upload.char}</text>}
            </box>
          </box>
        )
      }}
    />
  )
}

export function Details() {
  const store = usePackages()

  return (
    <Show
      when={store.selectedPackage() || store.loading()}
      fallback={
        <box paddingLeft={2} paddingTop={1}>
          <text fg={useTheme().textDim}>{"Select a package"}</text>
        </box>
      }
    >
      <PackageDetails />
    </Show>
  )
}
