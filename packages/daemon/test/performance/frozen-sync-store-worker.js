// Frozen copy of the deleted production worker, kept only so the capacity benchmark can still
// measure the `sync-worker` rung against the async store. Nothing in `src/` loads it.
import { parentPort, workerData } from 'node:worker_threads'
import pg from 'pg'
// The dialect layer is still the production one; Node strips the types when this worker loads
// the module directly from source.
import {
  bind,
  changesOf,
  emulate,
  isRevisionBearingWrite,
  rowsOf,
  SCHEMA_LOCK_KEY,
  schemaBootstrapStatements,
  TRANSCRIPT_REVISION_LOCK_KEY
} from '../../src/store/postgres-dialect.ts'

const replyPort = workerData.replyPort
const readySignal = workerData.readySignal
let client

async function execute(message) {
  if (message.kind === 'finishSchemaInitialization') {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SCHEMA_LOCK_KEY])
    return
  }
  if (message.kind === 'close') {
    await client.end()
    return
  }
  // One hand-off, N statements, each still on its own commit: a failure names its statement and
  // abandons the rest, leaving what the same statements run as separate calls would have left.
  if (message.kind === 'batch') {
    const statements = message.statements ?? []
    const results = []
    for (let index = 0; index < statements.length; index++) {
      try {
        results.push((await runStatement(statements[index])) ?? { rows: [], changes: 0 })
      } catch (error) {
        const detail = error instanceof Error && error.stack ? error.stack : String(error)
        throw new Error(`batch statement ${index + 1} of ${statements.length} failed: ${detail}`)
      }
    }
    return results
  }
  return runStatement(message)
}

async function runStatement(message) {
  const emulated = emulate(message.sql, workerData.schema)
  if (emulated) {
    if (emulated.kind === 'noop') return
    const result = await client.query(emulated.sql, emulated.values)
    if (emulated.kind === 'run') return
    return { rows: rowsOf(result), changes: changesOf(result) }
  }
  const bound = bind(message.sql, message.params ?? [])
  let result
  if (isRevisionBearingWrite(bound)) {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TRANSCRIPT_REVISION_LOCK_KEY])
      const revision = await client.query("SELECT nextval('_transcript_revision_seq')::bigint AS revision")
      bound.values[bound.revisionSlot - 1] = revision.rows[0].revision
      result = await client.query(bound.sql, bound.values)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } else {
    result = bound.values.length ? await client.query(bound.sql, bound.values) : await client.query(bound.sql)
  }
  return { rows: rowsOf(result), changes: changesOf(result) }
}

async function reply(message) {
  try {
    const value = await execute(message)
    replyPort.postMessage({ id: message.id, ok: true, value })
  } catch (error) {
    replyPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error && error.stack ? error.stack : String(error)
    })
  } finally {
    Atomics.store(message.signal, 0, 1)
    Atomics.notify(message.signal, 0)
  }
}

async function start() {
  pg.types.setTypeParser(20, Number)
  client = new pg.Client({
    connectionString: workerData.databaseUrl,
    application_name: 'agentconnect-cloud-store'
  })
  await client.connect()
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [SCHEMA_LOCK_KEY])
  for (const statement of schemaBootstrapStatements(workerData.schema)) await client.query(statement)
  parentPort.on('message', reply)
  replyPort.postMessage({ id: 0, ok: true })
  Atomics.store(readySignal, 0, 1)
  Atomics.notify(readySignal, 0)
}

start().catch((error) => {
  replyPort.postMessage({
    id: 0,
    ok: false,
    error: error instanceof Error && error.stack ? error.stack : String(error)
  })
  Atomics.store(readySignal, 0, 1)
  Atomics.notify(readySignal, 0)
})
