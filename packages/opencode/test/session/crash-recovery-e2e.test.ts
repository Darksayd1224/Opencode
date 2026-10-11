import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ActiveManifest, setManifestDir } from "@/session/active-manifest"

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = path.join(os.tmpdir(), "opencode-e2e-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("E2E: crash leaves manifest, clean shutdown clears it", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)

    // 1. Simulate sessions going busy
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: Date.now() }))
    await Effect.runPromise(ActiveManifest.write({ id: "s2", timestamp: Date.now() }))

    // 2. Crash: manifest should persist
    const afterCrash = await Effect.runPromise(ActiveManifest.read())
    expect(afterCrash).toHaveLength(2)
    const crashed = await Effect.runPromise(ActiveManifest.hasCrashed())
    expect(crashed).toBe(true)

    // 3. Simulate one session going idle
    await Effect.runPromise(ActiveManifest.remove("s1"))
    const afterIdle = await Effect.runPromise(ActiveManifest.read())
    expect(afterIdle).toHaveLength(1)
    expect(afterIdle[0].id).toBe("s2")

    // 4. Simulate last session going idle
    await Effect.runPromise(ActiveManifest.remove("s2"))
    const afterLastIdle = await Effect.runPromise(ActiveManifest.read())
    expect(afterLastIdle).toHaveLength(0)

    // 5. After all sessions idle, manifest file should be deleted
    const fileExists = await Effect.runPromise(ActiveManifest.hasCrashed())
    expect(fileExists).toBe(false)
  })
})

test("E2E: crash with multiple sessions, then clean shutdown clears all", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)

    // 1. Multiple sessions active
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: Date.now() }))
    await Effect.runPromise(ActiveManifest.write({ id: "s2", timestamp: Date.now() }))
    await Effect.runPromise(ActiveManifest.write({ id: "s3", timestamp: Date.now() }))

    // 2. Crash — manifest persists with all sessions
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(true)
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(3)

    // 3. Clean shutdown — manifest cleared
    await Effect.runPromise(ActiveManifest.clear())
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
    expect(await Effect.runPromise(ActiveManifest.read())).toHaveLength(0)
  })
})

test("E2E: manifest survives corrupt JSON (graceful degradation)", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)

    // Write corrupt JSON to manifest file
    const manifestPath = path.join(dir, "active-sessions.json")
    await fs.writeFile(manifestPath, "{ broken json")

    // Read should return empty array, not throw
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)

    // hasCrashed should still return true (file exists)
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(true)

    // After clear, file is gone
    await Effect.runPromise(ActiveManifest.clear())
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
  })
})

test("E2E: write-update cycle preserves only latest entry per session", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)

    // Write session with timestamp T1
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 1000 }))

    // Update same session with timestamp T2
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 2000 }))

    // Should have only one entry with latest timestamp
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].timestamp).toBe(2000)

    // Write a second session
    await Effect.runPromise(ActiveManifest.write({ id: "s2", timestamp: 3000 }))
    const sessions2 = await Effect.runPromise(ActiveManifest.read())
    expect(sessions2).toHaveLength(2)
  })
})

// --- Local additions (Task 4, opencode-crash-auto-resume) ---
// Protocol-level tests for the consume-then-dispatch order used by run.ts
// (ActiveManifest.clear() runs before the candidate is returned for dispatch).

test("E2E: each crash record is consumed at most once across two restarts", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const dispatches: string[] = []
    // Same consume-then-dispatch order as RunCommand: tombstone first.
    const startup = async () => {
      if (!(await Effect.runPromise(ActiveManifest.hasCrashed()))) return
      const active = await Effect.runPromise(ActiveManifest.read())
      if (active.length === 0) return
      const candidate = ActiveManifest.resumeCandidate(active)
      if (!candidate) return
      await Effect.runPromise(ActiveManifest.clear())
      dispatches.push(candidate.id)
    }

    // Crash #1: session busy, process dies without cleanup.
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 1000 }))
    await startup()
    expect(dispatches).toEqual(["s1"])
    // The record is gone after consumption.
    expect(await Effect.runPromise(ActiveManifest.read())).toHaveLength(0)

    // Resumed session goes busy again (mirrors SessionStatus.set), crash #2.
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 2000 }))
    await startup()
    // One dispatch for the NEW record (timestamp 2000); the timestamp-1000
    // record was already consumed and cannot dispatch a second time.
    expect(dispatches).toEqual(["s1", "s1"])
    expect(await Effect.runPromise(ActiveManifest.read())).toHaveLength(0)

    // Restart with no fresh crash record dispatches nothing.
    await startup()
    expect(dispatches).toHaveLength(2)
  })
})

test("E2E: crash between consume and dispatch never re-dispatches", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 1000 }))

    // Startup: crash detected, candidate read, tombstone written — then the
    // process dies BEFORE the dispatch happens.
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(true)
    const active = await Effect.runPromise(ActiveManifest.read())
    expect(active).toHaveLength(1)
    await Effect.runPromise(ActiveManifest.clear())
    // <<< simulated crash here: dispatch never ran >>>

    // Next startup: no manifest remains, so there is nothing to resume and no
    // duplicate dispatch can occur (at-most-once holds; the trade-off is that
    // this crash record is lost, which is the safe direction).
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
    expect(await Effect.runPromise(ActiveManifest.read())).toHaveLength(0)
  })
})

test("E2E: repeated unclean restarts keep the manifest until a clean shutdown", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    for (let i = 0; i < 5; i++) {
      // OOM-style loop: session goes busy, process dies again without cleanup.
      await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 1000 + i }))
      expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(true)
      const sessions = await Effect.runPromise(ActiveManifest.read())
      expect(sessions).toHaveLength(1)
      expect(sessions[0].timestamp).toBe(1000 + i)
    }
    // A clean shutdown still clears the manifest after the loop.
    await Effect.runPromise(ActiveManifest.clear())
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
  })
})

test("E2E: a non-writer's clean exit keeps another process's entries", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    // Helper scripts live under the package so workspace imports resolve.
    const helperDir = path.join(import.meta.dir, ".tmp-clean-exit-" + Math.random().toString(36).slice(2))
    await fs.mkdir(helperDir, { recursive: true })
    const modulePath = "../../../src/session/active-manifest"
    const procA = path.join(helperDir, "proc-a.ts")
    const procB = path.join(helperDir, "proc-b.ts")
    await fs.writeFile(
      procA,
      [
        `import { ActiveManifest, setManifestDir } from "${modulePath}"`,
        `import { Effect } from "effect"`,
        `setManifestDir(process.argv[2]!)`,
        `await Effect.runPromise(ActiveManifest.write({ id: "proc-a-session", timestamp: Date.now() }))`,
        `console.log("READY")`,
        `await new Promise((r) => setTimeout(r, 15000))`,
      ].join("\n"),
    )
    await fs.writeFile(
      procB,
      [
        `import { setManifestDir } from "${modulePath}"`,
        `setManifestDir(process.argv[2]!)`,
        `process.exit(0)`,
      ].join("\n"),
    )
    try {
      // Process A writes an entry and stays alive (still-running process).
      const a = Bun.spawn([process.execPath, procA, dir], { stdout: "pipe", stderr: "inherit" })
      const reader = a.stdout.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      const deadline = Date.now() + 10000
      while (!buf.includes("READY") && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
      }
      expect(buf).toContain("READY")
      expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(true)

      // Process B starts (registering the module's process.on("exit") cleanup)
      // and exits cleanly without ever writing an entry.
      const b = Bun.spawn([process.execPath, procB, dir], { stdout: "inherit", stderr: "inherit" })
      expect(await b.exited).toBe(0)

      // Local scope fix: B never wrote an entry, so its clean exit must NOT
      // remove the manifest that still holds A's live entry (plan requirement;
      // the donor cleared unconditionally).
      const file = Bun.file(path.join(dir, "active-sessions.json"))
      expect(await file.exists()).toBe(true)
      const kept = await Effect.runPromise(ActiveManifest.read())
      expect(kept.map((s) => s.id)).toEqual(["proc-a-session"])

      a.kill()
      await a.exited
    } finally {
      await fs.rm(helperDir, { recursive: true, force: true })
    }
  })
})
