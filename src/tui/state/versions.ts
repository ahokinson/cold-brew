import { createPicker, type PickerState } from "@ahokinson/press/models"
import type { TerminalHandover } from "@ahokinson/press/terminal"
import { brewInstallVersion, brewUpgrade, brewVersionHistory } from "@brew/api"
import type { Package } from "@brew/types"
import { clearVersionPin, getOriginalTap, logUpgrade, setVersionPin } from "@db"
import { createSignal } from "solid-js"

export interface VersionPickerState {
  versionPicker: PickerState<Package.VersionHistory>
  versionPickerOpen: () => boolean
  openVersionPicker: () => void
  closeVersionPicker: () => void
}

export function createVersionPickerState(
  selectedPackage: () => Package.WithStatus | undefined,
  onRefresh: () => Promise<void>,
  showMessage: (message: string, durationMilliseconds?: number) => void,
  handover: TerminalHandover,
): VersionPickerState {
  const [availableVersions, setAvailableVersions] = createSignal<Package.VersionHistory[]>([])

  const picker = createPicker<Package.VersionHistory>({
    items: availableVersions,
    shape: (entry) => {
      const selected = selectedPackage()
      const installed = selected != null && entry.version === selected.installedVersion
      const latest = selected != null && entry.version === selected.latestVersion
      return {
        id: entry.version,
        label: entry.version,
        ...(installed ? { hint: "installed" } : latest ? { hint: "latest" } : {}),
      }
    },
    onAccept: (entry) => {
      void installVersion(entry)
    },
  })

  async function openVersionPicker() {
    const selected = selectedPackage()
    if (!selected) return

    setAvailableVersions([])
    picker.setQuery("")
    picker.open()

    try {
      const versions = await brewVersionHistory(selected.name, selected.isCask, selected.tap)
      setAvailableVersions(versions)
      if (versions.length === 0) {
        showMessage("No version history available")
      }
    } catch {
      setAvailableVersions([])
      showMessage("Could not load version history — network may be unavailable")
    }
  }

  function closeVersionPicker() {
    picker.close()
    setAvailableVersions([])
  }

  async function installVersion(entry: Package.VersionHistory): Promise<void> {
    const selected = selectedPackage()
    if (!selected) return

    // brew refuses to load packages from untrusted taps, so any install/upgrade
    // would just fail. Surface the reason instead — parity with upgradePackage.
    if (!selected.trusted) {
      showMessage(`${selected.name} is from an untrusted tap (${selected.originTap})`)
      return
    }

    showMessage(`Installing ${selected.name} ${entry.version}...`, 30000)

    try {
      if (entry.version === selected.latestVersion) {
        const originalTap = getOriginalTap(selected.name)
        const result = await handover(() =>
          brewUpgrade([
            {
              name: selected.name,
              isCask: selected.isCask,
              tap: selected.tap,
              originalTap,
              installedVersion: selected.installedVersion,
            },
          ]),
        )
        if (result.exitCode !== 0) {
          showMessage(`Failed to upgrade ${selected.name} (exit ${result.exitCode})`)
          await onRefresh()
          return
        }
        // Only release the pin once we know the upgrade landed; otherwise a
        // failed brew run leaves the user pinned-but-not-at-pin in the UI.
        clearVersionPin(selected.name)
      } else {
        const exitCode = await handover(() =>
          brewInstallVersion(
            selected.name,
            entry.version,
            entry.commitHash,
            selected.isCask,
            // brewInstallVersion fetches source from this tap's GitHub repo and
            // records it as the original tap; for stepped packages `tap` is the
            // synthetic cold-brew/cold-brew, so use the resolved upstream origin.
            selected.originTap,
          ),
        )
        if (exitCode !== 0) {
          showMessage(`Failed to install ${selected.name} ${entry.version} (exit ${exitCode})`)
          await onRefresh()
          return
        }
        setVersionPin(selected.name, entry.version)
      }

      logUpgrade(selected.name, selected.installedVersion, entry.version, selected.sourceAgeDays)
      showMessage(`Installed ${selected.name} ${entry.version}`)
      await onRefresh()
    } catch {
      showMessage(`Failed to install ${selected.name} ${entry.version} — network may be unavailable`)
    }
  }

  return {
    versionPicker: picker,
    versionPickerOpen: picker.isOpen,
    openVersionPicker,
    closeVersionPicker,
  }
}
