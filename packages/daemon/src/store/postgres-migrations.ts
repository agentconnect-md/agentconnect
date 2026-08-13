import type { PoolClient } from 'pg'

/** Quote only identifiers already accepted by postgres-config's conservative regex. */
export function quotePgIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) throw new Error('invalid PostgreSQL schema identifier')
  return `"${identifier}"`
}

const MIGRATIONS: readonly string[] = [
  `
    CREATE SEQUENCE transcript_revision_seq;

    CREATE TABLE transcript (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel TEXT NOT NULL,
      thread TEXT NOT NULL,
      ts TEXT,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'tool', 'reasoning')),
      text TEXT NOT NULL,
      tool_call_id TEXT,
      body TEXT,
      recipient TEXT,
      event_time_us BIGINT NOT NULL DEFAULT 0,
      attachments_json TEXT,
      quote_json TEXT,
      trusted_agent_bot BOOLEAN,
      revision BIGINT NOT NULL DEFAULT nextval('transcript_revision_seq'),
      post_id TEXT
    );
    CREATE INDEX transcript_thread_seq ON transcript (channel, thread, seq);
    CREATE UNIQUE INDEX transcript_text_ts ON transcript (channel, thread, ts) WHERE kind = 'text';
    CREATE UNIQUE INDEX transcript_agent_tool_call
      ON transcript (channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE INDEX transcript_thread_event_time ON transcript (channel, thread, event_time_us DESC, seq DESC);
    CREATE INDEX transcript_thread_revision ON transcript (channel, thread, revision);

    CREATE TABLE transcript_recipient (
      channel TEXT NOT NULL,
      thread TEXT NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (channel, thread, ts, agent_id)
    );
  `
]

export const DATA_PLANE_SCHEMA_VERSION = MIGRATIONS.length

/** Upgrade one org schema under a transaction-scoped cross-daemon advisory lock. */
export async function migrateDataPlaneSchema(client: PoolClient, schema: string): Promise<void> {
  const quoted = quotePgIdentifier(schema)
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('agentconnect-data-plane'))", [schema])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`)
    await client.query(`SET LOCAL search_path TO ${quoted}, pg_catalog`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _agentconnect_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const result = await client.query<{ version: number }>(
      'SELECT version FROM _agentconnect_schema_migrations ORDER BY version'
    )
    const applied = new Set(result.rows.map((row) => Number(row.version)))
    const newest = Math.max(0, ...applied)
    if (newest > DATA_PLANE_SCHEMA_VERSION) {
      throw new Error(
        `data-plane schema ${schema} is version ${newest}, newer than supported version ${DATA_PLANE_SCHEMA_VERSION}`
      )
    }
    for (let version = 1; version <= newest; version += 1) {
      if (!applied.has(version))
        throw new Error(`data-plane schema ${schema} has a migration gap before version ${newest}`)
    }
    let expected = newest + 1
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const version = index + 1
      if (applied.has(version)) continue
      if (version !== expected) throw new Error(`data-plane schema ${schema} has a migration gap`)
      await client.query(MIGRATIONS[index]!)
      await client.query('INSERT INTO _agentconnect_schema_migrations (version) VALUES ($1)', [version])
      expected += 1
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}
