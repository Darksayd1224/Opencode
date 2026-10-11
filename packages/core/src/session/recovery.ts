import { and, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { Database } from "../database/database"
import { MessageTable, PartTable, SessionTable } from "./sql"

export type Result = {
  readonly mode: "readonly" | "mutated" | "failed"
  readonly messagesMatched: number
  readonly partsMatched: number
  readonly sessionsMatched: number
}

const interruptedMessage = "Session was interrupted by an OpenCode crash or restart"

function mutationEnabled() {
  return process.env.OPENCODE_RECOVERY_MUTATE === "1" || process.env.OPENCODE_RECOVERY_MUTATE === "true"
}

const emptyResult = (mode: Result["mode"]): Result => ({
  mode,
  messagesMatched: 0,
  partsMatched: 0,
  sessionsMatched: 0,
})

/**
 * Recovers sessions that were interrupted by a crash or forced restart.
 *
 * When the process crashes while an LLM response is in flight, the last
 * assistant message may have been persisted (via durable PartUpdated events)
 * but never received its completion timestamp (time.completed). This routine
 * finds such sessions and marks the incomplete message as interrupted. It also
 * recovers stale pending/running tool parts under already-completed assistant
 * messages with schema-valid state timing so they don't leave a session visibly
 * stuck after restart.
 */
const recoverUnsafe = Effect.fn("SessionRecovery.recoverUnsafe")(function* () {
  const { db } = yield* Database.Service

  const rows = yield* db
    .select({ session_id: MessageTable.session_id, message_id: MessageTable.id })
    .from(MessageTable)
    .where(
      and(
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`(
          json_extract(${MessageTable.data}, '$.time.completed') IS NULL
          OR EXISTS (
            SELECT 1
            FROM ${PartTable}
            WHERE ${PartTable.message_id} = ${MessageTable.id}
              AND ${PartTable.session_id} = ${MessageTable.session_id}
              AND json_extract(${PartTable.data}, '$.type') = 'tool'
              AND json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')
          )
        )`,
      ),
    )
    .all()

  if (rows.length === 0) return emptyResult(mutationEnabled() ? "mutated" : "readonly")

  const recoveredSessionIDs = new Set<typeof SessionTable.$inferSelect.id>()
  for (const row of rows) recoveredSessionIDs.add(row.session_id)
  const recoveredMessageIDs = rows.map((row) => row.message_id)
  const partRows = yield* db
    .select({ part_id: PartTable.id })
    .from(PartTable)
    .where(
      and(
        inArray(PartTable.message_id, recoveredMessageIDs),
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')`,
      ),
    )
    .all()

  if (!mutationEnabled()) {
    yield* Effect.logWarning("OpenCode recovery candidates found; mutation gate disabled", {
      messagesMatched: rows.length,
      partsMatched: partRows.length,
      sessionsMatched: recoveredSessionIDs.size,
    })
    return {
      mode: "readonly",
      messagesMatched: rows.length,
      partsMatched: partRows.length,
      sessionsMatched: recoveredSessionIDs.size,
    } satisfies Result
  }

  yield* Effect.logInfo("Recovering interrupted sessions", { count: rows.length })

  for (const row of rows) {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const now = Date.now()

        yield* tx
          .run(
            sql`UPDATE ${MessageTable}
                SET data = json_set(data, '$.time.completed', ${now})
                WHERE ${eq(MessageTable.id, row.message_id)}
                  AND ${eq(MessageTable.session_id, row.session_id)}
                  AND json_extract(data, '$.time.completed') IS NULL`,
          )

        yield* tx
          .run(
            sql`UPDATE ${MessageTable}
                SET data = json_set(
                  data,
                  '$.finish',
                  'interrupted',
                  '$.error',
                  json_object('name', 'MessageAbortedError', 'data', json_object('message', ${interruptedMessage}))
                )
                WHERE ${eq(MessageTable.id, row.message_id)}
                  AND ${eq(MessageTable.session_id, row.session_id)}
                  AND json_extract(data, '$.finish') IS NULL`,
          )

        yield* tx
          .run(
            sql`UPDATE ${PartTable}
                SET data = json_set(
                  data,
                  '$.state.time.start', coalesce(json_extract(data, '$.state.time.start'), ${PartTable.time_created}),
                  '$.state.time.end', ${now},
                  '$.state.status', 'error',
                  '$.state.error', ${interruptedMessage},
                  '$.state.metadata.interrupted', json('true')
                )
                WHERE ${eq(PartTable.message_id, row.message_id)}
                  AND ${eq(PartTable.session_id, row.session_id)}
                  AND json_extract(data, '$.type') = 'tool'
                  AND json_extract(data, '$.state.status') IN ('pending', 'running')`,
          )
      }),
    )

    yield* Effect.logWarning("Recovered interrupted session", {
      sessionID: row.session_id,
      messageID: row.message_id,
    })
  }

  const now = Date.now()
  for (const sessionID of recoveredSessionIDs) {
    yield* db
      .update(SessionTable)
      .set({ time_updated: now })
      .where(eq(SessionTable.id, sessionID))
      .run()
  }

  yield* Effect.logInfo("Session recovery complete", {
    messagesRecovered: rows.length,
    partsRecovered: partRows.length,
    sessionsAffected: recoveredSessionIDs.size,
  })

  return {
    mode: "mutated",
    messagesMatched: rows.length,
    partsMatched: partRows.length,
    sessionsMatched: recoveredSessionIDs.size,
  } satisfies Result
})

export const recover = recoverUnsafe().pipe(
  Effect.catchCause((cause) =>
    Effect.logError("Session recovery failed", { cause: Cause.pretty(cause) }).pipe(Effect.as(emptyResult("failed"))),
  ),
)
