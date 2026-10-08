/**
 * Assistant mode keeps private places out of shared memory as well as private sessions (assistant-mode.md §5.5):
 * per-turn capture and explicit writes take a place's session only when its platform explicitly reported the
 * conversation not private; anything undetermined (right after a restart) fails closed. Other agents are unchanged.
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
  platform?: string
  channel?: string
  /** The session row's classification. */
  conversationKind?: 'dm' | 'channel' | 'group_dm'
  /** What a membership listing or an observation reported, on the agent's own integration. */
  snapshot?: Partial<IntegrationChannel>
  /** What a channel lookup reported. */
  lookup?: boolean
}

/** An org-visible session, in a daemon whose agent is (or is not) in assistant mode. */
function world(place: Place, assistant: boolean) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const platform = place.platform ?? 'slack'
  const channel = place.channel ?? 'C1'
  const key = sessionKey(platform, channel, THREAD, AGENT)
  const row = { key, agentId: AGENT, platform, channel, thread: THREAD }
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
    integrations: [{ id: 'int-1', platform: 'slack' }],
    ...(assistant ? { assistantMode: { enabled: true, responsibleUserId: 'user-1' } } : {})
  })
  if (place.snapshot)
    daemon.channelSnapshots.set('int-1', { channels: [{ id: channel, ...place.snapshot }], authoritative: true })
  if (place.lookup !== undefined) daemon.conversationPrivacy.set(channel, place.lookup)
  const captured = async (): Promise<boolean> => {
    daemon.memory.recordTurnForBinding.mockClear()
    const session = { key, outwardSessionId: 'outward-1' }
    await daemon.queueMemoryPostTurn(
      AGENT,
      'acp-1',
      'turn-1',
      'in',
      'out',
      { provider: 'managed' },
      undefined,
      'turn-1',
      session
    )
    await Promise.all(daemon.memoryPostTurnChains.values())
    return daemon.memory.recordTurnForBinding.mock.calls.length > 0
  }
  const ctx = { agentId: AGENT, platform, channel, thread: THREAD, deliveryThread: THREAD, isDm: false, tools: [] }
  const write = (): Promise<string> => daemon.memoryAccessDecisionFor(ctx as unknown as SessionContext, 'write')
  return { daemon, captured, write }
}

describe('an assistant-mode agent keeps a place out of shared memory unless it is known open', () => {
  it.each<[string, Place]>([
    ['a group DM, by its session classification', { conversationKind: 'group_dm' }],
    ['a DM, by its session classification', { conversationKind: 'dm' }],
    ['a group DM the platform reported', { snapshot: { kind: 'mpim' } }],
    ['a channel the membership listing reports private', { snapshot: { isPrivate: true } }],
    ['a channel a lookup reports private', { lookup: true }],
    ['a private lookup over a public listing', { snapshot: { isPrivate: false }, lookup: true }],
    ['a channel nothing is known about yet, as right after a restart', {}],
    ['a channel observed without its privacy', { snapshot: { kind: 'channel' } }],
    ['an org-visible webchat conversation', { platform: 'webchat', channel: 'conv-1' }]
  ])('%s: no capture, writes closed; outside assistant mode both as before', async (_, place) => {
    const assistant = world(place, true)
    expect(await assistant.captured()).toBe(false)
    expect(await assistant.write()).toBe('closed')
    const plain = world(place, false)
    expect(await plain.captured()).toBe(true)
    expect(await plain.write()).toBe('allow')
  })

  it.each<[string, Place]>([
    ['a channel the membership listing reports public', { snapshot: { isPrivate: false } }],
    ['a channel a lookup reports not private', { lookup: false }],
    ['a session that is no place at all', { platform: 'github', channel: 'example-org/example-repo' }]
  ])('%s stays shared', async (_, place) => {
    const w = world(place, true)
    expect(await w.captured()).toBe(true)
    expect(await w.write()).toBe('allow')
  })

  it('opens a place once the platform reports it after a restart, and only then', async () => {
    const w = world({}, true)
    expect(await w.captured()).toBe(false)
    expect(await w.write()).toBe('closed')
    w.daemon.channelSnapshots.set('int-1', { channels: [{ id: 'C1', isPrivate: false }], authoritative: true })
    expect(await w.captured()).toBe(true)
    expect(await w.write()).toBe('allow')
  })

  it('asks the platform itself when nothing is cached, and opens only on its explicit answer', async () => {
    for (const [answer, open] of [
      [false, true],
      [true, false],
      [undefined, false]
    ] as const) {
      const w = world({}, true)
      const getChannelInfo = vi.fn(async (id: string) => ({
        id,
        ...(answer === undefined ? {} : { isPrivate: answer })
      }))
      w.daemon.connForIntegration = (integrationId: string) =>
        integrationId === 'int-1' ? { getChannelInfo } : undefined
      expect(await w.captured()).toBe(open)
      expect(await w.write()).toBe(open ? 'allow' : 'closed')
      expect(getChannelInfo).toHaveBeenCalledWith('C1')
    }
  })

  it('ignores what another agent’s integration reported', async () => {
    const w = world({}, true)
    w.daemon.channelSnapshots.set('int-other', { channels: [{ id: 'C1', isPrivate: false }], authoritative: true })
    expect(await w.captured()).toBe(false)
  })

  it('counts a session it cannot find as private', async () => {
    const w = world({ snapshot: { isPrivate: false } }, true)
    w.daemon.store.getSession = vi.fn(async () => undefined)
    expect(await w.captured()).toBe(false)
    expect(await w.write()).toBe('closed')
  })
})
