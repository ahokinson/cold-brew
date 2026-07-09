import { createFilterableListState } from "@ahokinson/press/models"
import type { ScrollRef } from "@ahokinson/press/signals"
import { Status } from "@brew/status"
import { Hold, type Package, View } from "@brew/types"

export type { ScrollRef }

const statusOrder: Record<Hold.Status, number> = {
  [Hold.Ready]: 0,
  [Hold.AlwaysAllow]: 0,
  [Hold.Held]: 1,
  [Hold.AlwaysHold]: 1,
  [Hold.BrewPinned]: 1,
  [Hold.ColdBrewPinned]: 2,
  [Hold.AheadOfUpstream]: 2,
  [Hold.UpToDate]: 2,
}

function fieldCompare(a: Package.WithStatus, b: Package.WithStatus, field: View.SortField): number {
  switch (field) {
    case View.SortField.Name:
      return a.name.localeCompare(b.name)
    case View.SortField.Status:
      return statusOrder[a.status] - statusOrder[b.status]
    case View.SortField.Age:
      return a.sourceAgeDays - b.sourceAgeDays
    case View.SortField.Installed:
      return b.installedAt - a.installedAt
    case View.SortField.Severity:
      return (b.advisories?.maxCvss ?? -1) - (a.advisories?.maxCvss ?? -1)
  }
}

// Within a section, cold-brew lifts top-level packages above their dependencies,
// then sorts by the active field, then falls back to name for stability.
function withTieBreakers(field: View.SortField): (a: Package.WithStatus, b: Package.WithStatus) => number {
  return (a, b) => {
    if (a.isLeaf !== b.isLeaf) return a.isLeaf ? -1 : 1
    const r = fieldCompare(a, b, field)
    if (r !== 0) return r
    return a.name.localeCompare(b.name)
  }
}

const sorts: Record<View.SortField, (a: Package.WithStatus, b: Package.WithStatus) => number> = {
  [View.SortField.Name]: withTieBreakers(View.SortField.Name),
  [View.SortField.Status]: withTieBreakers(View.SortField.Status),
  [View.SortField.Age]: withTieBreakers(View.SortField.Age),
  [View.SortField.Installed]: withTieBreakers(View.SortField.Installed),
  [View.SortField.Severity]: withTieBreakers(View.SortField.Severity),
}

const sortCycle: ReadonlyArray<View.SortField> = [
  View.SortField.Name,
  View.SortField.Status,
  View.SortField.Severity,
  View.SortField.Age,
  View.SortField.Installed,
]

const filters: Record<View.StatusFilter, (pkg: Package.WithStatus) => boolean> = {
  [View.StatusFilter.Actionable]: (pkg) =>
    pkg.status !== Hold.UpToDate && pkg.status !== Hold.ColdBrewPinned && pkg.status !== Hold.AheadOfUpstream,
  [View.StatusFilter.Ready]: Status.isReady,
  [View.StatusFilter.Held]: Status.isHeld,
  [View.StatusFilter.All]: () => true,
}

const filterCycle: ReadonlyArray<View.StatusFilter> = [
  View.StatusFilter.Actionable,
  View.StatusFilter.Ready,
  View.StatusFilter.Held,
  View.StatusFilter.All,
]

export interface ListState {
  cursor: () => number
  setCursor: (v: number | ((prev: number) => number)) => void
  filterText: () => string
  setFilterText: (v: string) => void
  filteredPackages: () => Package.WithStatus[]
  visiblePackages: () => Package.WithStatus[]
  collapsedSections: () => ReadonlySet<number>
  toggleSection: (sectionId: number) => void
  sortBy: () => View.SortField
  cycleSortBy: () => void
  statusFilter: () => View.StatusFilter
  setStatusFilter: (v: View.StatusFilter) => void
  cycleStatusFilter: () => void
  positionLabel: () => string
  selectedPackage: () => Package.WithStatus | undefined
  scrollRow: () => number
}

export function createListState(rawPackages: () => Package.WithStatus[]): ListState {
  const state = createFilterableListState<Package.WithStatus, View.SortField, View.StatusFilter, number>({
    items: rawPackages,
    search: (pkg, query) =>
      pkg.name.toLowerCase().includes(query) || (pkg.description?.toLowerCase().includes(query) ?? false),
    sorts,
    sortCycle,
    defaultSort: View.SortField.Status,
    filters,
    filterCycle,
    defaultFilter: View.StatusFilter.All,
    section: {
      key: Status.section,
      headerRows: (key) => (Status.sectionLabel(key) ? 1 : 0),
    },
  })

  return {
    cursor: state.cursor,
    setCursor: state.setCursor,
    filterText: state.filterText,
    setFilterText: state.setFilterText,
    filteredPackages: state.filteredItems,
    visiblePackages: state.visibleItems,
    collapsedSections: state.collapsedSections,
    toggleSection: state.toggleSection,
    sortBy: state.sortBy,
    cycleSortBy: state.cycleSortBy,
    statusFilter: () => state.statusFilter() ?? View.StatusFilter.All,
    setStatusFilter: state.setStatusFilter,
    cycleStatusFilter: state.cycleStatusFilter,
    positionLabel: state.positionLabel,
    selectedPackage: state.selectedItem,
    scrollRow: state.scrollRow,
  }
}
