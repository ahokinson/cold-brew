import { createRequiredContext } from "@ahokinson/press/context"
import { createTerminalHandover } from "@ahokinson/press/terminal"
import { useRenderer } from "@opentui/solid"
import { createPackageStore, type PackageStore } from "@tui/state/packages"
import { onMount } from "solid-js"

const { Provider: PackageStoreProvider, use: usePackages } = createRequiredContext<PackageStore>({
  name: "Packages",
  init: () => {
    const handover = createTerminalHandover(useRenderer())
    const store = createPackageStore({ handover })
    onMount(() => {
      store.refresh()
    })
    return store
  },
})

export { PackageStoreProvider, usePackages }
