// An integration whose spec requires a daemon feature is removed from a daemon without it, never sent (teams-integration.md §8.5).
import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_CHAT_RELAY_EGRESS_V1_FEATURE,
  MSTEAMS_RELAY_EGRESS_V1_FEATURE,
  type Ack,
  type AgentActivate,
  type IntegrationSpec,
  type RegisterReq
} from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { integrationDeliverableToPeer } from '../domain/decision-trigger-features.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const spec: IntegrationSpec = {
  orgId: ORG,
  integrationId: '66666666-6666-4666-8666-666666666666',
  agentId: AGENT,
  platform: 'msteams',
  core: {
    mode: 'shared',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { appId: 'a', tenantId: 't', egress: 'relay', botId: '77777777-7777-4777-8777-777777777777' },
  requires: [MSTEAMS_RELAY_EGRESS_V1_FEATURE]
}

function sender(features: string[]) {
  const send = vi.fn((..._args: unknown[]) => undefined)
  const request = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as Ack)
  const conn = { daemonId: DAEMON, send, request, close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  registry.add({
    daemonId: DAEMON,
    conn,
    sessionEpoch: 3,
    state: 'READY',
    maxAgents: 1,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map(),
    capabilities: { features } as unknown as RegisterReq['capabilities']
  } as DaemonConnState)
  return { control: new ControlSender(registry, {} as LaunchRepo), send, request }
}

describe('integrations a daemon must advertise a feature to hold', () => {
  it('are deliverable only to a daemon advertising every required feature', () => {
    expect(integrationDeliverableToPeer(spec, [MSTEAMS_RELAY_EGRESS_V1_FEATURE])).toBe(true)
    expect(integrationDeliverableToPeer(spec, [])).toBe(false)
    expect(integrationDeliverableToPeer(spec, undefined)).toBe(false)
    expect(integrationDeliverableToPeer({}, undefined)).toBe(true)
  })

  it('are removed from an older daemon on a live upsert, and sent to a capable one', async () => {
    const old = sender([])
    await old.control.integrationUpsert(DAEMON, spec)
    expect(old.send).toHaveBeenCalledTimes(1)
    expect(old.send.mock.calls[0]!.slice(0, 2)).toEqual(['integration/remove', { integrationId: spec.integrationId }])

    const capable = sender([MSTEAMS_RELAY_EGRESS_V1_FEATURE])
    await capable.control.integrationUpsert(DAEMON, spec)
    expect(capable.send.mock.calls[0]![0]).toBe('integration/upsert')
  })

  it('hold a Google Chat deployment row back from a daemon without its relay egress (google-chat-integration.md §10.10)', async () => {
    const googleChat: IntegrationSpec = {
      ...spec,
      platform: 'googlechat',
      config: {
        projectId: 'example-project',
        projectNumber: '100000000000',
        tenantIds: ['customers/C0000000001'],
        egress: 'relay',
        botId: '77777777-7777-4777-8777-777777777777'
      },
      requires: [GOOGLE_CHAT_RELAY_EGRESS_V1_FEATURE]
    }
    const old = sender([MSTEAMS_RELAY_EGRESS_V1_FEATURE])
    await old.control.integrationUpsert(DAEMON, googleChat)
    expect(old.send.mock.calls[0]![0]).toBe('integration/remove')
    const capable = sender([GOOGLE_CHAT_RELAY_EGRESS_V1_FEATURE])
    await capable.control.integrationUpsert(DAEMON, googleChat)
    expect(capable.send.mock.calls[0]![0]).toBe('integration/upsert')
  })

  it('are removed and left out of an activation bundle for an older daemon', async () => {
    const old = sender([])
    const activate = { agentId: AGENT, moveId: 'm', spec: { name: 'a' }, integrations: [spec], crons: [] }
    await old.control.agentActivate(DAEMON, activate as unknown as AgentActivate, ORG)
    expect(old.send.mock.calls.map((c) => c[0])).toEqual(['integration/remove'])
    expect((old.request.mock.calls[0]![1] as AgentActivate).integrations).toEqual([])
  })
})
