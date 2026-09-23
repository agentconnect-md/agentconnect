import { describe, expect, it, vi } from 'vitest'
import {
  DECISION_TRIGGER_V1_FEATURE,
  type Ack,
  type AgentActivate,
  type IntegrationSpec,
  type RegisterReq
} from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const gate = { type: 'gate' as const, decisionId: 'd1', when: { type: 'boolean' as const, values: [true] } }
const spec: IntegrationSpec = {
  integrationId: '66666666-6666-4666-8666-666666666666',
  agentId: AGENT,
  platform: 'slack',
  core: {
    mode: 'direct',
    bindRules: [{ channel: 'C1', match: { kind: 'decision' } }],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [{ channel: 'C1', consumer: gate, enabled: true }], definitions: [] }
  },
  config: {}
}

function sender(features: string[]) {
  const send = vi.fn((..._args: unknown[]) => undefined)
  const request = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as Ack)
  const conn = { daemonId: DAEMON, send, request, close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  const state: DaemonConnState = {
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
  }
  registry.add(state)
  return { control: new ControlSender(registry, {} as LaunchRepo), send, request }
}

describe('ControlSender decision-trigger encoding per peer', () => {
  it('sends an old daemon a spec with no decision rule and the conversation held', async () => {
    const { control, send } = sender([])
    await control.integrationUpsert(DAEMON, spec)
    const sent = send.mock.calls[0]![1] as IntegrationSpec
    expect(sent.core.bindRules).toEqual([])
    expect(sent.core.mutedChannels).toEqual(['C1'])
    expect(sent.core.decisions.bindings).toEqual([])
    expect(control.daemonFeatures(DAEMON)).toEqual([])
  })

  it('sends a capable daemon the spec unchanged, and encodes agent/activate integrations too', async () => {
    const capable = sender([DECISION_TRIGGER_V1_FEATURE])
    await capable.control.integrationUpsert(DAEMON, spec)
    expect(capable.send.mock.calls[0]![1]).toBe(spec)

    const old = sender([])
    const activate = { agentId: AGENT, moveId: 'm', spec: { name: 'a' }, integrations: [spec], crons: [] }
    await old.control.agentActivate(DAEMON, activate as unknown as AgentActivate)
    const payload = old.request.mock.calls[0]![1] as AgentActivate
    expect(payload.integrations[0]!.core.bindRules).toEqual([])
    expect(payload.integrations[0]!.core.mutedChannels).toEqual(['C1'])
  })
})
