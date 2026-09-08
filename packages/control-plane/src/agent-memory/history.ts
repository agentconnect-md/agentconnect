// A wire change-log record as a row, and the byte count its retention is measured in (memory-evolution.md §3.2.1).
import type { MemoryFileHistoryEvent } from '@agentconnect.md/protocol'
import type { AgentMemoryHistoryInput } from '../persistence/ports.js'

/** The bytes one record costs the cap: its sidecar line, `JSON.stringify(record) + '\n'`, as the daemon counts it. */
export function historyRecordBytes(record: MemoryFileHistoryEvent): number {
  return Buffer.byteLength(JSON.stringify(record) + '\n')
}

/** A wire record as a row under the id it carries, or the fresh one the caller minted for it. */
export function toHistoryInput(record: MemoryFileHistoryEvent, id: string): AgentMemoryHistoryInput {
  return {
    id,
    path: record.path,
    event: record.event,
    ...(record.before !== undefined ? { before: record.before } : {}),
    after: record.after,
    at: new Date(record.at),
    source: record.source,
    ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
    bytes: historyRecordBytes({ ...record, id })
  }
}
