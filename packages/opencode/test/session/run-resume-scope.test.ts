import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ActiveManifest, isResumeEligible, setManifestDir } from "@/session/active-manifest"

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = path.join(os.tmpdir(), "opencode-scope-test-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// Runs a helper script in a fresh process against the manifest in `dir`.
async function runHelper(dir: string, lines: string[]) {
  const helperDir = path.join(import.meta.dir, ".tmp-scope-" + Math.random().toString(36).slice(2))
  await fs.mkdir(helperDir, { recursive: true })
  const script = path.join(helperDir, "helper.ts")
  await fs.writeFile(
    script,
    [
      `import { ActiveManifest, setManifestDir } from "../../../src/session/active-manifest"`,
      `import { Effect } from "effect"`,
      `setManifestDir(process.argv[2]!)`,
      ...lines,
      `process.exit(0)`,
    ].join("\n"),
  )
  try {
    const proc = Bun.spawn([process.execPath, script, dir], { stdout: "inherit", stderr: "inherit" })
    expect(await proc.exited).toBe(0)
  } finally {
    await fs.rm(helperDir, { recursive: true, force: true })
  }
}

test("a process that never wrote does not delete the manifest on exit", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write({ id: "server-session", timestamp: Date.now() }))
    await runHelper(dir, [`await Effect.runPromise(ActiveManifest.read())`])
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions.map((s) => s.id)).toEqual(["server-session"])
  })
})

test("a process that wrote an entry clears the manifest on clean exit", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await runHelper(dir, [`await Effect.runPromise(ActiveManifest.write({ id: "writer-session", timestamp: Date.now() }))`])
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
  })
})

test("clearIfOwner in a non-writer process (the CLI finally path) keeps the manifest", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write({ id: "server-session", timestamp: Date.now() }))
    await runHelper(dir, [
      `if (ActiveManifest.ownsEntries()) throw new Error("helper must start as a non-writer")`,
      `await Effect.runPromise(ActiveManifest.clearIfOwner())`,
    ])
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions.map((s) => s.id)).toEqual(["server-session"])
  })
})

test("clearIfOwner in a writer process clears the manifest", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await runHelper(dir, [
      `await Effect.runPromise(ActiveManifest.write({ id: "writer-session", timestamp: Date.now() }))`,
      `await Effect.runPromise(ActiveManifest.clearIfOwner())`,
      `if (await Effect.runPromise(ActiveManifest.hasCrashed())) throw new Error("writer clearIfOwner must clear")`,
    ])
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
  })
})

test("isResumeEligible rejects non-interactive runs", async () => {
  await withTmpDir(async (dir) => {
    expect(isResumeEligible({ interactive: false, cwd: dir, directory: dir })).toBe(false)
  })
})

test("isResumeEligible rejects a session of a different directory", async () => {
  await withTmpDir(async (dir) => {
    const other = path.join(dir, "other")
    await fs.mkdir(other)
    expect(isResumeEligible({ interactive: true, cwd: dir, directory: other })).toBe(false)
  })
})

test("isResumeEligible rejects a session without a directory", async () => {
  await withTmpDir(async (dir) => {
    expect(isResumeEligible({ interactive: true, cwd: dir, directory: undefined })).toBe(false)
  })
})

test("isResumeEligible accepts the same directory", async () => {
  await withTmpDir(async (dir) => {
    expect(isResumeEligible({ interactive: true, cwd: dir, directory: dir })).toBe(true)
  })
})

test("isResumeEligible accepts a symlink to the same directory", async () => {
  await withTmpDir(async (dir) => {
    const real = path.join(dir, "real")
    const link = path.join(dir, "link")
    await fs.mkdir(real)
    await fs.symlink(real, link)
    expect(isResumeEligible({ interactive: true, cwd: link, directory: real })).toBe(true)
  })
})
