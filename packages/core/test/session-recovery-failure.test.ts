import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { recover } from "@opencode-ai/core/session/recovery"
import { testEffect } from "./lib/effect"

const failingDatabaseLayer = Layer.effect(Database.Service, Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run("DROP TABLE message")
  return database
})).pipe(Layer.provide(Database.layerFromPath(":memory:")))
const it = testEffect(AppNodeBuilder.build(Database.node, [[Database.node, failingDatabaseLayer]]))

describe("SessionRecovery failure containment", () => {
  it.effect("contains recovery defects instead of failing startup", () =>
    Effect.gen(function* () {
      const result = yield* recover

      expect(result).toEqual({ mode: "failed", messagesMatched: 0, partsMatched: 0, sessionsMatched: 0 })
    }),
  )
})
