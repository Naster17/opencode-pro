import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    return local.model.variant.options().map((item) => ({
      value: item.value,
      title: item.title,
      onSelect: () => {
        dialog.clear()
        local.model.variant.set(item.value === "default" ? undefined : item.value)
      },
    }))
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
