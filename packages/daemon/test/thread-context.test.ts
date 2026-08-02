import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import {
  MAX_CONTEXT_REFRESH_EVENTS,
  ThreadContextCoordinator,
  contextUpdateText,
  initialContextDeltaText,
  type ContextEventSender
} from '../src/session/thread-context.js'

function store(): LocalStore {
  return new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-thread-context-')), 'state.db'))
}

const text = (ts: string, sender: string, body: string) => ({
  channel: 'scope:C1',
  thread: 'T1',
  ts,
  sender,
  kind: 'text' as const,
  text: body
})

describe('ThreadContextCoordinator', () => {
  it('uses revision fences and invalidates only on non-self conversation rows', async () => {
    const db = store()
    const coordinator = new ThreadContextCoordinator(db)
    coordinator.observeInbound(text('100.1', 'bot-a', 'own reply'))
    coordinator.observeInbound(text('100.2', 'U1', 'human clarification'))
    coordinator.observeInbound(text('100.3', 'bot-b', 'peer answer'))
    db.insertToolCall({
      channel: 'scope:C1',
      thread: 'T1',
      ts: '100.4',
      sender: 'bot-a',
      toolCallId: 'tool-1',
      title: 'Bash',
      body: '{}'
    })

    const refresh = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0
    })

    expect(refresh.events.map((event) => [event.sender, event.text])).toEqual([
      ['U1', 'human clarification'],
      ['bot-b', 'peer answer']
    ])
    expect(refresh.revision).toBe(db.threadTranscriptRevision('scope:C1', 'T1'))
    expect(refresh.completeness).toBe('observed-only')
    db.close()
  })

  it('imports provider rows idempotently and presents them in provider event order', async () => {
    const db = store()
    const coordinator = new ThreadContextCoordinator(db)
    const snapshot = vi.fn(async () => ({
      completeness: 'authoritative' as const,
      checkpoint: '100.4',
      events: [text('100.3', 'U2', 'later'), text('100.2', 'U1', 'earlier')]
    }))

    const first = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0,
      snapshot
    })
    const fence = first.revision
    const second = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: fence,
      snapshot
    })

    expect(first.events.map((event) => event.text)).toEqual(['earlier', 'later'])
    expect(first.providerCheckpoint).toBe('100.4')
    expect(first.completeness).toBe('authoritative')
    expect(second.events).toEqual([])
    expect(second.revision).toBe(fence)
    db.close()
  })

  it('retries a failed snapshot and degrades to observed-only without hiding local events', async () => {
    const db = store()
    const onFailure = vi.fn()
    const coordinator = new ThreadContextCoordinator(db, onFailure)
    coordinator.observeInbound(text('100.2', 'U1', 'observed locally'))
    const snapshot = vi.fn(async () => {
      throw new Error('transport unavailable')
    })

    const refresh = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0,
      snapshot
    })

    expect(snapshot).toHaveBeenCalledTimes(3)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(refresh.snapshotFailed).toBe(true)
    expect(refresh.completeness).toBe('observed-only')
    expect(refresh.events.map((event) => event.text)).toEqual(['observed locally'])
    db.close()
  })

  it('does not retry a rate-limited snapshot inside the user turn', async () => {
    const db = store()
    const coordinator = new ThreadContextCoordinator(db)
    const snapshot = vi.fn(async () => {
      throw Object.assign(new Error('rate_limited'), { code: 'slack_webapi_rate_limited' })
    })

    const refresh = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0,
      snapshot
    })

    expect(snapshot).toHaveBeenCalledOnce()
    expect(refresh.snapshotFailed).toBe(true)
    expect(refresh.completeness).toBe('observed-only')
    db.close()
  })

  it('bounds replacement prompts to the newest chronological suffix', async () => {
    const db = store()
    const coordinator = new ThreadContextCoordinator(db)
    for (let index = 0; index < MAX_CONTEXT_REFRESH_EVENTS + 2; index += 1) {
      coordinator.observeInbound(text(`100.${String(index).padStart(3, '0')}`, 'U1', `message-${index}`))
    }
    const refresh = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0
    })
    const prompt = contextUpdateText(refresh.events)

    expect(prompt).toContain('2 earlier message(s) elided')
    expect(prompt).not.toContain('[U1] message-0\n')
    expect(prompt).toContain('[U1] message-2')
    expect(prompt).toContain(`[U1] message-${MAX_CONTEXT_REFRESH_EVENTS + 1}`)
    db.close()
  })

  describe('replacement prompt framing', () => {
    const agentNames = new Map([
      ['bot-b', 'Beta'],
      ['bot-c', 'Gamma']
    ])
    const senderFor = (event: { sender: string }): ContextEventSender | undefined =>
      agentNames.has(event.sender) ? { label: agentNames.get(event.sender)!, peerAgent: true } : undefined

    async function refreshFor(entries: [string, string][]) {
      const db = store()
      const coordinator = new ThreadContextCoordinator(db)
      entries.forEach(([sender, body], index) => coordinator.observeInbound(text(`100.${index}`, sender, body)))
      const refresh = await coordinator.refresh({
        agentId: 'bot-a',
        transcriptChannel: 'scope:C1',
        thread: 'T1',
        afterRevision: 0
      })
      db.close()
      return refresh
    }

    it('re-frames peer-only churn as still-addressed instead of re-evaluate', async () => {
      const refresh = await refreshFor([
        ['bot-b', 'I am Beta, a coding assistant.'],
        ['bot-c', 'I am Gamma.']
      ])
      const prompt = contextUpdateText(refresh.events, undefined, senderFor)

      expect(prompt).toContain('other agents in this')
      expect(prompt).toContain('The message that activated you is still')
      expect(prompt).toContain('AC_NO_RESPONSE')
      expect(prompt).toContain('(new replies from other agents)')
      expect(prompt).toContain('[Beta (another agent)] I am Beta, a coding assistant.')
      expect(prompt).toContain('[Gamma (another agent)] I am Gamma.')
      expect(prompt).not.toContain('Re-evaluate the task')
    })

    it('keeps the re-evaluate framing when any human message is in the delta', async () => {
      const refresh = await refreshFor([
        ['bot-b', 'I am Beta.'],
        ['U1', 'actually, use the staging config']
      ])
      const prompt = contextUpdateText(refresh.events, undefined, senderFor)

      expect(prompt).toContain('the conversation changed while you were working')
      expect(prompt).toContain('produce a replacement final answer')
      expect(prompt).toContain('(new thread messages)')
      expect(prompt).toContain('[Beta (another agent)] I am Beta.')
      expect(prompt).toContain('[U1] actually, use the staging config')
    })

    it('keeps the historical prompt byte-for-byte without a sender resolver', async () => {
      const refresh = await refreshFor([['bot-b', 'peer answer']])
      const prompt = contextUpdateText(refresh.events)

      expect(prompt).toContain('the conversation changed while you were working')
      expect(prompt).toContain('[bot-b] peer answer')
      expect(prompt).not.toContain('another agent')
    })

    it('labels peer agents in initial-fence deltas too', async () => {
      const refresh = await refreshFor([
        ['bot-b', 'I am Beta.'],
        ['U1', 'hello everyone']
      ])
      const prompt = initialContextDeltaText(refresh.events, undefined, senderFor)

      expect(prompt).toContain('(additional thread messages before this turn started)')
      expect(prompt).toContain('[Beta (another agent)] I am Beta.')
      expect(prompt).toContain('[U1] hello everyone')
    })
  })
})
