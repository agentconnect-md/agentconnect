import { AHP_MAX_MESSAGE_BYTES } from '@agentconnect.md/protocol/ahp-constants'
import type { StateAction } from '@microsoft/agent-host-protocol'

export class AhpMessageTooLargeError extends Error {
  constructor() {
    super('This message is too large. Shorten the text or choose a smaller image.')
  }
}

export function ahpRemainingActionBytes(channel: string, clientSeq: number, action: StateAction): number {
  const frame = JSON.stringify({ jsonrpc: '2.0', method: 'dispatchAction', params: { channel, clientSeq, action } })
  return AHP_MAX_MESSAGE_BYTES - new TextEncoder().encode(frame).byteLength
}

export function ahpImageBudget(remainingBytes: number): number {
  const remaining = remainingBytes - 256
  if (remaining < 1024) throw new AhpMessageTooLargeError()
  return Math.floor(remaining / 4) * 3
}
