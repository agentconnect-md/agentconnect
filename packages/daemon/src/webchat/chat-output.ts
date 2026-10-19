import type { WebchatDone, WebchatOutput } from '@agentconnect.md/protocol'
import type { ChatCompletion, ChatOutput } from '../session/chat-turn.js'

// Retain emission ordinals even when a neutral event has no legacy wire equivalent.
export function legacyChatOutput(output: ChatOutput): WebchatOutput {
  const { event, ...rest } = output
  if (!event || event.kind === 'permission_resolved' || ('observationOnly' in event && event.observationOnly))
    return rest
  if (event.kind === 'tool_call' || event.kind === 'tool_update') {
    const { input: _input, output: _output, ...legacy } = event
    return { ...rest, event: legacy }
  }
  if (event.kind === 'elicitation_resolved') {
    const { answers: _answers, ...legacy } = event
    return { ...rest, event: legacy }
  }
  if (event.kind === 'permission') {
    if (event.editorOnly) return rest
    const { options: _options, editorOnly: _editorOnly, ...legacy } = event
    return { ...rest, event: legacy }
  }
  return { ...rest, event }
}

// Terminal semantics stay on the application port; the legacy envelope remains unchanged.
export function legacyChatCompletion(completion: ChatCompletion): WebchatDone {
  const { outcome: _outcome, ...legacy } = completion
  return legacy
}
