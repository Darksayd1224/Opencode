import path from "node:path"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import { Global } from "@opencode-ai/core/global"
import { Effect, Semaphore } from "effect"

export type ActiveSession = {
  id: string
  timestamp: number
}

type Manifest = { sessions: ActiveSession[] }

let manifestDir = Global.Path.data
const lock = Semaphore.makeUnsafe(1)
export function setManifestDir(dir: string) {
  manifestDir = dir
}

export function manifestPath() {
  return path.join(manifestDir, "active-sessions.json")
}

export function resumeCandidate(sessions: readonly ActiveSession[]): ActiveSession | undefined {
  return sessions.toSorted((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))[0]
}

// Best-effort: manifest errors must never crash the session lifecycle
async function readRaw(): Promise<Manifest> {
  const file = Bun.file(manifestPath())
  if (!(await file.exists())) return { sessions: [] }
  const parsed = await file.json().catch(() => null)
  if (!parsed || !Array.isArray(parsed.sessions)) return { sessions: [] }
  return { sessions: parsed.sessions }
}

async function writeRaw(manifest: Manifest): Promise<void> {
  const tmp = `${manifestPath()}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(tmp, JSON.stringify(manifest))
  await fs.rename(tmp, manifestPath())
}

const write = Effect.fn("ActiveManifest.write")(function* (entry: ActiveSession) {
  yield* Effect.tryPromise(async () => {
    const manifest = await readRaw()
    const without = manifest.sessions.filter((s) => s.id !== entry.id)
    without.push(entry)
    await writeRaw({ sessions: without })
  })
})

const remove = Effect.fn("ActiveManifest.remove")(function* (sessionID: string) {
  yield* Effect.tryPromise(async () => {
    const manifest = await readRaw()
    const without = manifest.sessions.filter((s) => s.id !== sessionID)
    if (without.length === 0) {
      const file = Bun.file(manifestPath())
      if (await file.exists()) await file.unlink()
      return
    }
    await writeRaw({ sessions: without })
  })
})

const read = Effect.fn("ActiveManifest.read")(function* () {
  const manifest = yield* Effect.tryPromise(() => readRaw())
  return manifest.sessions
})

const clear = Effect.fn("ActiveManifest.clear")(function* () {
  yield* Effect.tryPromise(async () => {
    const file = Bun.file(manifestPath())
    if (await file.exists()) await file.unlink()
  })
})

const hasCrashed = Effect.fn("ActiveManifest.hasCrashed")(function* () {
  return yield* Effect.tryPromise(() => Bun.file(manifestPath()).exists())
})

export const ActiveManifest = {
  write: (entry: ActiveSession) => lock.withPermit(write(entry)).pipe(Effect.uninterruptible, Effect.catch((error) => Effect.logWarning("active manifest write failed", { error }))),
  remove: (sessionID: string) => lock.withPermit(remove(sessionID)).pipe(Effect.uninterruptible, Effect.catch((error) => Effect.logWarning("active manifest remove failed", { error }))),
  read: () => lock.withPermit(read()).pipe(Effect.catch(() => Effect.succeed([] as ActiveSession[]))),
  clear: () => lock.withPermit(clear()).pipe(Effect.uninterruptible, Effect.catch((error) => Effect.logWarning("active manifest clear failed", { error }))),
  consume: () => lock.withPermit(clear()).pipe(Effect.uninterruptible, Effect.as(true), Effect.catch((error) => Effect.logWarning("active manifest consume failed", { error }).pipe(Effect.as(false)))),
  hasCrashed: () => hasCrashed().pipe(Effect.catch(() => Effect.succeed(false))),
  resumeCandidate,
}

// Synchronous cleanup on process.exit() — runs for clean exits but not for
// SIGKILL/crashes, which is exactly the desired crash-detection behavior.
process.on("exit", () => {
  try {
    fsSync.unlinkSync(manifestPath())
  } catch {}
})
