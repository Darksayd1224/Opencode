import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { node as SessionProjectorNode } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"

const sessionID = SessionV2.ID.make("ses_recovery_startup_test")
const parentID = SessionV1.MessageID.ascending("msg_startup_parent")
const messageID = SessionV1.MessageID.ascending("msg_startup_inflight")
const partID = SessionV1.PartID.ascending("prt_startup_running")
const providerID = ProviderV2.ID.make("provider")
const modelID = ModelV2.ID.make("model")
const decodeAssistant = Schema.decodeUnknownSync(SessionV1.Assistant)

function dbPath() {
  return join(mkdtempSync(join(tmpdir(), "opencode-recovery-startup-")), "opencode.db")
}

function databaseLayer(filename: string) {
  return Database.layerFromPath(filename)
}

function projectorLayer(filename: string) {
  return AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjectorNode]), [
    [Database.node, databaseLayer(filename)],
  ])
}

function runEffect<A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R, E>) {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)))
}

function assistantData(): typeof MessageTable.$inferInsert.data {
  const message = decodeAssistant({
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1000 },
    parentID,
    modelID,
    providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const { id: _, sessionID: __, ...data } = message
  return data
}

function runningToolData(): Omit<SessionV1.ToolPart, "id" | "messageID" | "sessionID"> {
  return {
    type: "tool",
    callID: "call-startup-running",
    tool: "bash",
    state: { status: "running", input: { command: "true" }, time: { start: 1002 } },
  }
}

const seedInterruptedMessage = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "startup-recovery",
      directory: "/project",
      title: "startup-recovery",
      version: "test",
      time_created: 1000,
      time_updated: 1000,
    })
    .run()
  yield* db.insert(MessageTable).values({ id: messageID, session_id: sessionID, time_created: 1000, data: assistantData() }).run()
  yield* db
    .insert(PartTable)
    .values({ id: partID, message_id: messageID, session_id: sessionID, time_created: 1001, data: runningToolData() })
    .run()
})

const loadMessage = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
    .get()
  expect(row).toBeDefined()
  return row && Schema.decodeUnknownSync(SessionV1.Assistant)({ ...row.data, id: row.id, sessionID: row.session_id })
})

const loadPart = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(PartTable).where(and(eq(PartTable.id, partID), eq(PartTable.session_id, sessionID))).get()
  expect(row).toBeDefined()
  return row && Schema.decodeUnknownSync(SessionV1.ToolPart)({ ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id })
})

async function withRecoveryMutation(value: string | undefined, run: () => Promise<void>) {
  const previous = process.env.OPENCODE_RECOVERY_MUTATE
  try {
    if (value === undefined) delete process.env.OPENCODE_RECOVERY_MUTATE
    else process.env.OPENCODE_RECOVERY_MUTATE = value
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_RECOVERY_MUTATE
    else process.env.OPENCODE_RECOVERY_MUTATE = previous
  }
}

describe("SessionRecovery startup wiring", () => {
  test("leaves interrupted assistant messages unchanged when the mutation gate is disabled", async () => {
    const filename = dbPath()
    await runEffect(seedInterruptedMessage, databaseLayer(filename))

    await withRecoveryMutation(undefined, () => runEffect(Effect.void, projectorLayer(filename)))
    const message = await runEffect(loadMessage, databaseLayer(filename))
    const part = await runEffect(loadPart, databaseLayer(filename))

    expect(message?.time.completed).toBeUndefined()
    expect(message?.finish).toBeUndefined()
    expect(part?.state.status).toBe("running")
  })

  test("marks interrupted assistant messages through projector startup when the mutation gate is enabled", async () => {
    const filename = dbPath()
    await runEffect(seedInterruptedMessage, databaseLayer(filename))

    await withRecoveryMutation("1", () => runEffect(Effect.void, projectorLayer(filename)))
    const message = await runEffect(loadMessage, databaseLayer(filename))
    const part = await runEffect(loadPart, databaseLayer(filename))

    expect(message?.time.completed).toBeNumber()
    expect(message?.finish).toBe("interrupted")
    expect(part?.state.status).toBe("error")
    if (part?.state.status !== "error") throw new Error("Expected interrupted tool error")
    expect(part?.state.error).toBe("Session was interrupted by an OpenCode crash or restart")
    expect(part?.state.time?.start).toBeNumber()
    expect(part?.state.time?.end).toBeNumber()
    expect(part?.state.metadata?.interrupted).toBe(true)
  })
})
