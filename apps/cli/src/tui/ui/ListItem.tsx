import type { ParentProps } from "solid-js"
import { theme } from "../theme.ts"

type ListItemProps = ParentProps<{
  readonly selected: boolean
  readonly fullWidth?: boolean | undefined
  readonly justifyContent?: "space-between" | undefined
  readonly gap?: number
  readonly onMouseDown?: (() => void) | undefined
  readonly onMouseOver?: (() => void) | undefined
  readonly onMouseUp?: (() => void) | undefined
}>

export function listItemTextColor(props: {
  readonly selected: boolean
  readonly color?: string | undefined
  readonly muted?: boolean | undefined
}): string {
  if (props.selected) {
    return theme.background
  }
  if (props.color !== undefined) {
    return props.color
  }
  return props.muted === true ? theme.textMuted : theme.textSoft
}

export function ListItem(props: ListItemProps) {
  return (
    <box
      {...(props.fullWidth === true ? { width: "100%" } : {})}
      {...(props.fullWidth === true ? {} : { alignSelf: "flex-start" })}
      flexDirection="row"
      {...(props.justifyContent === undefined ? {} : { justifyContent: props.justifyContent })}
      gap={props.gap ?? 1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? theme.textSecondary : theme.backgroundPanel}
      onMouseDown={() => props.onMouseDown?.()}
      onMouseOver={() => props.onMouseOver?.()}
      onMouseUp={() => props.onMouseUp?.()}
    >
      {props.children}
    </box>
  )
}

export function ListItemText(
  props: ParentProps<{
    readonly selected: boolean
    readonly color?: string | undefined
    readonly muted?: boolean | undefined
  }>
) {
  return <text fg={listItemTextColor(props)}>{props.children}</text>
}
