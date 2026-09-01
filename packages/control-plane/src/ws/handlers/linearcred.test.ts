import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleLinearCredRequest } from './linearcred.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON_ID = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOT_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INTEGRATION_ID = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
const ORG_ID = 'org-a'
const EXPIRES = new Date('2026-09-02T00:00:00.000Z')

/** An agent placed on DAEMON_ID — passes the handler's placement scope check. */
const PLACED_AGENT = { id: AGENT_ID, orgId: ORG_ID, daemonId: DAEMON_ID }
const LINEAR_INTEGRATION = { id: INTEGRATION_ID, orgId: ORG_ID, agentId: AGENT_ID, botId: BOT_ID, platform: 'linear' }
/** The connected workspace's D6 pair — what the grant is keyed by (§4.4). */
const WORKSPACE_BOT = { orgId: ORG_ID, externalAppId: 'lin_client_id', externalTenantId: 'org_alpha' }

function linearcredFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-09-01T00:00:00.000Z',
    type: 'linearcred/request',
    payload: { integrationId: INTEGRATION_ID }
  } as AnyFrame
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: ORG_ID,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

/** The whole graph the handler reads, with the token service's answer as the one variable. */
function fakeDeps(
  accessToken: () => unknown,
  overrides: Partial<Record<'integration' | 'agent' | 'bot' | 'integrationConverge', unknown>> = {}
): DaemonWsDeps {
  return {
    log: { error: vi.fn() },
    integration: { get: async () => LINEAR_INTEGRATION },
    agent: { get: async () => PLACED_AGENT },
    bot: { get: async () => WORKSPACE_BOT },
    linearTokens: { accessToken },
    ...overrides
  } as unknown as DaemonWsDeps
}

const GRANTED = () => ({ ok: true, accessToken: 'lin_access_2', expiresAt: EXPIRES, rotated: false })

describe('handleLinearCredRequest — the broker seam (linear-integration.md §7.3)', () => {
  it('answers a placed agent with the token service’s grant, keyed by the bot’s connection identity', async () => {
    const accessToken = vi.fn(GRANTED)
    const deps = fakeDeps(accessToken)
    const conn = fakeConn()
    const frame = linearcredFrame()

    await handleLinearCredRequest(frame, conn, deps)

    expect(accessToken).toHaveBeenCalledWith({
      orgId: ORG_ID,
      clientId: 'lin_client_id',
      organizationId: 'org_alpha'
    })
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'linearcred/grant', {
      accessToken: 'lin_access_2',
      expiresAt: EXPIRES.toISOString()
    })
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('refuses a daemon that does not serve the integration’s agent — terminal, so it stops asking', async () => {
    const accessToken = vi.fn(GRANTED)
    const conn = fakeConn()
    const deps = fakeDeps(accessToken, {
      agent: { get: async () => ({ ...PLACED_AGENT, daemonId: OTHER_DAEMON_ID }) }
    })

    await handleLinearCredRequest(linearcredFrame(), conn, deps)

    expect(accessToken).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'this daemon does not serve that agent',
      false
    )
  })

  it('refuses a missing or non-linear integration before it resolves any credential', async () => {
    for (const integration of [null, { ...LINEAR_INTEGRATION, platform: 'slack' }]) {
      const accessToken = vi.fn(GRANTED)
      const conn = fakeConn()
      await handleLinearCredRequest(
        linearcredFrame(),
        conn,
        fakeDeps(accessToken, { integration: { get: async () => integration } })
      )
      expect(accessToken).not.toHaveBeenCalled()
      expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    }
  })

  it('refuses everything when the control plane composes no token service', async () => {
    const conn = fakeConn()
    const deps = {
      log: { error: vi.fn() },
      integration: { get: async () => LINEAR_INTEGRATION }
    } as unknown as DaemonWsDeps

    await handleLinearCredRequest(linearcredFrame(), conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'linear workspaces are not enabled on this control plane',
      false
    )
  })

  it('reads an incomplete D6 pair as a connection only an operator can repair', async () => {
    const accessToken = vi.fn(GRANTED)
    const conn = fakeConn()
    const deps = fakeDeps(accessToken, { bot: { get: async () => ({ orgId: ORG_ID }) } })

    await handleLinearCredRequest(linearcredFrame(), conn, deps)

    expect(accessToken).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'LEASE_DENIED', expect.any(String), false)
  })

  it('separates a dead grant from an unreachable Linear — only the first is terminal', async () => {
    for (const reason of ['reconnect_required', 'not_connected'] as const) {
      const conn = fakeConn()
      await handleLinearCredRequest(
        linearcredFrame(),
        conn,
        fakeDeps(() => ({ ok: false, reason }))
      )
      expect(conn.sendError).toHaveBeenCalledWith(
        expect.any(String),
        'LEASE_DENIED',
        'this Linear workspace needs reconnecting',
        false
      )
      expect(conn.replyTo).not.toHaveBeenCalled()
    }

    const conn = fakeConn()
    await handleLinearCredRequest(
      linearcredFrame(),
      conn,
      fakeDeps(() => ({ ok: false, reason: 'unreachable' }))
    )
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'INTERNAL', 'linear is unreachable', true)
  })

  it('answers a thrown token resolution as retryable rather than letting it close the socket', async () => {
    const conn = fakeConn()
    const deps = fakeDeps(() => {
      throw new Error('postgres is down')
    })

    await expect(handleLinearCredRequest(linearcredFrame(), conn, deps)).resolves.toBeUndefined()

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'INTERNAL', 'linear token resolution failed', true)
  })
})

describe('handleLinearCredRequest — the spec re-push (§7.3)', () => {
  it('re-pushes only when the grant rotated, so an unchanged token costs no fan-out', async () => {
    const integrationConverge = vi.fn(async () => {})
    const conn = fakeConn()

    await handleLinearCredRequest(linearcredFrame(), conn, fakeDeps(GRANTED, { integrationConverge }))
    expect(integrationConverge).not.toHaveBeenCalled()

    await handleLinearCredRequest(
      linearcredFrame(),
      conn,
      fakeDeps(() => ({ ...GRANTED(), rotated: true }), { integrationConverge })
    )
    expect(integrationConverge).toHaveBeenCalledWith(PLACED_AGENT)
  })

  it('keeps a grant that already landed when the re-push fails — the roster converges it later', async () => {
    const integrationConverge = vi.fn(async () => {
      throw new Error('no connection')
    })
    const conn = fakeConn()
    const deps = fakeDeps(() => ({ ...GRANTED(), rotated: true }), { integrationConverge })

    await expect(handleLinearCredRequest(linearcredFrame(), conn, deps)).resolves.toBeUndefined()

    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'linearcred/grant', expect.anything())
    expect(conn.sendError).not.toHaveBeenCalled()
  })
})
