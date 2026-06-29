import { theme } from "../theme.ts"

const LABEL_WIDTH = 18

/**
 * A label/value detail row used by the report screens.
 */
export function Field(props: {
  readonly label: string
  readonly value: string
  readonly color?: string
}) {
  if (props.label.length > LABEL_WIDTH) {
    return (
      <box flexDirection="column">
        <text fg={theme.textMuted}>{props.label}</text>
        <box paddingLeft={2}>
          <text fg={props.color ?? theme.textSoft} wrapMode="word">
            {props.value}
          </text>
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.textMuted}>{props.label.padEnd(LABEL_WIDTH)}</text>
      <text fg={props.color ?? theme.textSoft} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}
