import { Empty, groupBySection, Highlight, Section, Sections } from "@ahokinson/press/components"
import { createScrollboxSync } from "@ahokinson/press/signals"
import { formatAgeDays } from "@brew/policy"
import { Status } from "@brew/status"
import { isCustomTap } from "@brew/tap"
import { Hold } from "@brew/types"
import { getHoldDays } from "@db"
import { useTerminalDimensions } from "@opentui/solid"
import { usePackages } from "@tui/context/packages"
import { useTheme } from "@tui/context/theme"
import { Icon, placeholder } from "@tui/icons"
import { type Accessor, createMemo, Show } from "solid-js"

const columnWidths = {
  prefix: 5,
  nameMin: 16,
  nameMax: 28,
  dep: 2,
  severity: 3,
  badge: 3,
  gap: 2,
  version: 15,
  age: 7,
} as const

export function Dashboard() {
  const store = usePackages()
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  // Read live, not via createMemo: getHoldDays() isn't reactive, so a memo
  // would cache the mount-time value and age colors would go stale after the
  // user changes hold-days in Settings.
  const holdDays = () => getHoldDays()

  // header (1) + column headers (1) + statusbar (1) = 3 fixed rows
  const skeletonRows = () => Math.max(0, dimensions().height - 3)
  const sync = createScrollboxSync({ cursor: store.scrollRow })

  const sections = createMemo(() =>
    groupBySection<ReturnType<typeof store.filteredPackages>[number], number>({
      items: store.visiblePackages(),
      allItems: store.filteredPackages(),
      sectionKey: Status.section,
      collapsedSections: store.collapsedSections(),
      sectionLabel: (id) => Status.sectionLabel(id),
    }),
  )

  const ColumnHeader = () => (
    <box height={1} flexDirection="row" backgroundColor={theme.backgroundElevated}>
      <box width={columnWidths.prefix} />
      <box flexGrow={1} minWidth={columnWidths.nameMin} maxWidth={columnWidths.nameMax}>
        <text fg={theme.textMuted}>{"name"}</text>
      </box>
      <box width={columnWidths.dep} />
      <box width={columnWidths.severity} />
      <box width={columnWidths.badge} />
      <box width={columnWidths.gap} />
      <box width={columnWidths.version}>
        <text fg={theme.textMuted}>{"installed".padStart(columnWidths.version)}</text>
      </box>
      <box width={columnWidths.gap} />
      <box width={columnWidths.version}>
        <text fg={theme.textMuted}>{"latest".padStart(columnWidths.version)}</text>
      </box>
      <box width={columnWidths.gap} />
      <box width={columnWidths.age}>
        <text fg={theme.textMuted}>{"age".padStart(columnWidths.age)}</text>
      </box>
    </box>
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <ColumnHeader />
      <Sections
        sections={sections}
        cursor={store.cursor}
        setScrollRef={sync.bindRef}
        loading={store.loading}
        renderSectionHeader={(entry) =>
          entry.label == null ? (
            <></>
          ) : (
            <Section
              label={`${entry.id === Status.SECTION_ACTIONABLE ? Icon.ready.char : Icon.check.char} ${entry.label}`}
              count={entry.count}
              collapsed={() => entry.collapsed}
            />
          )
        }
        skeleton={{
          rows: skeletonRows,
          renderRow: () => (
            <box flexDirection="row" height={1} paddingLeft={1}>
              <box width={columnWidths.prefix} />
              <box flexGrow={1} minWidth={columnWidths.nameMin} maxWidth={columnWidths.nameMax}>
                <text fg={theme.textFaint}>{placeholder(columnWidths.nameMin)}</text>
              </box>
              <box width={columnWidths.dep} />
              <box width={columnWidths.severity} />
              <box width={columnWidths.badge} />
              <box width={columnWidths.gap} />
              <box width={columnWidths.version}>
                <text fg={theme.textFaint}>{placeholder(columnWidths.version)}</text>
              </box>
              <box width={columnWidths.gap} />
              <box width={columnWidths.version}>
                <text fg={theme.textFaint}>{placeholder(columnWidths.version)}</text>
              </box>
              <box width={columnWidths.gap} />
              <box width={columnWidths.age}>
                <text fg={theme.textFaint}>{placeholder(columnWidths.age)}</text>
              </box>
            </box>
          ),
        }}
        emptyState={
          <Show
            when={store.filterText()}
            fallback={
              <Empty
                message={`No ${store.statusFilter() === "all" ? "" : `${store.statusFilter()} `}packages`}
                hint="f to cycle filters"
              />
            }
          >
            {(query: Accessor<string>) => (
              <Empty message={`No packages matching '${query()}'`} hint="esc to clear search" />
            )}
          </Show>
        }
        renderItem={(pkg, _index, selected) => {
          const isDependency = !pkg.isLeaf
          const nameFg = selected
            ? theme.text
            : isDependency
              ? theme.textDim
              : pkg.status === Hold.UpToDate
                ? theme.textMuted
                : theme.text

          return (
            <box flexDirection="row" height={1} flexGrow={1}>
              <box width={columnWidths.prefix}>
                <text>
                  <span style={{ fg: theme.accent, attributes: selected ? 1 : 0 }}>
                    {selected ? ` ${Icon.caretRight.char} ` : "   "}
                  </span>
                  <span style={{ fg: Status.color(pkg.status, theme), attributes: selected ? 1 : 0 }}>
                    {Status.glyph(pkg.status)}
                  </span>
                </text>
              </box>
              <box flexGrow={1} minWidth={columnWidths.nameMin} maxWidth={columnWidths.nameMax} overflow="hidden">
                {store.filterText() ? (
                  <Highlight
                    text={pkg.name}
                    query={store.filterText()}
                    fg={nameFg}
                    matchFg={theme.accent}
                    matchBg={theme.backgroundSelection}
                    bold={selected}
                  />
                ) : (
                  <text fg={nameFg} attributes={selected ? 1 : 0}>
                    {pkg.name}
                  </text>
                )}
              </box>
              <box width={columnWidths.dep}>
                <Show when={isDependency}>
                  <text fg={theme.textFaint}>{Icon.link.char}</text>
                </Show>
              </box>
              <box width={columnWidths.severity}>
                {(() => {
                  const severity = Status.topSeverity(pkg)
                  if (!severity) return null
                  const glyph = Status.severityGlyph(severity)
                  if (!glyph) return null
                  return (
                    <text fg={Status.severityColor(severity, theme)} attributes={selected ? 1 : 0}>
                      {` ${glyph}`}
                    </text>
                  )
                })()}
              </box>
              <box width={columnWidths.badge}>
                <Show
                  when={!pkg.trusted}
                  fallback={
                    <Show
                      when={pkg.shadowedBy}
                      fallback={
                        <Show when={isCustomTap(pkg.originTap) && pkg.originTap !== "cold-brew/cold-brew"}>
                          <text fg={Status.tapColor(pkg.originTap, theme)}>{` ${Icon.tap.char}`}</text>
                        </Show>
                      }
                    >
                      <text fg={Status.shadowColor(theme)}>{` ${Icon.ghost.char}`}</text>
                    </Show>
                  }
                >
                  <text fg={Status.untrustedColor(theme)}>{` ${Icon.untrusted.char}`}</text>
                </Show>
              </box>
              <box width={columnWidths.gap} />
              <box width={columnWidths.version} overflow="hidden">
                <text fg={selected ? theme.textSub : theme.textDim} attributes={selected ? 1 : 0}>
                  {pkg.installedVersion.padStart(columnWidths.version)}
                </text>
              </box>
              <box width={columnWidths.gap} overflow="hidden">
                <Show when={pkg.outdated}>
                  <text fg={selected ? theme.accent : theme.info} attributes={selected ? 1 : 0}>
                    {Icon.caretRight.char}
                  </text>
                </Show>
              </box>
              <box width={columnWidths.version} overflow="hidden">
                <text
                  fg={pkg.outdated ? (selected ? theme.accent : theme.info) : theme.textDim}
                  attributes={selected ? 1 : 0}
                >
                  {(pkg.outdated ? (pkg.latestVersion ?? "–") : "—").padStart(columnWidths.version)}
                </text>
              </box>
              <box width={columnWidths.gap} />
              <box width={columnWidths.age}>
                <text fg={Status.ageColor(pkg, theme, holdDays())} attributes={selected ? 1 : 0}>
                  {formatAgeDays(pkg.sourceAgeDays).padStart(columnWidths.age)}
                </text>
              </box>
            </box>
          )
        }}
      />
    </box>
  )
}
