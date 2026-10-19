import { describe, expect, it, vi } from 'vitest'
import { API_AHP_V1_FEATURE } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'
import { webchatAttachment } from './webchat-attachment.js'

const ORG = OrgId('org')
const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const PEER = AgentId('22222222-2222-4222-8222-222222222222')
const CONVERSATION = '33333333-3333-4333-8333-333333333333'
const input = { orgId: ORG, primaryAgentId: AGENT, conversationId: CONVERSATION }

function fixture() {
  const entries = new Set<string>([AGENT, PEER])
  const capable = new Set<string>([AGENT, PEER])
  const online = new Set<string>([AGENT, PEER])
  const bindings = new Map<string, { sessionUri: string }>()
  const config = {
    AHP_MODE: 'on' as 'off' | 'shadow' | 'on',
    WEBCHAT_PROTOCOL: 'ahp' as 'legacy' | 'ahp',
    PUBLIC_RELAY_URL: 'https://relay.example.test/prefix'
  }
  const findBinding = vi.fn(async (_org: string, agent: string) => bindings.get(agent) ?? null)
  const deps = {
    config,
    repos: {
      agent: { get: async (_org: string, id: string) => ({ id, orgId: ORG }) },
      agentApiEntry: { listForAgent: async (id: string) => (entries.has(id) ? [{ protocol: 'ahp' }] : []) },
      webchatConversation: { participants: async () => [{ agentId: AGENT }, { agentId: PEER }] },
      ahpSessionBinding: { forConversation: findBinding }
    },
    placementResolver: { dispatchDaemon: async (agent: { id: string }) => agent.id },
    daemonConns: {
      get: (id: string) => ({
        state: online.has(id) ? 'READY' : 'CLOSED',
        capabilities: { features: capable.has(id) ? [API_AHP_V1_FEATURE] : [] }
      })
    }
  } as unknown as HttpDeps
  return { deps, config, entries, capable, online, bindings, findBinding }
}

describe('Webchat attachment bootstrap', () => {
  it('keeps a legacy attachment pinned when deployment selection changes or AHP is disabled', async () => {
    const f = fixture()
    f.config.AHP_MODE = 'off'
    expect(await webchatAttachment(f.deps, { ...input, protocol: 'legacy' })).toEqual({ protocol: 'legacy' })
    expect(f.findBinding).not.toHaveBeenCalled()
    f.config.WEBCHAT_PROTOCOL = 'legacy'
    expect(await webchatAttachment(f.deps, input)).toEqual({ protocol: 'legacy' })
    expect(await webchatAttachment(f.deps, { ...input, protocol: 'ahp' })).toBeNull()
  })

  it.each(['off', 'shadow'] as const)('does not bootstrap an AHP attachment in %s mode', async (mode) => {
    const f = fixture()
    f.config.AHP_MODE = mode
    expect(await webchatAttachment(f.deps, input)).toBeNull()
  })

  it.each(['entry', 'capability', 'offline'] as const)(
    'requires every participant to pass the %s gate',
    async (gate) => {
      const f = fixture()
      if (gate === 'entry') f.entries.delete(PEER)
      if (gate === 'capability') f.capable.delete(PEER)
      if (gate === 'offline') f.online.delete(PEER)
      expect(await webchatAttachment(f.deps, input)).toBeNull()
    }
  )

  it('returns agent endpoints and only CP-owned URI bindings without embedding credentials', async () => {
    const f = fixture()
    f.bindings.set(AGENT, { sessionUri: 'ahp-session:/client-chosen' })
    const result = await webchatAttachment(f.deps, input)
    expect(result).toEqual({
      protocol: 'ahp',
      ahp: {
        url: `wss://relay.example.test/prefix/ahp/agents/${AGENT}`,
        sessionUri: 'ahp-session:/client-chosen',
        peers: [
          {
            agentId: AGENT,
            url: `wss://relay.example.test/prefix/ahp/agents/${AGENT}`,
            sessionUri: 'ahp-session:/client-chosen'
          },
          { agentId: PEER, url: `wss://relay.example.test/prefix/ahp/agents/${PEER}` }
        ]
      }
    })
    expect(f.findBinding).toHaveBeenCalledWith(ORG, PEER, CONVERSATION)
  })

  it('uses the already-authorized explicit roster for a new or continued conversation', async () => {
    const f = fixture()
    f.capable.delete(PEER)
    const result = await webchatAttachment(f.deps, { ...input, agentIds: [AGENT] })
    expect(result?.ahp?.peers.map((peer) => peer.agentId)).toEqual([AGENT])
  })

  it.each([
    'https://secret@relay.test',
    'https://relay.test?token=secret',
    'https://relay.test#secret',
    'ftp://relay.test'
  ])('refuses unsafe relay origins without returning secrets: %s', async (url) => {
    const f = fixture()
    f.config.PUBLIC_RELAY_URL = url
    expect(await webchatAttachment(f.deps, input)).toBeNull()
  })
})
