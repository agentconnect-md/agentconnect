import type { StoreQueryResult, StoreTx } from './store-database.js'

export const AHP_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ahp_sequence (
    orgId TEXT NOT NULL, agentId TEXT NOT NULL, high INTEGER NOT NULL,
    PRIMARY KEY (orgId, agentId)
  );
  CREATE TABLE IF NOT EXISTS ahp_checkpoint (
    orgId TEXT NOT NULL, agentId TEXT NOT NULL, sessionId TEXT NOT NULL,
    epoch INTEGER NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, updatedAt INTEGER NOT NULL,
    PRIMARY KEY (orgId, agentId, sessionId)
  );
  CREATE TABLE IF NOT EXISTS ahp_turn (
    orgId TEXT NOT NULL, agentId TEXT NOT NULL, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
    epoch INTEGER NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (orgId, agentId, sessionId, turnId)
  );
  CREATE INDEX IF NOT EXISTS ahp_turn_page ON ahp_turn(orgId, agentId, sessionId, epoch, revision, turnId);
`

export interface AhpCheckpointWrite {
  orgId: string
  agentId: string
  sessionId: string
  epoch: number
  revision: number
  value: string
  now: number
  turns?: readonly { turnId: string; value: string }[]
}

type Database = {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

export class AhpStateStore {
  constructor(private readonly db: Database) {}

  async reserve(orgId: string, agentId: string, size: number): Promise<{ start: number; end: number }> {
    positive(size)
    if (size > 1_000_000) throw new Error('AHP sequence block too large')
    const result = await this.db.query(
      `INSERT INTO ahp_sequence (orgId, agentId, high) VALUES (?, ?, ?)
      ON CONFLICT (orgId, agentId) DO UPDATE SET high = ahp_sequence.high + excluded.high
      WHERE ahp_sequence.high <= ? RETURNING high`,
      [orgId, agentId, size, Number.MAX_SAFE_INTEGER - size]
    )
    const row = result.rows[0] as { high: number } | undefined
    if (!row) throw new Error('AHP sequence space exhausted')
    const end = Number(row.high)
    positive(end)
    return { start: end - size + 1, end }
  }

  async load(orgId: string, agentId: string, sessionId: string): Promise<string | undefined> {
    const result = await this.db.query(
      'SELECT value FROM ahp_checkpoint WHERE orgId = ? AND agentId = ? AND sessionId = ?',
      [orgId, agentId, sessionId]
    )
    return (result.rows[0] as { value: string } | undefined)?.value
  }

  async save(input: AhpCheckpointWrite): Promise<void> {
    positive(input.epoch)
    positive(input.revision)
    bounded(input.value)
    if ((input.turns?.length ?? 0) > 999) throw new Error('AHP checkpoint contains too many turns')
    for (const turn of input.turns ?? []) bounded(turn.value)
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO ahp_checkpoint (orgId, agentId, sessionId, epoch, revision, value, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (orgId, agentId, sessionId) DO UPDATE
        SET epoch = excluded.epoch, revision = excluded.revision, value = excluded.value, updatedAt = excluded.updatedAt
        WHERE ahp_checkpoint.epoch < excluded.epoch OR (ahp_checkpoint.epoch = excluded.epoch AND ahp_checkpoint.revision < excluded.revision)
        RETURNING epoch`,
        [input.orgId, input.agentId, input.sessionId, input.epoch, input.revision, input.value, input.now]
      )
      if (!result.rows.length) throw new Error('Stale AHP checkpoint writer')
      for (const [index, turn] of (input.turns ?? []).entries()) {
        const revision = input.revision * 1000 + index
        positive(revision)
        // Terminal turns are immutable; loading an old page must never reorder the archive.
        await tx.query(
          `INSERT INTO ahp_turn (orgId, agentId, sessionId, turnId, epoch, revision, value)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (orgId, agentId, sessionId, turnId) DO NOTHING`,
          [input.orgId, input.agentId, input.sessionId, turn.turnId, input.epoch, revision, turn.value]
        )
      }
    })
  }

  async page(
    orgId: string,
    agentId: string,
    sessionId: string,
    cursorTurnId: string,
    maxBytes = 32 * 1024
  ): Promise<{ values: string[]; nextCursor?: string }> {
    positive(maxBytes)
    const scope = [orgId, agentId, sessionId]
    const anchor = (
      await this.db.query(
        'SELECT epoch, revision, turnId FROM ahp_turn WHERE orgId = ? AND agentId = ? AND sessionId = ? AND turnId = ?',
        [...scope, cursorTurnId]
      )
    ).rows[0] as { epoch: number; revision: number; turnId: string } | undefined
    if (!anchor) throw new Error('Unknown AHP history cursor')
    const rows = (
      await this.db.query(
        `SELECT turnId, value FROM ahp_turn WHERE orgId = ? AND agentId = ? AND sessionId = ?
      AND (epoch, revision, turnId) < (?, ?, ?) ORDER BY epoch DESC, revision DESC, turnId DESC LIMIT 65`,
        [...scope, anchor.epoch, anchor.revision, anchor.turnId]
      )
    ).rows as { turnId: string; value: string }[]
    const selected: typeof rows = []
    let bytes = 2
    for (const row of rows) {
      const size = Buffer.byteLength(row.value) + 1
      if (bytes + size > maxBytes || selected.length === 64) break
      selected.push(row)
      bytes += size
    }
    if (rows.length && !selected.length) throw new Error('AHP archived turn exceeds page budget')
    const more = selected.length < rows.length
    return {
      values: selected.map((row) => row.value).reverse(),
      ...(more ? { nextCursor: selected.at(-1)!.turnId } : {})
    }
  }
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid AHP store counter')
}
function bounded(value: string): void {
  if (Buffer.byteLength(value) > 512 * 1024) throw new Error('AHP checkpoint exceeds storage budget')
}
