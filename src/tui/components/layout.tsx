import { copy } from "@ahokinson/press/clipboard"
import { Header, HelpOverlay } from "@ahokinson/press/components"
import {
  bindingHints,
  dispatchBindings,
  handleTextInput,
  type KeyBinding,
  type KeyEvent,
  type KeyHint,
} from "@ahokinson/press/keyboard"
import { createOverlayState } from "@ahokinson/press/models"
import { useResponsiveLayout } from "@ahokinson/press/terminal"
import { hasGitHubToken } from "@brew/api"
import { Status } from "@brew/status"
import { Hold, View } from "@brew/types"
import { resetDb } from "@db"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { ConfirmDialog } from "@tui/components/confirm"
import { Dashboard } from "@tui/components/dashboard"
import { Details, VersionPickerModal } from "@tui/components/details"
import { Search } from "@tui/components/search"
import { Settings } from "@tui/components/settings"
import { StatusBar } from "@tui/components/statusbar"
import { usePackages } from "@tui/context/packages"
import { useTheme } from "@tui/context/theme"
import { Icon } from "@tui/icons"
import { matchFor } from "@tui/keys"
import { Show } from "solid-js"

enum Key {
  Escape = "escape",
  Return = "return",
  Up = "up",
  Down = "down",
  CursorDown = "j",
  CursorUp = "k",
  JumpToTop = "g",
  JumpToBottom = "G",
  Search = "/",
  Upgrade = "u",
  UpgradeAll = "U",
  Versions = "v",
  Hold = "h",
  Trust = "t",
  Refresh = "r",
  Quit = "q",
  Filter = "f",
  OpenSettings = ",",
  Yank = "y",
  Help = "?",
  ResetDatabase = "D",
  RestoreTaps = "R",
  ToggleSection = "z",
}

const bind = (name: string, run: (event: KeyEvent) => void, hint?: KeyHint, group?: string): KeyBinding => ({
  match: matchFor(name),
  run,
  ...(hint ? { hint } : {}),
  ...(group ? { group } : {}),
})

export function Layout() {
  const dimensions = useTerminalDimensions()
  const store = usePackages()
  const theme = useTheme()
  const ui = createOverlayState<{ kind: "none" | "search" | "details" | "help" }>({ kind: "none" })
  const searchActive = () => ui.overlay().kind === "search"
  const detailsOverlay = () => ui.overlay().kind === "details"
  const helpOpen = () => ui.overlay().kind === "help"

  const layoutMode = useResponsiveLayout([
    { minWidth: 120, mode: "wide" },
    { minWidth: 80, mode: "standard" },
    { minWidth: 0, mode: "narrow" },
  ] as const)

  const listWidth = () => {
    switch (layoutMode()) {
      case "narrow":
        return "100%"
      case "standard":
        return "65%"
      case "wide":
        return "55%"
    }
  }

  const detailWidth = () => {
    switch (layoutMode()) {
      case "narrow":
        return "100%"
      case "standard":
        return "35%"
      case "wide":
        return "45%"
    }
  }

  const showDetailInline = () => layoutMode() !== "narrow" || detailsOverlay()

  // ---- Keybindings: one source of truth ----
  // Each mode returns the `KeyBinding[]` that's active for it. `dispatchBindings`
  // runs the first match; `bindingHints` projects the same list into the status
  // bar so the hints can never drift from the handlers.

  const defaultBindings = (): KeyBinding[] => {
    const selected = store.selectedPackage()
    const ready = store.stats().ready
    const list: KeyBinding[] = [
      bind(Key.CursorDown, () => store.setCursor((c) => c + 1)),
      bind(Key.Down, () => store.setCursor((c) => c + 1)),
      bind(Key.CursorUp, () => store.setCursor((c) => c - 1)),
      bind(Key.Up, () => store.setCursor((c) => c - 1)),
      bind(Key.JumpToTop, () => store.setCursor(0)),
      bind(Key.JumpToBottom, () => store.setCursor(Math.max(0, store.visiblePackages().length - 1))),
      bind(Key.Search, () => ui.set({ kind: "search" }), { key: "/", action: "search" }, "View"),
      bind(Key.Filter, () => store.cycleStatusFilter(), { key: "f", action: "filter" }, "View"),
      bind("tab", () => store.cycleSortBy(), { key: "tab", action: "sort" }, "View"),
      bind(Key.Refresh, () => store.refresh({ force: true }), { key: "r", action: "refresh" }, "View"),
      bind(Key.OpenSettings, () => store.openSettings(), { key: ",", action: "settings" }, "View"),
    ]
    if (layoutMode() === "narrow") {
      list.push(bind(Key.Return, () => ui.set({ kind: "details" }), { key: "enter", action: "details" }, "Navigate"))
      list.push(
        bind(Key.Escape, () => {
          if (detailsOverlay()) ui.close()
        }),
      )
    }
    if (selected && Status.isReady(selected)) {
      list.push(
        bind(
          Key.Upgrade,
          () => {
            const name = selected.name
            const ver = `${selected.installedVersion} → ${selected.latestVersion ?? "?"}`
            store.requestConfirm({
              message: `Upgrade ${name}?`,
              detail: ver,
              onConfirm: () => store.upgradePackage(name),
            })
          },
          { key: "u", action: "upgrade" },
          "Actions",
        ),
      )
    }
    if (selected) {
      list.push(
        bind(
          Key.ToggleSection,
          () => store.toggleSection(Status.section(selected)),
          { key: "z", action: "collapse" },
          "View",
        ),
      )
      list.push(bind(Key.Versions, () => store.openVersionPicker(), { key: "v", action: "versions" }, "Actions"))
      list.push(
        bind(
          Key.Hold,
          () => store.toggleHold(selected.name),
          { key: "h", action: selected.status === Hold.AlwaysHold ? "release" : "hold" },
          "Actions",
        ),
      )
      if (!selected.trusted) {
        list.push(
          bind(
            Key.Trust,
            () => {
              store.requestConfirm({
                message: `Trust ${selected.originTap}?`,
                detail: "Allows Homebrew to load packages from this tap.",
                onConfirm: () => store.trustTap(selected),
              })
            },
            { key: "t", action: "trust" },
            "Actions",
          ),
        )
      }
      list.push(
        bind(
          Key.Yank,
          () => {
            copy(selected.name).then((result) => {
              store.showMessage(result.ok ? `Copied ${selected.name}` : "Copy failed")
            })
          },
          { key: "y", action: "copy name" },
          "Actions",
        ),
      )
    }
    if (ready > 0) {
      list.push(
        bind(
          Key.UpgradeAll,
          () => {
            store.requestConfirm({
              message: `Upgrade ${ready} ready package${ready === 1 ? "" : "s"}?`,
              onConfirm: () => store.upgradeAllReady(),
            })
          },
          { key: "U", action: "upgrade all" },
          "Actions",
        ),
      )
    }
    list.push(bind(Key.Help, () => ui.set({ kind: "help" }), { key: "?", action: "help" }, "General"))
    list.push(bind(Key.Quit, () => process.exit(0)))
    return list
  }

  const confirmBindings = (): KeyBinding[] => [
    bind(Key.Return, () => store.executeConfirm(), { key: "enter", action: "confirm" }, "Confirm"),
    bind(Key.Escape, () => store.cancelConfirm(), { key: "esc", action: "cancel" }, "Confirm"),
  ]

  const settingsBindings = (): KeyBinding[] => [
    bind(Key.CursorUp, () => store.incrementHoldDays(), { key: "j/k", action: "adjust" }, "Settings"),
    bind(Key.Up, () => store.incrementHoldDays()),
    bind(Key.CursorDown, () => store.decrementHoldDays()),
    bind(Key.Down, () => store.decrementHoldDays()),
    bind(Key.RestoreTaps, () => {
      store.closeSettings()
      store.requestConfirm({
        message: "Restore all tap packages to official versions?",
        detail: "This will uninstall cold-brew tap packages and reinstall from official taps.",
        destructive: true,
        onConfirm: () => store.restoreAllTapPackages(),
      })
    }),
    bind(
      Key.ResetDatabase,
      () => {
        store.closeSettings()
        store.requestConfirm({
          message: "Reset the cold-brew database?",
          detail: "This will clear all cached data, policies, and version pins.",
          destructive: true,
          onConfirm: () => {
            resetDb()
            store.showMessage("Database reset — restarting...")
            store.refresh({ force: true })
          },
        })
      },
      { key: "D", action: "reset database" },
      "Settings",
    ),
    bind(Key.Escape, () => store.closeSettings(), { key: "esc", action: "close" }, "Settings"),
  ]

  const helpBindings = (): KeyBinding[] => [
    bind(Key.Escape, () => ui.close(), { key: "esc", action: "close" }, "Help"),
    bind(Key.Help, () => ui.close()),
    bind(Key.Quit, () => ui.close()),
  ]

  const searchHints: KeyHint[] = [
    { key: "esc", action: "clear" },
    { key: "enter", action: "keep" },
  ]

  // Version picker is a fuzzy modal: arrows move, printable chars type into the
  // query, enter installs the active row, esc cancels.
  const versionHints: KeyHint[] = [
    { key: "↑/↓", action: "navigate" },
    { key: "type", action: "filter" },
    { key: "enter", action: "install" },
    { key: "esc", action: "cancel" },
  ]

  const activeBindings = (): KeyBinding[] => {
    if (store.confirmAction()) return confirmBindings()
    if (store.settingsOpen()) return settingsBindings()
    if (helpOpen()) return helpBindings()
    return defaultBindings()
  }

  const activeHints = (): KeyHint[] => {
    if (searchActive()) return searchHints
    if (store.versionPickerOpen()) return versionHints
    return bindingHints(activeBindings())
  }

  function handleSearch(event: KeyEvent) {
    // Ctrl+C is the universal quit; these mode handlers run before dispatch
    // (which owns the global quit), so honor it here too.
    if (event.ctrl && event.name === "c") process.exit(0)
    if (event.name === Key.Escape) {
      ui.close()
      store.setFilterText("")
      return
    }
    if (event.name === Key.Return) {
      ui.close()
      return
    }
    handleTextInput((update) => store.setFilterText(update(store.filterText())), event)
  }

  function handleVersionPicker(event: KeyEvent) {
    if (event.ctrl && event.name === "c") process.exit(0)
    switch (event.name) {
      case Key.Up:
        store.versionPicker.move(-1)
        return
      case Key.Down:
        store.versionPicker.move(1)
        return
      case Key.Return:
        void store.versionPicker.accept()
        return
      case Key.Escape:
        store.closeVersionPicker()
        return
    }
    handleTextInput((update) => store.versionPicker.setQuery(update(store.versionPicker.query())), event)
  }

  const dispatch = dispatchBindings(activeBindings, () => process.exit(0))

  useKeyboard((event) => {
    if (searchActive()) {
      handleSearch(event)
      return
    }
    if (store.versionPickerOpen()) {
      handleVersionPicker(event)
      return
    }
    dispatch(event)
  })

  return (
    <box
      flexDirection="column"
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
    >
      <Header
        left={() => (
          <text>
            <span style={{ fg: theme.textMuted }}>{`${Icon.package.char} ${store.stats().total}`}</span>
            {store.stats().ready > 0 && (
              <span style={{ fg: theme.ready }}>{`  ${Icon.ready.char} ${store.stats().ready} ready`}</span>
            )}
            {store.stats().held > 0 && (
              <span style={{ fg: theme.fresh }}>{`  ${Icon.held.char} ${store.stats().held} held`}</span>
            )}
            {store.offline() && <span style={{ fg: theme.overdue }}>{`  offline`}</span>}
            {!hasGitHubToken() && <span style={{ fg: theme.stale }}>{`  ${Icon.triangleWarning.char} no token`}</span>}
          </text>
        )}
        right={() => (
          <text>
            <span style={{ fg: theme.textFaint }}>{`${store.positionLabel()} `}</span>
            {store.statusFilter() !== View.StatusFilter.All && (
              <span style={{ fg: theme.accent, bg: theme.backgroundSelection }}>{` ${store.statusFilter()} `}</span>
            )}
            <span style={{ fg: theme.textDim }}>{` ${Icon.sort.char} `}</span>
            <span style={{ fg: theme.accent }}>{store.sortBy()}</span>
          </text>
        )}
      ></Header>

      <Search active={searchActive} />

      <box flexDirection="row" flexGrow={1} gap={layoutMode() === "narrow" ? 0 : 1}>
        <Show when={layoutMode() !== "narrow" || !detailsOverlay()}>
          <box width={listWidth()} flexDirection="column">
            <Dashboard />
          </box>
        </Show>
        <Show when={showDetailInline()}>
          <box width={detailWidth()} flexDirection="column">
            <Show
              when={store.confirmAction()}
              fallback={
                <Show when={store.settingsOpen()} fallback={<Details />}>
                  <Settings />
                </Show>
              }
            >
              <ConfirmDialog />
            </Show>
          </box>
        </Show>
      </box>

      <StatusBar hints={activeHints} />

      <VersionPickerModal />
      <HelpOverlay when={helpOpen} bindings={defaultBindings} title="cold-brew · keys" />
    </box>
  )
}
