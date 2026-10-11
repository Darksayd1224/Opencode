import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiConfig } from "../config"
import { useBindings } from "../keymap"
import { createPromptUndo } from "../prompt/undo"
import { useDialog } from "../ui/dialog"
import { onClick } from "../ui/click"

export type DialogPasteProps = {
  text: string
  onChange(text: string): void
  onInline(): void
}

// The text behind a paste placeholder, in the prompt's own editor: the same textarea, input
// keybinds, mouse caret placement and grouped undo. Enter adds a line rather than submitting.
// Closing it keeps the edits; Inline replaces the placeholder with the text.
export function DialogPaste(props: DialogPasteProps) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const [lines, setLines] = createSignal(props.text.split("\n").length)
  const undo = createPromptUndo({ depth: () => tuiConfig.prompt?.undo_depth ?? 500 })
  let textarea: TextareaRenderable
  let applying = false

  const state = () => ({ input: textarea.plainText, parts: [], mode: "normal" as const, cursor: textarea.cursorOffset })

  function step(direction: "undo" | "redo") {
    undo.observe(state())
    const next = direction === "undo" ? undo.undo(state()) : undo.redo(state())
    if (!next) return
    applying = true
    textarea.setText(next.input)
    textarea.cursorOffset = next.cursor
    applying = false
    undo.sync(state())
    props.onChange(next.input)
  }

  useBindings(() => ({
    target,
    enabled: target() !== undefined,
    priority: 1,
    commands: [
      { name: "input.submit", title: "New line", category: "Dialog", run: () => void textarea.newLine() },
      { name: "input.undo", title: "Undo", category: "Dialog", run: () => step("undo") },
      { name: "input.redo", title: "Redo", category: "Dialog", run: () => step("redo") },
    ],
  }))

  onMount(() => {
    dialog.setSize("xlarge")
    textarea.gotoBufferHome()
    undo.sync(state())
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Pasted text <span style={{ fg: theme.textMuted }}>{lines()} lines</span>
        </text>
        <text fg={theme.textMuted} {...onClick(() => dialog.clear())}>
          esc save
        </text>
      </box>
      <textarea
        width="100%"
        height={Math.max(3, dimensions().height - 14)}
        initialValue={props.text}
        ref={(value: TextareaRenderable) => {
          textarea = value
          setTarget(value)
        }}
        onContentChange={() => {
          const text = textarea.plainText
          setLines(text.split("\n").length)
          props.onChange(text)
          if (!applying) undo.observe(state())
        }}
        onCursorChange={() => {
          if (!applying) undo.observe(state())
        }}
        onMouseDown={(event: { target?: { focus(): void } | null }) => event.target?.focus()}
        textColor={theme.text}
        focusedTextColor={theme.text}
        backgroundColor={theme.backgroundElement}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.text}
        cursorStyle={tuiConfig.cursor}
        syntaxStyle={syntax()}
      />
      <box paddingBottom={1} flexDirection="row" gap={2}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.primary}
          {...onClick(() => {
            props.onInline()
            dialog.clear()
          })}
        >
          <text fg={theme.selectedListItemText}>Inline</text>
        </box>
        <text fg={theme.textMuted}>replaces the placeholder with this text</text>
      </box>
    </box>
  )
}
