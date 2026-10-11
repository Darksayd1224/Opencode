import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { recover } from "@opencode-ai/core/session/recovery"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

describe("SessionRecovery readonly gate", () => {
  it.effect("treats invalid mutation gate values as readonly mode", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_RECOVERY_MUTATE = "not-a-bool"

      const result = yield* recover

      expect(result).toEqual({ mode: "readonly", messagesMatched: 0, partsMatched: 0, sessionsMatched: 0 })
      delete process.env.OPENCODE_RECOVERY_MUTATE
    }),
  )
})
