/**
 * Assistant mode keeps group DMs and private channels out of shared memory as well as private sessions
 * (assistant-mode.md §5.5): per-turn capture and explicit writes skip them; every other agent is unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { SessionContext } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import { appendCoordinate } from '../src/session/append-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const THREAD = appendCoordinate(1)

interface Place {
  /** The session row's classification. */
  conversationKind?: 'channel' | 'group_dm'
  /** What a membership listing or an observation reported. */
  snapshot?: Partial<IntegrationChannel>
  /** What a channel lookup reported. */
  lookup?: boolean
}

/** An org-visible session on `C1`, in a daemon whose agent is (or is not) in assistant mode. */
function world(place: Place, assistant: boolean) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const key = sessionKey('slack', 'C1', THREAD, AGENT)
  const row = { key, agentId: AGENT, platform: 'slack', channel: 'C1', thread: THREAD }
  daemon.store = {
    isCaptureExcluded: vi.fn(async () => false),
    getSession: vi.fn(async (k: string) =>
      k === key ? { ...row, conversationKind: place.conversationKind ?? 'channel' } : undefined
    )
  }
  daemon.memory = { recordTurnForBinding: vi.fn(async () => {}) }
  daemon.agents.set(AGENT, {
    id: AGENT,
    memory: { provider: 'managed' },
    ...(assistant ? { assistantMode: { enabled: true, responsibleUserId: 'user-1' } } : {})
  })
  if (place.snapshot)
    daemon.channelSnapshots.set('int-1', { channels: [{ id: 'C1', ...place.snapshot }], authoritative: true })
  if (place.lookup !== undefined) daemon.conversationPrivacy.set('C1', place.lookup)
  const captured = async (): Promise<boolean> => {
    await daemon.queueMemoryPostTurn(
      AGENT,
      'acp-1',
      'turn-1',
      'input',
      'output',
      { provider: 'managed' },
      undefined,
      'turn-1',
      {
        key,
        outwardSessionId: 'outward-1'
      }
    )
    await Promise.all(daemon.memoryPostTurnChains.values())
    return daemon.memory.recordTurnForBinding.mock.calls.length > 0
  }
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    channel: 'C1',
    thread: THREAD,
    deliveryThread: THREAD,
    isDm: false,
    tools: []
  }
  const write = (): Promise<string> => daemon.memoryAccessDecisionFor(ctx as unknown as SessionContext, 'write')
  return { daemon, captured, write }
}

describe('an assistant-mode agent leaves group DMs and private channels out of shared memory', () => {
  it.each<[string, Place]>([
    ['a group DM, by its session classification', { conversationKind: 'group_dm' }],
    ['a group DM the platform reported', { snapshot: { kind: 'mpim' } }],
    ['a channel the membership listing reports private', { snapshot: { isPrivate: true } }],
    ['a channel a lookup reports private', { lookup: true }]
  ])('%s: no capture, writes closed; outside assistant mode both as before', async (_, place) => {
    const assistant = world(place, true)
    expect(await assistant.captured()).toBe(false)
    expect(await assistant.write()).toBe('closed')
    const plain = world(place, false)
    expect(await plain.captured()).toBe(true)
    expect(await plain.write()).toBe('allow')
  })

  it.each<[string, Place]>([
    ['a channel the listing reports public', { snapshot: { isPrivate: false } }],
    ['a channel whose platform cannot tell', {}]
  ])('%s stays shared', async (_, place) => {
    const w = world(place, true)
    expect(await w.captured()).toBe(true)
    expect(await w.write()).toBe('allow')
  })

  it('counts a session it cannot find as private', async () => {
    const w = world({}, true)
    w.daemon.store.getSession = vi.fn(async () => undefined)
    expect(await w.captured()).toBe(false)
    expect(await w.write()).toBe('closed')
  })
})
