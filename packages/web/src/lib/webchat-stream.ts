export interface OrderedWebchatOutput {
  turnId: string
  index: number
}

export interface OrderedWebchatDone {
  turnId: string
  lastIndex?: number
}

export interface OrderedWebchatCursor<
  Output extends OrderedWebchatOutput = OrderedWebchatOutput,
  Done extends OrderedWebchatDone = OrderedWebchatDone
> {
  turnId?: string
  nextIndex: number
  pending: Map<number, Output>
  done?: Done
}

export interface OrderedWebchatResult<Output, Done> {
  outputs: Output[]
  done?: Done
  overflow?: true
}

const MAX_PENDING_OUTPUTS = 512

export function createWebchatCursor<
  Output extends OrderedWebchatOutput,
  Done extends OrderedWebchatDone
>(): OrderedWebchatCursor<Output, Done> {
  return { nextIndex: 0, pending: new Map() }
}

/** Bind a pre-ack cursor to the daemon-issued turn id. A different id is stale
 * traffic from another turn and must not alter the current transcript. */
export function bindWebchatTurn(cursor: OrderedWebchatCursor, turnId: string): boolean {
  if (!turnId) return false
  if (!cursor.turnId) cursor.turnId = turnId
  return cursor.turnId === turnId
}

function drainWebchatCursor<Output extends OrderedWebchatOutput, Done extends OrderedWebchatDone>(
  cursor: OrderedWebchatCursor<Output, Done>
): OrderedWebchatResult<Output, Done> {
  const outputs: Output[] = []
  for (;;) {
    const output = cursor.pending.get(cursor.nextIndex)
    if (!output) break
    cursor.pending.delete(cursor.nextIndex)
    outputs.push(output)
    cursor.nextIndex += 1
  }
  const done =
    cursor.done && (cursor.done.lastIndex === undefined || cursor.nextIndex > cursor.done.lastIndex)
      ? cursor.done
      : undefined
  if (done) delete cursor.done
  return { outputs, ...(done ? { done } : {}) }
}

export function acceptWebchatOutput<Output extends OrderedWebchatOutput, Done extends OrderedWebchatDone>(
  cursor: OrderedWebchatCursor<Output, Done>,
  output: Output
): OrderedWebchatResult<Output, Done> {
  if (!bindWebchatTurn(cursor, output.turnId)) return { outputs: [] }
  if (!Number.isInteger(output.index) || output.index < 0) return { outputs: [], overflow: true }
  if (output.index < cursor.nextIndex || cursor.pending.has(output.index)) return { outputs: [] }
  if (output.index - cursor.nextIndex >= MAX_PENDING_OUTPUTS || cursor.pending.size >= MAX_PENDING_OUTPUTS) {
    return { outputs: [], overflow: true }
  }
  cursor.pending.set(output.index, output)
  return drainWebchatCursor(cursor)
}

export function acceptWebchatDone<Output extends OrderedWebchatOutput, Done extends OrderedWebchatDone>(
  cursor: OrderedWebchatCursor<Output, Done>,
  done: Done
): OrderedWebchatResult<Output, Done> {
  if (!bindWebchatTurn(cursor, done.turnId)) return { outputs: [] }
  cursor.done = done
  return drainWebchatCursor(cursor)
}
