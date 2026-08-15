// `duty/fetch` — a member pulls the definition of an agent it won a duty for.
// The load-bearing row is the authorization one: holding the duty is the ONLY
// thing that entitles a daemon to an agent's bundle.
import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleDutyFetch } from './duty-fetch.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INTEGRATION = '11111111-1111-4111-8111-111111111111'
const CRON = '22222222-2222-4222-8222-222222222222'
const ORG = 'org-a'

const AGENT_RECORD = { id: AGENT, orgId: ORG, daemonId: DAEMON }

const BUNDLE = {
  agentId: AGENT,
  spec: { orgId: ORG, name: 'scout', runtime: 'claude' },
  integrations: [
    {
      orgId: ORG,
      integrationId: INTEGRATION,
      agentId: AGENT,
      platform: 'slack',
      core: { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: 'xoxb-test' }
    }
  ],
  crons: [
    {
      orgId: ORG,
      cronId: CRON,
      agentId: AGENT,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'standup',
      enabled: true
    }
  ]
}

function fetchFrame(agentId = AGENT): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-08-14T00:00:00.000Z',
    type: 'duty/fetch',
    payload: { agentId }
  } as AnyFrame
}

/** An install-wide connection — the only kind that can hold duties. */
function fakeConn(orgId: string | null = null) {
  return {
    daemonId: DAEMON,
    orgId,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

/** The per-connection id→org maps `register` normally builds. A duty holder that
 *  installed mid-session never registered these resources, so they start empty. */
function fakeScopes() {
  return { orgByAgent: new Map<string, string>(), orgByIntegration: new Map(), orgByCron: new Map() }
}

function fakeDeps(
  over: {
    agent?: unknown
    holdsAgent?: boolean
    agentBundle?: ReturnType<typeof vi.fn>
  },
  scopes = fakeScopes()
): DaemonWsDeps {
  return {
    agent: { getUnscoped: async () => over.agent ?? null },
    dutyLease: { holdsAgent: async () => over.holdsAgent ?? false },
    connReg: { get: () => scopes },
    agentBundle: over.agentBundle ?? vi.fn(async () => BUNDLE)
  } as unknown as DaemonWsDeps
}

describe('handleDutyFetch', () => {
  it('refuses an org-scoped connection — the duty ledger is install-wide', async () => {
    const conn = fakeConn(ORG)
    const agentBundle = vi.fn(async () => BUNDLE)
    const frame = fetchFrame()

    await handleDutyFetch(frame, conn, fakeDeps({ agent: AGENT_RECORD, holdsAgent: true, agentBundle }))

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'duty ledger requires an install-wide connection',
      false
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(agentBundle).not.toHaveBeenCalled()
  })

  it('an unknown agent answers empty, never an error frame', async () => {
    const conn = fakeConn()
    const frame = fetchFrame()

    await handleDutyFetch(frame, conn, fakeDeps({ agent: null, holdsAgent: true }))

    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'duty/fetch/ok', {})
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('NOT holding the duty answers empty — holding it is the whole authorization', async () => {
    const conn = fakeConn()
    const agentBundle = vi.fn(async () => BUNDLE)
    const frame = fetchFrame()

    await handleDutyFetch(frame, conn, fakeDeps({ agent: AGENT_RECORD, holdsAgent: false, agentBundle }))

    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'duty/fetch/ok', {})
    // The bundle is never even assembled for a daemon that did not win the agent.
    expect(agentBundle).not.toHaveBeenCalled()
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('holding the duty answers the full spec + integrations + crons bundle', async () => {
    const conn = fakeConn()
    const agentBundle = vi.fn(async () => BUNDLE)
    const frame = fetchFrame()

    await handleDutyFetch(frame, conn, fakeDeps({ agent: AGENT_RECORD, holdsAgent: true, agentBundle }))

    expect(agentBundle).toHaveBeenCalledWith(AGENT_RECORD)
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'duty/fetch/ok', { bundle: BUNDLE })
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('teaches the connection which org the fetched resources belong to', async () => {
    // The id→org maps are otherwise built ONLY from the register snapshot, so a
    // resource installed mid-session through this path is absent from them — and
    // any later C→D frame carrying a bare id has no org to resolve on an
    // install-wide connection. A hint, never an authorization: holding the duty
    // is what authorizes, and the removals carry their org explicitly anyway.
    const scopes = fakeScopes()
    const conn = fakeConn()

    await handleDutyFetch(fetchFrame(), conn, fakeDeps({ agent: AGENT_RECORD, holdsAgent: true }, scopes))

    expect(scopes.orgByAgent.get(AGENT)).toBe(ORG)
    expect(scopes.orgByIntegration.get(INTEGRATION)).toBe(ORG)
    expect(scopes.orgByCron.get(CRON)).toBe(ORG)
  })

  it('a refused fetch teaches the connection nothing', async () => {
    const scopes = fakeScopes()
    const conn = fakeConn()

    await handleDutyFetch(fetchFrame(), conn, fakeDeps({ agent: AGENT_RECORD, holdsAgent: false }, scopes))

    expect(scopes.orgByAgent.size).toBe(0)
    expect(scopes.orgByIntegration.size).toBe(0)
    expect(scopes.orgByCron.size).toBe(0)
  })

  it('answers empty when no bundle assembler is wired', async () => {
    const conn = fakeConn()
    const deps = {
      agent: { getUnscoped: async () => AGENT_RECORD },
      dutyLease: { holdsAgent: async () => true }
    } as unknown as DaemonWsDeps

    const frame = fetchFrame()
    await handleDutyFetch(frame, conn, deps)

    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'duty/fetch/ok', {})
  })
})
