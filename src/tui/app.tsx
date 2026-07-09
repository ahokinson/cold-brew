import { Layout } from "@tui/components/layout"
import { PackageStoreProvider } from "@tui/context/packages"
import { ThemeProvider } from "@tui/context/theme"

function App() {
  return (
    <ThemeProvider>
      <PackageStoreProvider>
        <Layout />
      </PackageStoreProvider>
    </ThemeProvider>
  )
}

export async function launchTUI() {
  const { render } = await import("@opentui/solid")

  await render(() => <App />)
}
