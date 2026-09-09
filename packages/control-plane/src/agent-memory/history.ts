// A wire change-log record as a row, and the byte count its retention is measured in (memory-evolution.md §3.2.1).
import type { MemoryFileHistoryEvent } from '@agentconnect.md/protocol'
import type { AgentMemoryHistoryInput, AgentMemoryHistoryRecord } from '../persistence/ports.js'
import { memoryPathSegments } from './paths.js'

/** The store a change log belongs to, as the daemon names it in `root`: the agent's `memory/`, or one channel's. */
export function memoryHistoryRoot(channelKey?: string): string {
  return channelKey ? `channels/${channelKey}/memory` : 'memory'
}

/** `root` as stored: the same string for `memory`, `./memory` and `memory/`, so a read filter finds what a batch wrote. */
export function normalizeMemoryHistoryRoot(root: string): string {
  return memoryPathSegments(root).join('/')
}

/** A stored record back on the wire, in the shape the daemon's sidecar page carries. */
export function toHistoryEvent(record: AgentMemoryHistoryRecord): MemoryFileHistoryEvent {
  return {
    id: record.id,
    path: record.path,
    event: record.event,
    ...(record.before !== undefined ? { before: record.before } : {}),
    after: record.after,
    at: record.at.toISOString(),
    scope: 'agent',
    source: record.source,
    ...(record.truncated !== undefined ? { truncated: record.truncated } : {})
  }
}

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
