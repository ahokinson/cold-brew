import { InputBar } from "@ahokinson/press/components"
import { usePackages } from "@tui/context/packages"
import { Icon } from "@tui/icons"
import { Show } from "solid-js"

interface SearchProps {
  active: () => boolean
}

export function Search(props: SearchProps) {
  const store = usePackages()

  return (
    <Show when={props.active()}>
      <InputBar
        label={`${Icon.search.char} `}
        separator=" "
        cursor="_"
        buffer={() => store.filterText()}
        trailing={() => `${store.visiblePackages().length} matches`}
      />
    </Show>
  )
}
