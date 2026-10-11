import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { recover } from "@opencode-ai/core/session/recovery"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sessionID = SessionV2.ID.make("ses_recovery_test")
const parentID = SessionV1.MessageID.ascending("msg_parent")
const inflightID = SessionV1.MessageID.ascending("msg_inflight")
const stoppedID = SessionV1.MessageID.ascending("msg_stopped")
const staleCompletedID = SessionV1.MessageID.ascending("msg_stale_completed")
const runningPartID = SessionV1.PartID.ascending("prt_running")
const staleRunningPartID = SessionV1.PartID.ascending("prt_stale_running")
const providerID = ProviderV2.ID.make("provider")
const modelID = ModelV2.ID.make("model")
const decodeAssistant = Schema.decodeUnknownSync(SessionV1.Assistant)

const withRecoveryMutation = <A, E, R>(value: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.env.OPENCODE_RECOVERY_MUTATE),
    () => value,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.OPENCODE_RECOVERY_MUTATE
          return
        }
        process.env.OPENCODE_RECOVERY_MUTATE = previous
      }),
  )

function assistantData(input: {
  readonly id: SessionV1.MessageID
  readonly created: number
  readonly completed?: number
  readonly finish?: string
}): typeof MessageTable.$inferInsert.data {
  const message = decodeAssistant({
    id: input.id,
    sessionID,
    role: "assistant",
    time: { created: input.created, completed: input.completed },
    parentID,
    modelID,
    providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: input.finish,
  })
  const { id: _, sessionID: __, ...data } = message
  return data
}

function runningToolData(): Omit<SessionV1.ToolPart, "id" | "messageID" | "sessionID"> {
  return {
    type: "tool",
    callID: "call-running",
    tool: "bash",
    state: { status: "running", input: { command: "true" }, time: { start: 1002 } },
  }
}

const seedSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test-recovery",
      directory: "/project",
      title: "test-recovery",
      version: "test",
      time_created: 1000,
      time_updated: 1000,
    })
    .run()
  yield* db
    .insert(MessageTable)
    .values([
      { id: inflightID, session_id: sessionID, time_created: 1000, data: assistantData({ id: inflightID, created: 1000 }) },
      {
        id: stoppedID,
        session_id: sessionID,
        time_created: 2000,
        data: assistantData({ id: stoppedID, created: 2000, finish: "stop" }),
      },
      {
        id: staleCompletedID,
        session_id: sessionID,
        time_created: 3000,
        data: assistantData({ id: staleCompletedID, created: 3000, completed: 4000, finish: "tool" }),
      },
    ])
    .run()
  yield* db
    .insert(PartTable)
    .values([
      { id: runningPartID, message_id: inflightID, session_id: sessionID, time_created: 1001, data: runningToolData() },
      { id: staleRunningPartID, message_id: staleCompletedID, session_id: sessionID, time_created: 3001, data: runningToolData() },
    ])
    .run()
})

const loadMessage = (id: SessionV1.MessageID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, id), eq(MessageTable.session_id, sessionID)))
      .get()
    expect(row).toBeDefined()
    return row && Schema.decodeUnknownSync(SessionV1.Assistant)({ ...row.data, id: row.id, sessionID: row.session_id })
  })

const loadPart = (id: SessionV1.PartID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(PartTable).where(and(eq(PartTable.id, id), eq(PartTable.session_id, sessionID))).get()
    expect(row).toBeDefined()
    return row && Schema.decodeUnknownSync(SessionV1.ToolPart)({ ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id })
  })

describe("SessionRecovery", () => {
  it.effect("reports recovery candidates without mutating when the gate is disabled", () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_RECOVERY_MUTATE
      yield* seedSession

      const result = yield* recover

      expect(result).toEqual({ mode: "readonly", messagesMatched: 3, partsMatched: 2, sessionsMatched: 1 })
      expect((yield* loadMessage(inflightID))?.time.completed).toBeUndefined()
      expect((yield* loadMessage(inflightID))?.finish).toBeUndefined()
      expect((yield* loadPart(runningPartID))?.state.status).toBe("running")
      expect((yield* loadPart(staleRunningPartID))?.state.status).toBe("running")
    }),
  )

  it.effect("marks unfinished assistant messages interrupted when the gate is enabled", () =>
    withRecoveryMutation(
      Effect.gen(function* () {
        process.env.OPENCODE_RECOVERY_MUTATE = "1"
        yield* seedSession

        const result = yield* recover

        const inflight = yield* loadMessage(inflightID)
        const stopped = yield* loadMessage(stoppedID)
        const runningPart = yield* loadPart(runningPartID)
        const session = yield* (yield* Database.Service).db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()

        const staleCompleted = yield* loadMessage(staleCompletedID)
        const staleRunningPart = yield* loadPart(staleRunningPartID)

        expect(result).toEqual({ mode: "mutated", messagesMatched: 3, partsMatched: 2, sessionsMatched: 1 })
        expect(inflight?.time.completed).toBeNumber()
        expect(inflight?.finish).toBe("interrupted")
        expect(inflight?.error).toMatchObject({
          name: "MessageAbortedError",
          data: { message: "Session was interrupted by an OpenCode crash or restart" },
        })
        expect(stopped?.time.completed).toBeNumber()
        expect(stopped?.finish).toBe("stop")
        expect(staleCompleted?.time.completed).toBe(4000)
        expect(staleCompleted?.finish).toBe("tool")
        expect(runningPart?.state.status).toBe("error")
        if (runningPart?.state.status !== "error") throw new Error("Expected interrupted tool error")
        expect(runningPart?.state.error).toBe("Session was interrupted by an OpenCode crash or restart")
        expect(runningPart?.state.time?.start).toBeNumber()
        expect(runningPart?.state.time?.end).toBeNumber()
        expect(runningPart?.state.metadata?.interrupted).toBe(true)
        expect(staleRunningPart?.state.status).toBe("error")
        if (staleRunningPart?.state.status !== "error") throw new Error("Expected stale tool error")
        expect(staleRunningPart?.state.error).toBe("Session was interrupted by an OpenCode crash or restart")
        expect(staleRunningPart?.state.time?.start).toBeNumber()
        expect(staleRunningPart?.state.time?.end).toBeNumber()
        expect(staleRunningPart?.state.metadata?.interrupted).toBe(true)
        expect(session?.time_updated).toBeGreaterThan(1000)
      }),
    ),
  )
})
