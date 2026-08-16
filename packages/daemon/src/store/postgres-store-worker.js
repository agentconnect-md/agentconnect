import { parentPort, workerData } from 'node:worker_threads'
import pg from 'pg'

const canonical = workerData.columnNames
const replyPort = workerData.replyPort
const readySignal = workerData.readySignal
let client

function rewrite(sql) {
  let out = sql
    // PostgreSQL has no SQLite exclusive-writer transaction, so IMMEDIATE is dropped: a
    // shared-store statement must be a CAS or a relative write, never a read-then-write.
    .replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN')
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/length\(CAST\(([^)]+)\s+AS\s+BLOB\)\)/gi, 'octet_length($1::text)')
    .replace(/([A-Za-z_][A-Za-z0-9_.]*)\s+NOT\s+IN\s*\(\s*\)/gi, 'TRUE')
    .replace(/LIMIT\s+-1\s+OFFSET/gi, 'OFFSET')
    .replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1')
  const ignored = /^\s*INSERT\s+OR\s+IGNORE\s+/i.test(out)
  if (ignored) {
    out = out.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, 'INSERT ')
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING')
  }
  return out
}

function bind(sql, input) {
  const values = []
  let revisionSlot
  if (input.length === 0) return { sql: rewrite(sql), values, revisionSlot }
  if (input.length === 1 && input[0] && typeof input[0] === 'object' && !Array.isArray(input[0])) {
    const params = input[0]
    const slots = new Map()
    sql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name) => {
      let slot = slots.get(name)
      if (!slot) {
        slot = values.push(params[name] === undefined ? null : params[name])
        slots.set(name, slot)
      }
      if (name === 'revision') revisionSlot = slot
      return `$${slot}`
    })
  } else {
    let index = 0
    sql = sql.replace(/\?/g, (_all, offset) => {
      const slot = values.push(input[index] === undefined ? null : input[index])
      index += 1
      if (/revision\s*=\s*$/i.test(sql.slice(0, offset))) revisionSlot = slot
      return `$${slot}`
    })
  }
  return { sql: rewrite(sql), values, revisionSlot }
}

function rowsOf(result) {
  const rows = Array.isArray(result) ? (result.at(-1)?.rows ?? []) : (result.rows ?? [])
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [canonical[key] ?? key, value]))
  )
}

async function execute(message) {
  if (message.kind === 'finishSchemaInitialization') {
    await client.query("SELECT pg_advisory_unlock(hashtext('agentconnect-cloud-store-schema'))")
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
  if (/^\s*PRAGMA\s+journal_mode/i.test(message.sql)) return
  const setVersion = /^\s*PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(message.sql)
  if (setVersion) {
    await client.query(
      'INSERT INTO _local_store_schema_version (singleton, version) VALUES (true, $1) ' +
        'ON CONFLICT (singleton) DO UPDATE SET version = excluded.version',
      [Number(setVersion[1])]
    )
    return
  }
  if (/^\s*PRAGMA\s+user_version/i.test(message.sql)) {
    const result = await client.query(
      'SELECT COALESCE(MAX(version), 0)::bigint AS user_version FROM _local_store_schema_version'
    )
    return { rows: rowsOf(result), changes: result.rowCount ?? 0 }
  }
  if (/sqlite_master/i.test(message.sql)) {
    const result = await client.query(
      "SELECT COUNT(*)::bigint AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name <> '_local_store_schema_version'",
      [workerData.schema]
    )
    return { rows: rowsOf(result), changes: result.rowCount ?? 0 }
  }
  const bound = bind(message.sql, message.params ?? [])
  let result
  if (bound.revisionSlot && /^\s*(INSERT|UPDATE)\s+/i.test(bound.sql) && /\btranscript\b/i.test(bound.sql)) {
    await client.query('BEGIN')
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agentconnect-cloud-transcript-revision'))")
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
  return {
    rows: rowsOf(result),
    changes: Array.isArray(result) ? (result.at(-1)?.rowCount ?? 0) : (result.rowCount ?? 0)
  }
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
  await client.query("SELECT pg_advisory_lock(hashtext('agentconnect-cloud-store-schema'))")
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${workerData.schema}`)
  await client.query(`SET search_path TO ${workerData.schema}, pg_catalog`)
  await client.query('CREATE SEQUENCE IF NOT EXISTS _transcript_revision_seq')
  await client.query(
    'CREATE TABLE IF NOT EXISTS _local_store_schema_version (' +
      'singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), version BIGINT NOT NULL)'
  )
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
