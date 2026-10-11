import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { useToast } from "../../ui/toast"
import { TuiConfig, useTuiConfig } from "../../config"
import { errorMessage } from "../../util/error"
import type { DialogContext } from "../../ui/dialog"
import { messagePrompt, revertChoices, revertSession } from "./revert"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  queued?: boolean
  setPrompt?: (prompt: PromptInfo) => void
  restorePrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const tuiConfig = useTuiConfig()

  const revertOptions = revertChoices(TuiConfig.revertFiles(tuiConfig.revert)).map((choice) => ({
    title: choice.title,
    value: choice.value,
    description: choice.description,
    onSelect: (dialog: DialogContext) => {
      const msg = message()
      if (!msg) return
      const draft = messagePrompt(sync.data.part[msg.id] ?? [])
      const busy = (sync.data.session_status?.[props.sessionID]?.type ?? "idle") !== "idle"
      const done = revertSession({ sync, sdk, toast, sessionID: props.sessionID, messageID: msg.id, files: choice.files })
      // A running turn makes the server refuse the revert, so the prompt only comes back once it went through.
      if (busy) void done.then((reverted) => reverted && props.setPrompt?.(draft))
      if (!busy) props.setPrompt?.(draft)
      dialog.clear()
    },
  }))

  const unqueueOption = {
    title: "Unqueue",
    value: "session.unqueue",
    description: "take it back before the running turn reads it",
    onSelect: async (dialog: DialogContext) => {
      dialog.clear()
      const msg = message()
      if (!msg) return
      const draft = messagePrompt(sync.data.part[msg.id] ?? [])
      const result = await sdk.client.session
        .unqueue({ sessionID: props.sessionID, messageID: msg.id })
        .catch((error: unknown) => ({ error, data: undefined }))
      if (result.data) {
        props.restorePrompt?.(result.data.parts.length ? messagePrompt(result.data.parts) : draft)
        return
      }
      const error = result.error
      const started = error && typeof error === "object" && "reason" in error && error.reason === "started"
      toast.show({
        variant: started ? "warning" : "error",
        message: started
          ? "Not unqueued: the running turn has already picked it up"
          : `Not unqueued: ${error && typeof error === "object" && "message" in error ? String(error.message) : errorMessage(error)}`,
      })
    },
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        ...(props.queued ? [unqueueOption] : revertOptions),
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
