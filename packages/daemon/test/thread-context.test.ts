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

/** The admission a session-internal row (tool / plan / card) always carries — its own sender's
 *  session, keyed exactly as {@link readScope} keys a `createNew` conversation. */
export const admitted = <T extends { sender: string; channel: string; thread: string }>(
  e: T
): T & { admission: { agentId: string; sessionKey: string } } => ({
  ...e,
  admission: { agentId: e.sender, sessionKey: `k:${e.channel}:${e.thread}:${e.sender}` }
})

/** One session's transcript read scope. In a `createNew` conversation the coordinate IS the
 *  physical thread, so a scope built this way reads exactly what `(channel, thread)` used to. */
export const readScope = (
  transcriptChannel: string,
  coordinate: string,
  agentId: string,
  sessionKey = `k:${transcriptChannel}:${coordinate}:${agentId}`
) => ({ transcriptChannel, coordinate, sessionKey, agentId })

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
    await db.insertToolCall(
      admitted({
        channel: 'scope:C1',
        thread: 'T1',
        ts: '100.4',
        sender: 'bot-a',
        toolCallId: 'tool-1',
        title: 'Bash',
        body: '{}'
      })
    )

    const refresh = await coordinator.refresh({
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
      afterRevision: 0
    })

    expect(refresh.events.map((event) => [event.sender, event.text])).toEqual([
      ['U1', 'human clarification'],
      ['bot-b', 'peer answer']
    ])
    expect(refresh.revision).toBe(await db.threadTranscriptRevision(readScope('scope:C1', 'T1', 'agent')))
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
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
      afterRevision: 0,
      snapshot
    })
    const fence = first.revision
    const second = await coordinator.refresh({
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
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

  it("never re-imports the agent's own provider rows, so a console-mirrored human turn stays one human row", async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    // The console turn recorded the human under its dispatch ts; on Slack the same words landed as a bot
    // post carrying this agent's authorship metadata, so the provider read returns them as `bot-a`.
    await coordinator.observeInbound(text('1700000073188', 'U1', 'console question'))
    await coordinator.observeInbound(text('1700000031.451949', 'bot-a', 'own reply'))
    const snapshot = vi.fn(async () => ({
      completeness: 'authoritative' as const,
      checkpoint: '1700000100.000000',
      events: [
        { ...text('1700000031.451949', 'bot-a', 'own reply'), trustedAgentBot: true },
        { ...text('1700000073.415209', 'bot-a', 'console question'), trustedAgentBot: true },
        text('1700000099.000001', 'U2', 'peer human')
      ]
    }))

    const refresh = await coordinator.refresh({
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
      afterRevision: 0,
      snapshot
    })

    const rows = await db.transcriptSinceRevision(readScope('scope:C1', 'T1', 'bot-a'), 0)
    expect(rows.filter((row) => row.text === 'console question').map((row) => row.sender)).toEqual(['U1'])
    expect(rows.filter((row) => row.sender === 'bot-a').map((row) => row.ts)).toEqual(['1700000031.451949'])
    expect(refresh.events.map((event) => [event.sender, event.text])).toEqual([
      ['U1', 'console question'],
      ['U2', 'peer human']
    ])
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
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
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
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
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
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
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
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
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

// message-intake.md §3's end state is admissions alone; the coordinate disjunct is the Stage 1
// stopgap that keeps the §8.5 cross-agent catch-up working until §5.2's background split lands.
describe('ThreadContextCoordinator reads by session scope', () => {
  it('stopgap (Stage 1): a createNew session still sees a peer agent in the same physical thread', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    await coordinator.observeInbound({
      ...text('200.1', 'bot-b', 'peer reply'),
      admission: { agentId: 'bot-b', sessionKey: 'k:scope:C1:T1:bot-b' }
    })
    const refresh = await coordinator.refresh({
      scope: readScope('scope:C1', 'T1', 'bot-a'),
      deliveryThread: 'T1',
      afterRevision: 0
    })
    expect(refresh.events.map((e) => e.text)).toEqual(['peer reply'])
    await db.close()
  })

  it('admits an imported provider-snapshot row into the refreshing session', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    const scope = readScope('scope:C1', 'T1', 'bot-a')
    const refresh = await coordinator.refresh({
      scope,
      deliveryThread: 'T1',
      afterRevision: 0,
      // An a2a session reads strictly by agent: a snapshot row without an admission vanishes.
      scopeReadsToAgent: true,
      snapshot: async () => ({ events: [text('400.1', 'U1', 'from provider history')], completeness: 'authoritative' })
    })
    expect(refresh.events.map((e) => e.text)).toEqual(['from provider history'])
    expect((await db.transcriptPageForAgent(scope, null, 10)).rows.map((r) => r.text)).toEqual([
      'from provider history'
    ])
    await db.close()
  })

  it('shows an append session only the rows admitted into it', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    const key = 'slack:C1:append:7:bot-a'
    // Both rows are in the same PHYSICAL thread; only one is admitted into this session.
    await coordinator.observeInbound({
      ...text('300.1', 'U1', 'mine'),
      admission: { agentId: 'bot-a', sessionKey: key }
    })
    await coordinator.observeInbound({
      ...text('300.2', 'U1', 'a peer session'),
      admission: { agentId: 'bot-b', sessionKey: 'slack:C1:append:8:bot-b' }
    })
    const refresh = await coordinator.refresh({
      scope: readScope('scope:C1', 'append:7', 'bot-a', key),
      deliveryThread: 'T1',
      afterRevision: 0
    })
    expect(refresh.events.map((e) => e.text)).toEqual(['mine'])
    await db.close()
  })

  it('does not loop or skip when a row lands between the fence and the delta read', async () => {
    const db = await store()
    const coordinator = new ThreadContextCoordinator(db)
    const scope = readScope('scope:C1', 'T1', 'bot-a')
    await coordinator.observeInbound(text('400.1', 'U1', 'first'))
    const first = await coordinator.refresh({ scope, deliveryThread: 'T1', afterRevision: 0 })
    expect(first.events.map((e) => e.text)).toEqual(['first'])
    // The next refresh starts at the revision the last one returned: no repeat, no gap.
    const second = await coordinator.refresh({ scope, deliveryThread: 'T1', afterRevision: first.revision })
    expect(second.events).toEqual([])
    await coordinator.observeInbound(text('400.2', 'U1', 'second'))
    const third = await coordinator.refresh({ scope, deliveryThread: 'T1', afterRevision: second.revision })
    expect(third.events.map((e) => e.text)).toEqual(['second'])
    await db.close()
  })
})
