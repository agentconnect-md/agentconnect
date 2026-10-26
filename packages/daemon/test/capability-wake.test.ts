// A settled capability request's reminder (capability-requests.md §4.7.2–§4.7.3): one durable turn per origin and generation, speaking for that origin's askers.
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityAskers, SessionCapabilitySettled } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'

interface Inner {
  agents: Map<string, unknown>
  connByIntegration: Map<string, unknown>
  activeGateEntries: Map<string, { msg: NormalizedMessage }>
  store: { getSessionByOutwardId: (sessionId: string, agentId: string) => Promise<SessionRecord | undefined> }
  dispatch: ReturnType<typeof vi.fn>
  dispatchCapabilityWake: (req: SessionCapabilitySettled, text: string, askers: CapabilityAskers) => Promise<unknown>
  openerOf: (agentId: string, thread: string, key: string) => Promise<unknown>
}

function harness(admission: { accepted: boolean; reason?: string } = { accepted: true }) {
  const daemon = new Daemon({ sandboxMechanism: null } as never)
  const key = sessionKey('slack', 'C-GENERAL', '1700000000.000100', AGENT_ID)
  const session = {
    key,
    agentId: AGENT_ID,
    acpSessionId: 'acp-1',
    sessionId: SESSION_ID,
    platform: 'slack',
    channel: 'C-GENERAL',
    thread: '1700000000.000100',
    transportScope: null,
    conversationKind: 'channel',
    replyThread: null
  } as unknown as SessionRecord
  const inner = daemon as never as Inner
  inner.agents.set(AGENT_ID, { id: AGENT_ID, integrations: [{ id: 'int-s', platform: 'slack' }] })
  inner.connByIntegration.set('int-s', { postMessage: vi.fn() })
  inner.store = { getSessionByOutwardId: vi.fn(async () => session) }
  inner.dispatch = vi.fn(async (...args: unknown[]) => {
    ;(args[5] as { onAdmission: (result: unknown) => void }).onAdmission(admission)
    return SESSION_ID
  })
  return { inner, key }
}

const askers: CapabilityAskers = {
  people: [{ kind: 'member', platform: 'slack', integrationId: 'int-s', userId: 'U1', name: 'Ana' }],
  nobody: false
}

const wake = (key: string, over: Partial<SessionCapabilitySettled> = {}): SessionCapabilitySettled => ({
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
  sessionKey: key,
  requestId: REQUEST_ID,
  generation: 2,
  status: 'completed',
  askers,
  summary: 'add the MCP server "Linear"',
  reason: 'filing needs it',
  outcome: 'MCP server "Linear" was added to this agent.',
  reload: false,
  ...over
})

describe('capability wake', () => {
  it('enqueues a durable system continuation keyed per request, generation and origin, carrying its askers', async () => {
    const { inner, key } = harness()
    await expect(inner.dispatchCapabilityWake(wake(key), 'reminder', askers)).resolves.toEqual({ accepted: true })
    const [agentId, message, integrationId, , callMeta, options] = inner.dispatch.mock.calls[0]! as [
      string,
      NormalizedMessage,
      string,
      unknown,
      Record<string, unknown>,
      Record<string, unknown>
    ]
    expect(agentId).toBe(AGENT_ID)
    expect(integrationId).toBe('int-s')
    expect(message).toMatchObject({
      source: 'system',
      trigger: 'auto',
      text: 'reminder',
      channel: 'C-GENERAL',
      capabilityWake: {
        requestId: REQUEST_ID,
        generation: 2,
        askers: { people: [{ kind: 'member', platform: 'slack', integrationId: 'int-s', userId: 'U1' }], nobody: false }
      }
    })
    expect(callMeta).toMatchObject({ conversationContinuation: true })
    expect(options).toMatchObject({ requireDurable: true, deliveryId: `capability:${REQUEST_ID}:2:${SESSION_ID}` })
  })

  it('answers paused, and not_found for a session that is gone', async () => {
    const paused = harness({ accepted: false, reason: 'paused' })
    await expect(paused.inner.dispatchCapabilityWake(wake(paused.key), 'r', askers)).resolves.toEqual({
      accepted: false,
      reason: 'paused'
    })
    const gone = harness()
    await expect(gone.inner.dispatchCapabilityWake(wake('another-key'), 'r', askers)).resolves.toEqual({
      accepted: false,
      reason: 'not_found'
    })
    expect(gone.inner.dispatch).not.toHaveBeenCalled()
  })

  it('makes the reminder turn speak for the askers it carries', async () => {
    const { inner, key } = harness()
    const carried = { people: [{ kind: 'console' as const, userId: 'user-1' }], nobody: false }
    inner.activeGateEntries.set(key, {
      msg: {
        msgId: 'm',
        capabilityWake: { requestId: REQUEST_ID, generation: 2, askers: carried }
      } as NormalizedMessage
    })
    await expect(inner.openerOf(AGENT_ID, '1700000000.000100', key)).resolves.toEqual(carried)
  })
})
