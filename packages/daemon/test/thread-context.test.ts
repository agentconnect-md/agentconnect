import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import {
  MAX_CONTEXT_REFRESH_EVENTS,
  ThreadContextCoordinator,
  contextUpdateText,
  initialContextDeltaText
} from '../src/session/thread-context.js'

async function store(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-thread-context-')), 'state.db'))
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
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    await coordinator.observeInbound(text('100.1', 'bot-a', 'own reply'))
    await coordinator.observeInbound(text('100.2', 'U1', 'human clarification'))
    await coordinator.observeInbound(text('100.3', 'bot-b', 'peer answer'))
    await db.insertToolCall({
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
    expect(refresh.revision).toBe(await db.threadTranscriptRevision('scope:C1', 'T1'))
    expect(refresh.completeness).toBe('observed-only')
    await db.close()
  })

  it('imports provider rows idempotently and presents them in provider event order', async () => {
    const db = await store()
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
    await db.close()
  })

  it('retries a failed snapshot and degrades to observed-only without hiding local events', async () => {
    const db = await store()
    const onFailure = vi.fn()
    const coordinator = new ThreadContextCoordinator(db, onFailure)
    await coordinator.observeInbound(text('100.2', 'U1', 'observed locally'))
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
    await db.close()
  })

  it('does not retry a rate-limited snapshot inside the user turn', async () => {
    const db = await store()
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
    await db.close()
  })

  it('bounds replacement prompts to the newest chronological suffix', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    for (let index = 0; index < MAX_CONTEXT_REFRESH_EVENTS + 2; index += 1) {
      await coordinator.observeInbound(text(`100.${String(index).padStart(3, '0')}`, 'U1', `message-${index}`))
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
    await db.close()
  })
  it('renders a refresh from the prompt behind a row, never from the text the console shows', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    const body = JSON.stringify({
      prompt: 'Linear ENG-1 — the full prompt',
      linear: { issue: { identifier: 'ENG-1' } }
    })
    await coordinator.observeInbound({ ...text('100.1', 'U1', 'Delegated ENG-1'), body })
    await coordinator.observeInbound(text('100.2', 'U2', 'plain follow-up'))
    const refresh = await coordinator.refresh({
      agentId: 'bot-a',
      transcriptChannel: 'scope:C1',
      thread: 'T1',
      afterRevision: 0
    })
    for (const rendered of [contextUpdateText(refresh.events), initialContextDeltaText(refresh.events)]) {
      expect(rendered).toContain('[U1] Linear ENG-1 — the full prompt')
      expect(rendered).not.toContain('Delegated ENG-1')
      expect(rendered).toContain('[U2] plain follow-up')
    }
    await db.close()
  })
})
