import type { PluginInput } from "@opencode-ai/plugin"

const MARKER = { open: (name: string) => `[[concept:${name}]]`, close: "[[/concept]]" }

let smallModel: { providerID: string; modelID: string } | undefined

export function setSmallModel(spec: string | undefined) {
  if (!spec) return
  const [providerID, ...rest] = spec.split("/")
  if (providerID && rest.length) smallModel = { providerID, modelID: rest.join("/") }
}

export async function tag(client: PluginInput["client"], text: string, diffContext: string) {
  const model = smallModel ?? { providerID: "opencode", modelID: "claude-haiku-4-5" }
  const session = await client.session.create({ throwOnError: true })
  try {
    const result = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        model,
        system:
          "You extract notable technical concepts from text. Do not call any tools. " +
          "Reply with ONLY a JSON array of short concept name strings that literally appear " +
          "(verbatim substrings) in the input. No prose, no markdown fences.",
        tools: { "*": false },
        parts: [{ type: "text", text: `${text}\n\n---\n${diffContext}` }],
      },
      throwOnError: true,
    })
    const raw = result.data.parts.find((part) => part.type === "text")?.text ?? "[]"
    const names: string[] = JSON.parse(raw)
    return applyMarkers(text, names)
  } finally {
    client.session.delete({ path: { id: session.data.id } }).catch(() => {})
  }
}

function applyMarkers(text: string, names: string[]) {
  return names.reduce((tagged, name) => {
    if (!name) return tagged
    const idx = tagged.toLowerCase().indexOf(name.toLowerCase())
    if (idx === -1) return tagged
    return tagged.slice(0, idx) + MARKER.open(name) + tagged.slice(idx, idx + name.length) + MARKER.close + tagged.slice(idx + name.length)
  }, text)
}
