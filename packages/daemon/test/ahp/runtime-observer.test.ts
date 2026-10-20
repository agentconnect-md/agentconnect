import { expect, it } from 'vitest'
import type { MaskedChatEvent } from '../../src/session/chat-events.js'
import { AhpRuntimeObserver } from '../../src/ahp/runtime-observer.js'

it('observes masked native output and exact terminal outcome without a transport or transcript writer', () => {
  const events: MaskedChatEvent[] = []
  const observer = new AhpRuntimeObserver({
    sessionId: 'outward',
    turnId: 'native-turn',
    text: 'question',
    origin: 'user',
    now: () => 1,
    emit: (event) => events.push(event)
  })
  observer.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'answer with [link](https://example.test)' }
  })
  observer.event({ kind: 'permission', requestId: 'request', tool: 'Read', detail: 'Allow?' })
  observer.event({ kind: 'permission_resolved', requestId: 'request', outcome: 'denied' })
  observer.finish('cancelled', 'stopped')
  const terminal = events.length
  observer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
  observer.finish('complete')
  expect(events).toHaveLength(terminal)
  expect(events[0]).toMatchObject({ kind: 'started', turnId: 'native-turn' })
  expect(
    events
      .filter((event) => event.kind === 'text')
      .map((event) => event.text)
      .join('')
  ).toBe('answer with [link](https://example.test)')
  expect(events.at(-1)).toMatchObject({ kind: 'finished', outcome: 'cancelled' })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'permission_resolved', outcome: 'denied' }))
})
