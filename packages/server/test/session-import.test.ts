import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })
  return (path: string, body?: unknown, status = 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      expect(response.status).toBe(status)
      return json
    })
})

it.live("preserves imported parentID through HTTP import, read, and parent filter", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parent = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", { title: "Parent" }))
    const id = Session.ID.create()
    const imported = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/experimental/session/import", {
        info: { ...parent.data, id, parentID: parent.data.id, title: "Imported child" },
        messages: [],
      }),
    )
    const read = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${id}`))
    const children = Schema.decodeUnknownSync(SessionsResponse)(
      yield* request(`/api/session?parentID=${parent.data.id}`),
    )
    expect({
      imported: imported.data.parentID,
      read: read.data.parentID,
      children: children.data.map((child) => child.id),
    }).toEqual({ imported: parent.data.id, read: parent.data.id, children: [id] })
  }).pipe(Effect.scoped),
)
;["missing", "self"].forEach((parent) => {
  it.live(`rejects a ${parent} parent without creating the imported session`, () =>
    Effect.gen(function* () {
      const request = yield* setup
      const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
      const id = Session.ID.create()
      const parentID = parent === "self" ? id : Session.ID.create()
      const error = yield* request(
        "/api/experimental/session/import",
        { info: { ...template.data, id, parentID }, messages: [] },
        404,
      )
      expect(error).toMatchObject({ _tag: "SessionNotFoundError", sessionID: parentID })
      expect(yield* request(`/api/session/${id}`, undefined, 404)).toMatchObject({
        _tag: "SessionNotFoundError",
        sessionID: id,
      })
    }).pipe(Effect.scoped),
  )
})

it.live("rejects an import whose message IDs already exist with a conflict", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const message = {
      id: "msg_import_conflict_fixture",
      type: "user",
      text: "Hello",
      time: { created: 1_700_000_000_000 },
    }
    const first = Session.ID.create()
    yield* request("/api/experimental/session/import", { info: { ...template.data, id: first }, messages: [message] })

    const second = Session.ID.create()
    const conflict = yield* request(
      "/api/experimental/session/import",
      { info: { ...template.data, id: second }, messages: [message] },
      409,
    )
    expect(conflict).toMatchObject({ _tag: "ConflictError", resource: second })
    // The conflicting import must not create the destination session.
    expect(yield* request(`/api/session/${second}`, undefined, 404)).toMatchObject({
      _tag: "SessionNotFoundError",
    })
  }).pipe(Effect.scoped),
)
