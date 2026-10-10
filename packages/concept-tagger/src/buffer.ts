const buffers = new Map<string, string[]>()

export function push(sessionID: string, block: string) {
  const list = buffers.get(sessionID) ?? []
  list.push(block)
  buffers.set(sessionID, list)
}

export function flush(sessionID: string) {
  const list = buffers.get(sessionID) ?? []
  buffers.delete(sessionID)
  return list.join("\n\n")
}
