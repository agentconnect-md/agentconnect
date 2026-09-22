import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { WAIT } from './wait-support.js'

/**
 * The transcript-activity signal the CP invalidates live session views on. A mutation's `agentIds`
 * are the row's SENDERS — on an inbound text row that is the human who posted it — while its
 * `sessionKeys` are the admissions. Pairing the two sets would address an agent's session under a
 * stranger, and a frame-scoped CP cannot resolve an org for a non-agent id.
 */
describe('transcript-activity fan-out', () => {
  const scaffold = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ac-activity-'))
    writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
    return root
  }

  it('addresses each admitted session under its OWN agent, never a mutation sender', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const store = (daemon as any).store
    const emitted: { agentId: string; sessionId: string }[] = []
    ;(daemon as any).cpClient = {
      emitSessionActivity: (a: { agentId: string; sessionId: string }) => emitted.push(a),
      stop: () => undefined
    }
    const base = { platform: 'slack', channel: 'C1', state: 'idle' as const, lastDeliveredTs: null, updatedAt: 1 }
    // Two append sessions of DIFFERENT agents admitting one inbound row. Their coordinates are
    // append:*, so the physical-thread fallback can never resolve either one.
    await store.upsertSession({
      ...base,
      key: 'k-a',
      agentId: 'bot-a',
      thread: 'append:1',
      acpSessionId: 'acp-a',
      sessionId: 's-a'
    })
    await store.upsertSession({
      ...base,
      key: 'k-b',
      agentId: 'bot-b',
      thread: 'append:2',
      acpSessionId: 'acp-b',
      sessionId: 's-b'
    })

    await (daemon as any).scheduleSessionActivity({
      channel: 'C1',
      thread: '100.1',
      agentIds: ['U-human'],
      sessionKeys: ['k-a', 'k-b'],
      revision: 7
    })

    await vi.waitFor(() => expect(emitted).toHaveLength(2), WAIT)
    expect(emitted.map((a) => [a.agentId, a.sessionId]).sort()).toEqual([
      ['bot-a', 's-a'],
      ['bot-b', 's-b']
    ])
    await daemon.stop()
  })
})
