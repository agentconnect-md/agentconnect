// A place of an assistant-mode agent turning external (assistant-mode.md §5.3): it reads external at once, reaches the CP, and cuts only that place's turn.
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import { PlaceTrust, type PlaceTrustDeps } from '../src/assistant/place-trust.js'
import { Daemon } from '../src/daemon.js'
import { conversationTrustLevel } from '../src/router/routing-rule.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const integrationOf = (id: string, externalChannels: string[] = [], mode: 'direct' | 'shared' = 'direct') =>
  ({
    id,
    platform: 'slack',
    core: { mode, bindRules: [], mutedChannels: [], gated: true, externalChannels }
  }) as unknown as Integration

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('PlaceTrust', () => {
  function world(owned: Record<string, boolean>, external: Record<string, string[]> = {}) {
    const integrations = new Map(Object.keys(owned).map((id) => [id, integrationOf(id, external[id])]))
    const reports: [string, IntegrationChannel][] = []
    const interrupts: [string, string][] = []
    const deps: PlaceTrustDeps = {
      integration: (id) => integrations.get(id),
      assistantOwned: (id) => owned[id] === true,
      report: (id, channel) => void reports.push([id, channel]),
      interrupt: async (id, channel) => void interrupts.push([id, channel]),
      warn: () => {}
    }
    return { trust: new PlaceTrust(deps), integrations, reports, interrupts }
  }

  it('downgrades an internal place of an assistant-mode agent once: it reads external, is reported, and its turn is cut', async () => {
    const w = world({ 'int-a': true, 'int-b': false })
    w.trust.detected(['int-a', 'int-b'], 'C1', 'guestMember')
    w.trust.detected(['int-a', 'int-b'], 'C1', 'externallyShared')
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('external')
    expect(conversationTrustLevel(w.integrations.get('int-b')!, 'C1')).toBe('internal')
    expect(w.reports).toEqual([['int-a', { id: 'C1', externalReason: 'guestMember' }]])
    expect(w.interrupts).toEqual([['int-a', 'C1']])
  })

  it('reports a guest in an already shared place so it turns sticky, with no second transition', async () => {
    const w = world({ 'int-a': true }, { 'int-a': ['C1'] })
    w.trust.detected(['int-a'], 'C1', 'guestMember')
    await settle()
    expect(w.reports).toEqual([['int-a', { id: 'C1', externalReason: 'guestMember' }]])
    expect(w.interrupts).toEqual([])
  })

  it('takes the share flag of a room or group DM message, never of a 1:1 DM', async () => {
    const w = world({ 'int-a': true })
    w.trust.observe({ channel: 'D1', isDm: true, externallyShared: true }, ['int-a'])
    w.trust.observe({ channel: 'C2', isDm: false }, ['int-a'])
    w.trust.observe({ channel: 'G1', isDm: false, isGroupDm: true, externallyShared: true }, ['int-a'])
    w.trust.observe({ channel: 'C1', isDm: false, externallyShared: true }, ['int-a'])
    await settle()
    expect(w.reports.map(([, channel]) => channel)).toEqual([
      { id: 'G1', externalReason: 'externallyShared' },
      { id: 'C1', externalReason: 'externallyShared' }
    ])
    expect(w.interrupts).toEqual([
      ['int-a', 'G1'],
      ['int-a', 'C1']
    ])
  })

  it('runs the transition for a place the spec newly lists, holding it on the live integration until it reconciles', async () => {
    const w = world({ 'int-a': true, 'int-b': false })
    w.trust.specTurnedExternal('int-a', ['C1'])
    w.trust.specTurnedExternal('int-b', ['C1'])
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('external')
    expect(w.interrupts).toEqual([['int-a', 'C1']])
    expect(w.reports).toEqual([])
  })

  it('watches member joins only where an assistant-mode agent owns an integration', () => {
    const w = world({ 'int-a': true, 'int-b': false })
    expect(w.trust.watches(['int-b'])).toBe(false)
    expect(w.trust.watches(['int-b', 'int-a'])).toBe(true)
  })
})

describe('the daemon downgrade transition', () => {
  /** An assistant-mode agent and a plain one, with turns in flight across places. */
  function daemonWorld() {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.agents.set('bot-a', {
      id: 'bot-a',
      integrations: [integrationOf('int-a', [], 'shared')],
      assistantMode: { enabled: true, responsibleUserId: 'user-1' }
    })
    daemon.agents.set('bot-b', { id: 'bot-b', integrations: [integrationOf('int-b', [], 'shared')] })
    const entry = (agentId: string, integrationId: string, channel: string, extra: object = {}) => ({
      agentId,
      integrationId,
      msg: { channel, ...extra }
    })
    daemon.activeGateEntries.set('a-c1', entry('bot-a', 'int-a', 'C1'))
    daemon.activeGateEntries.set('a-c2', entry('bot-a', 'int-a', 'C2'))
    daemon.activeGateEntries.set('a-c1-cron', entry('bot-a', 'int-a', 'C1', { headless: true }))
    daemon.activeGateEntries.set('b-c1', entry('bot-b', 'int-b', 'C1'))
    daemon.interruptTurn = vi.fn(async () => {})
    daemon.cpClient = { emitIntegrationChannels: vi.fn() }
    daemon.channelSnapshots.set('int-a', {
      channels: [{ id: 'C1', externalReason: null }],
      authoritative: true
    })
    return daemon
  }

  it('cuts only the in-flight turn delivering into the place, keeping queued messages for the draft path', async () => {
    const daemon = daemonWorld()
    daemon.placeTrust.detected(['int-a', 'int-b'], 'C1', 'guestMember')
    await settle()
    expect(daemon.interruptTurn).toHaveBeenCalledTimes(1)
    expect(daemon.interruptTurn).toHaveBeenCalledWith('bot-a', 'a-c1', 'place turned external', undefined, {
      integrationId: 'int-a',
      preserveQueued: true,
      allowSameKeyAdmissions: true
    })
    expect(daemon.cpClient.emitIntegrationChannels).toHaveBeenCalledTimes(1)
    expect(daemon.cpClient.emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: 'int-a',
      channels: [{ id: 'C1', externalReason: 'guestMember' }],
      authoritative: false
    })
    // A reconnect replays the cached listing; it now carries the detection.
    expect(daemon.channelSnapshots.get('int-a').channels).toEqual([{ id: 'C1', externalReason: 'guestMember' }])
  })

  it('looks up a member the relay forwarded only for an assistant-mode owner', async () => {
    const daemon = daemonWorld()
    const joinedMemberReason = vi.fn(async () => 'guestMember')
    daemon.connByIntegration.set('int-a', { joinedMemberReason })
    daemon.connByIntegration.set('int-b', { joinedMemberReason })
    const join = (agentId: string, integrationId: string) =>
      daemon.handleRelaySlackAction({
        agentId,
        integrationId,
        sessionKey: 'slack:C1',
        msgId: `m-${agentId}`,
        botId: 'bot-1',
        userId: 'UGUEST',
        payload: { kind: 'member-joined', channelId: 'C1', userId: 'UGUEST' }
      })
    expect(await join('bot-b', 'int-b')).toEqual({ msgId: 'm-bot-b', accepted: true })
    expect(joinedMemberReason).not.toHaveBeenCalled()
    expect(await join('bot-a', 'int-a')).toEqual({ msgId: 'm-bot-a', accepted: true })
    await settle()
    expect(joinedMemberReason).toHaveBeenCalledWith('UGUEST', false)
    expect(daemon.interruptTurn).toHaveBeenCalledWith(
      'bot-a',
      'a-c1',
      'place turned external',
      undefined,
      expect.objectContaining({ integrationId: 'int-a' })
    )
  })
})
