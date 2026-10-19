import type { WebchatOutput } from '@agentconnect.md/protocol'
import type { ChatOutput } from '../session/chat-turn.js'

// Retain emission ordinals even when a neutral event has no legacy wire equivalent.
export function legacyChatOutput(output: ChatOutput): WebchatOutput {
  const { event, ...rest } = output
  if (!event || event.kind === 'permission_resolved') return rest
  if (event.kind === 'tool_call' || event.kind === 'tool_update') {
    const { input: _input, output: _output, ...legacy } = event
    return { ...rest, event: legacy }
  }
  if (event.kind === 'elicitation_resolved') {
    const { answers: _answers, ...legacy } = event
    return { ...rest, event: legacy }
  }
  if (event.kind === 'permission') {
    const { options: _options, ...legacy } = event
    return { ...rest, event: legacy }
  }
  return { ...rest, event }
}
