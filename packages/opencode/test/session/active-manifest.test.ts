import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ActiveManifest, setManifestDir } from "@/session/active-manifest"

const sampleEntry = {
  id: "session-001",
  timestamp: Date.now(),
}

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test("writeActiveSession creates manifest with session", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe("session-001")
  })
})

test("writeActiveSession adds to existing manifest", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await Effect.runPromise(
      ActiveManifest.write({
        id: "session-002",
        timestamp: Date.now(),
      }),
    )
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(2)
  })
})

test("writeActiveSession updates existing session", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await Effect.runPromise(ActiveManifest.write({ ...sampleEntry, timestamp: 999 }))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].timestamp).toBe(999)
  })
})

test("removeActiveSession removes from manifest", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await Effect.runPromise(ActiveManifest.remove("session-001"))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)
  })
})

test("removeActiveSession deletes manifest file when last session removed", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await Effect.runPromise(ActiveManifest.remove("session-001"))
    const crashed = await Effect.runPromise(ActiveManifest.hasCrashed())
    expect(crashed).toBe(false)
  })
})

test("clearActiveSessions deletes the manifest file", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await Effect.runPromise(ActiveManifest.clear())
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)
  })
})

test("hasCrashed returns false when no manifest exists", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const crashed = await Effect.runPromise(ActiveManifest.hasCrashed())
    expect(crashed).toBe(false)
  })
})

test("hasCrashed returns true when manifest exists", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    const crashed = await Effect.runPromise(ActiveManifest.hasCrashed())
    expect(crashed).toBe(true)
  })
})

test("read returns empty array when manifest does not exist", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)
  })
})

test("read returns empty array for valid-but-wrong-shape JSON", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const manifestPath = path.join(dir, "active-sessions.json")
    await fs.writeFile(manifestPath, JSON.stringify({}))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)
  })
})

test("read returns empty array for valid array JSON", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const manifestPath = path.join(dir, "active-sessions.json")
    await fs.writeFile(manifestPath, JSON.stringify([]))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(0)
  })
})

test("write after corrupt-shape manifest recovers gracefully", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const manifestPath = path.join(dir, "active-sessions.json")
    await fs.writeFile(manifestPath, JSON.stringify({ sessions: "not-an-array" }))
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe("session-001")
  })
})

test("multi-session manifest preserves write order", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write({ id: "s1", timestamp: 1000 }))
    await Effect.runPromise(ActiveManifest.write({ id: "s2", timestamp: 2000 }))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe("s1")
    expect(sessions[sessions.length - 1].id).toBe("s2")
  })
})

// Local regression coverage for manifest durability and failure containment.
// Concurrent mutations must preserve all unrelated sessions.
// Remaining donor limitations are recorded explicitly rather than hidden.
// These tests exercise filesystem behavior, not only manifest serialization.

test("write is atomic: no .tmp file remains and manifest is valid JSON", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(["active-sessions.json"])
    const raw = await fs.readFile(path.join(dir, "active-sessions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed.sessions)).toBe(true)
    expect(parsed.sessions[0].id).toBe("session-001")
  })
})

test("serialized writers all land (per-write atomicity)", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const ids = Array.from({ length: 20 }, (_, i) => `serial-${i}`)
    for (const id of ids) {
      await Effect.runPromise(ActiveManifest.write({ id, timestamp: Date.now() }))
    }
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(ids.length)
    for (const s of sessions) expect(ids).toContain(s.id)
    expect(await fs.readdir(dir)).toEqual(["active-sessions.json"])
  })
})

test("concurrent writers and removers preserve every unrelated session", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const ids = Array.from({ length: 20 }, (_, i) => `concurrent-${i}`)
    await Promise.all(ids.map((id) => Effect.runPromise(ActiveManifest.write({ id, timestamp: 1 }))))
    expect((await Effect.runPromise(ActiveManifest.read())).map((entry) => entry.id).sort()).toEqual(ids.toSorted())
    await Promise.all(ids.slice(0, 10).map((id) => Effect.runPromise(ActiveManifest.remove(id))))
    expect((await Effect.runPromise(ActiveManifest.read())).map((entry) => entry.id).sort()).toEqual(ids.slice(10).toSorted())
    expect(await fs.readdir(dir)).toEqual(["active-sessions.json"])
  })
})

test("manifest I/O errors do not abort the session lifecycle", async () => {
  await withTmpDir(async (dir) => {
    const blocked = path.join(dir, "not-a-directory")
    await fs.writeFile(blocked, "fixture")
    setManifestDir(blocked)
    await expect(Effect.runPromise(ActiveManifest.write(sampleEntry))).resolves.toBeUndefined()
    await expect(Effect.runPromise(ActiveManifest.remove(sampleEntry.id))).resolves.toBeUndefined()
    await expect(Effect.runPromise(ActiveManifest.clear())).resolves.toBeUndefined()
    expect(await fs.readFile(blocked, "utf8")).toBe("fixture")
    setManifestDir(dir)
  })
})

test("stale entries older than 24h are returned unfiltered", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    const stale = { id: "stale-session", timestamp: Date.now() - 25 * 60 * 60 * 1000 }
    await fs.writeFile(path.join(dir, "active-sessions.json"), JSON.stringify({ sessions: [stale] }))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe("stale-session")
    // GAP: the donor implements no `Date.now() - timestamp > 24*60*60*1000`
    // staleness guard, so a >24h-old entry is still a resume candidate.
  })
})

test("resume candidate chooses newest timestamp instead of write order", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write({ id: "s-newest-ts", timestamp: 3000 }))
    await Effect.runPromise(ActiveManifest.write({ id: "s-oldest-ts", timestamp: 1000 }))
    const sessions = await Effect.runPromise(ActiveManifest.read())
    expect(ActiveManifest.resumeCandidate(sessions)?.id).toBe("s-newest-ts")
  })
})

test("resume candidate ties by smallest session id", async () => {
  const sessions = [
    { id: "session-b", timestamp: 1000 },
    { id: "session-a", timestamp: 1000 },
  ]

  expect(ActiveManifest.resumeCandidate(sessions)?.id).toBe("session-a")
})

test("failed consumption preserves the record and denies resume", async () => {
  await withTmpDir(async (dir) => {
    setManifestDir(dir)
    await Effect.runPromise(ActiveManifest.write(sampleEntry))
    await fs.chmod(dir, 0o500)
    try {
      expect(await Effect.runPromise(ActiveManifest.consume())).toBe(false)
      expect(await Effect.runPromise(ActiveManifest.read())).toEqual([sampleEntry])
    } finally {
      await fs.chmod(dir, 0o700)
    }
    expect(await Effect.runPromise(ActiveManifest.consume())).toBe(true)
    expect(await Effect.runPromise(ActiveManifest.hasCrashed())).toBe(false)
  })
})

