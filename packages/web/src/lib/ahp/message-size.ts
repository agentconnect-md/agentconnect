import { AHP_MAX_MESSAGE_BYTES } from '@agentconnect.md/protocol'
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
