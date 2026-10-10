export function captureBlock(input: { tool: string; args: any }, output: { metadata: any }) {
  if (input.tool === "edit" && output.metadata?.filediff?.patch) return output.metadata.filediff.patch as string
  if (input.tool === "write" && typeof input.args?.content === "string")
    return `=== new file: ${input.args.filePath} ===\n${input.args.content}`
  return undefined
}
