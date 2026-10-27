import type { MaskedChatEvent } from './chat-events.js'
import type { ChatTurnContext } from './chat-turn.js'

// Call only after installing the authority's masking boundary; admission emits started separately.
export function observeChatTurn<T extends ChatTurnContext>(
  context: T,
  observation: {
    sessionId: string
    generation: number
    emit(event: MaskedChatEvent): void
    now?: () => number
  }
): T {
  let generation = observation.generation
  let segmentId: string | undefined
  const tools = new Map<string, { title: string; status: 'pending' | 'running' | 'completed' | 'failed' }>()
  const base = () => ({
    sessionId: observation.sessionId,
    turnId: context.turnId,
    generation,
    at: (observation.now ?? Date.now)()
  })
  const emit = (event: MaskedChatEvent) => {
    try {
      observation.emit(event)
    } catch {
      /* Observers cannot interrupt execution. */
    }
  }
  return {
    ...context,
    sink: {
      output(output) {
        const e = output.event
        if (e?.kind === 'superseded') {
          emit({ ...base(), kind: 'discarded', nextGeneration: e.generation })
          generation = e.generation
          segmentId = undefined
          tools.clear()
        } else if (e?.kind === 'message') {
          if (segmentId && e.segmentId && segmentId !== e.segmentId) emit({ ...base(), kind: 'boundary' })
          segmentId = e.segmentId
          emit({ ...base(), kind: 'text', text: e.text })
        } else if (e?.kind === 'thinking') {
          emit({ ...base(), kind: 'reasoning', text: e.text })
        } else if (e?.kind === 'tool_call' || e?.kind === 'tool_update') {
          const previous = tools.get(e.toolCallId)
          const status =
            e.status === 'completed' || e.status === 'failed' || e.status === 'pending'
              ? e.status
              : e.status === 'in_progress' || e.status === 'running'
                ? 'running'
                : (previous?.status ?? 'pending')
          const title = e.title ?? previous?.title ?? e.toolCallId
          tools.set(e.toolCallId, { title, status })
          if (tools.size > 256) tools.delete(tools.keys().next().value!)
          emit({
            ...base(),
            kind: 'tool',
            id: e.toolCallId,
            title,
            status,
            ...(e.input !== undefined ? { input: e.input } : {}),
            ...(e.output !== undefined ? { output: e.output } : {}),
            ...(e.edits ? { edits: e.edits } : {})
          })
        } else if (e && ['permission', 'permission_resolved', 'elicitation', 'elicitation_resolved'].includes(e.kind)) {
          emit({ ...base(), ...e } as MaskedChatEvent)
        }
        context.sink.output(output)
      },
      done(completion) {
        tools.clear()
        emit({
          ...base(),
          kind: 'finished',
          outcome:
            completion.outcome ??
            (completion.error ? 'failed' : completion.stopReason === 'cancelled' ? 'cancelled' : 'complete'),
          ...(completion.error ? { error: completion.error } : {})
        })
        context.sink.done(completion)
      }
    }
  }
}
