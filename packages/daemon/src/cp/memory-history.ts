// The `control-plane` home's change log (memory-evolution.md §3.2.1): the daemon still composes every record and sends
// it AFTER the write as a best-effort `memory/history/append` batch — provenance never fails the write — and never
// reads the log back, since the CP answers the console from its own table. `resolveMemoryHomePorts` selects it beside `CpMemoryFs`.
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  MEMORY_HISTORY_APPEND_MAX_RECORDS,
  REPLY_BUDGET,
  type MemoryHistoryAppendOk,
  type MemoryHistoryAppendReq
} from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import type { MemoryHistoryRecord, MemoryHistorySink } from '../memory/store.js'
import { CP_MEMORY_TREE_ROOT, joinTreeRoot } from './memory-fs.js'

/** The slice of the CP connection the sink rides: the gates `CpMemoryStoreLink` has, and the one request pair. */
export interface CpMemoryHistoryLink {
  connected(): boolean
  supportsServerFeature(feature: string): boolean
  memoryHistoryAppend(req: MemoryHistoryAppendReq): Promise<MemoryHistoryAppendOk>
}

/** Pack records, in order, into requests the wire accepts: `MEMORY_HISTORY_APPEND_MAX_RECORDS` at most, under `REPLY_BUDGET`. */
export function packMemoryHistoryBatches(
  agentId: string,
  root: string,
  records: readonly MemoryHistoryRecord[]
): MemoryHistoryAppendReq[] {
  const envelope = Buffer.byteLength(JSON.stringify({ agentId, root, records: [] }))
  const batches: MemoryHistoryAppendReq[] = []
  let batch: MemoryHistoryRecord[] = []
  let bytes = envelope
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record))
    // A comma precedes every record but a batch's first; a record no batch can hold still goes alone, for the CP to refuse.
    if (batch.length > 0 && (batch.length === MEMORY_HISTORY_APPEND_MAX_RECORDS || bytes + 1 + size > REPLY_BUDGET)) {
      batches.push({ agentId, root, records: batch })
      batch = []
      bytes = envelope
    }
    bytes += size + (batch.length > 0 ? 1 : 0)
    batch.push(record)
  }
  if (batch.length > 0) batches.push({ agentId, root, records: batch })
  return batches
}

function failureReason(err: unknown): string {
  if (err instanceof WireError) return `${err.code}: ${err.message}`
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

// The sink over the CP. `root` is the store's tree-relative root, the coordinates `CpMemoryFs` names on every op — `.`
// for the agent's own tree, `channels/<key>` for a channel store — so one table row lines up with one store.
export class CpMemoryHistorySink implements MemoryHistorySink {
  readonly root: string

  constructor(
    private readonly link: CpMemoryHistoryLink,
    private readonly agentId: string,
    root: string = CP_MEMORY_TREE_ROOT,
    private readonly log: Pick<Logger, 'warn'>
  ) {
    this.root = joinTreeRoot(CP_MEMORY_TREE_ROOT, root)
  }

  /** Best-effort: the write already happened, so any failure is one warn line naming what went unrecorded, never a rejection. */
  async append(records: MemoryHistoryRecord[]): Promise<void> {
    if (records.length === 0) return
    let unsent = records.length
    let reason: string | undefined
    if (!this.link.connected()) reason = 'the connection is down'
    else if (!this.link.supportsServerFeature(AGENT_MEMORY_STORE_V1_FEATURE)) {
      reason = 'the Control Plane does not serve the memory store'
    } else {
      // One failure ends the batch run: what refused or dropped this request will do the same to the next one.
      for (const batch of packMemoryHistoryBatches(this.agentId, this.root, records)) {
        try {
          await this.link.memoryHistoryAppend(batch)
        } catch (err) {
          reason = failureReason(err)
          break
        }
        unsent -= batch.records.length
      }
    }
    if (reason === undefined) return
    this.log.warn(
      `agent "${this.agentId}": ${unsent} memory change-log record(s) for ${this.root} not recorded in the Control Plane (${reason})`
    )
  }

  /** Nothing lives inside a CP-homed store to carry: the table outlives the swap on its own. */
  async carryInto(): Promise<void> {}
}
