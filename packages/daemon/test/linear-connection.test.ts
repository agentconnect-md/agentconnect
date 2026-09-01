/**
 * The Linear Layer-1 connection (linear-integration.md §9.4): config-schema fail-closed
 * reads, the `linearcred` token cache, send-queue pacing, the GraphQL request shapes, and
 * the deliberately narrow read port.
 *
 * Everything here is platform-neutral: no filesystem paths, no real timers, and a fake
 * wall clock for the token margin and the queue's spacing.
 */
import { describe, it, expect } from 'vitest'
import type { Agent, Integration } from '../src/agents/agent-schema.js'
import { platformIntegrationConfig } from '../src/platforms/integration-config.js'
import {
  consolidateLinear,
  LinearApiError,
  LinearConnection,
  LinearTokenUnavailableError,
  linearConnKey,
  RENEW_MARGIN_MS,
  type ConsolidatedLinearGroup,
  type LinearDeps
} from '../src/platforms/linear/connection.js'

const WORKSPACE = 'a2f2f0d4-0e33-4c4b-9a4b-4f7a0f1f0001'
const SESSION = 'c3f1e0aa-4d2f-4f0a-9b1e-2b6d5c4a0002'
const ISSUE = 'd7c2b1aa-6e5f-4a3b-8c9d-1e2f3a4b0003'
const START = Date.parse('2026-09-01T00:00:00.000Z')
/** Comfortably outside the 2 h renewal margin. */
const FRESH_EXPIRY = new Date(START + 20 * 60 * 60 * 1000).toISOString()
/** Inside the margin, so the very next token read renews. */
const NEAR_EXPIRY = new Date(START + 30 * 60 * 1000).toISOString()

function linearConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE,
    workspaceName: 'Example Workspace',
    appUserId: 'app-user-1',
    accessToken: 'snapshot-token',
    accessTokenExpiresAt: FRESH_EXPIRY,
    ...overrides
  }
}

function linearIntegration(config: unknown, id = 'int-1'): Integration {
  return {
    id,
    platform: 'linear',
    core: { mode: 'shared', bindRules: [], mutedChannels: [], gated: false },
    config
  } as Integration
}

function linearAgent(id: string, config: unknown, integrationId = `int-${id}`): Agent {
  return { id, integrations: [linearIntegration(config, integrationId)] } as unknown as Agent
}

/** A wall clock the test drives; `sleep` advances it instead of waiting. */
function fakeClock(start = START) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

interface RecordedCall {
  url: string
  authorization: string
  query: string
  variables: Record<string, unknown>
  at: number
}

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

function group(config: Record<string, unknown> = linearConfig()): ConsolidatedLinearGroup {
  const parsed = platformIntegrationConfig('linear', linearIntegration(config))
  if (!parsed) throw new Error('fixture config must pass the linear schema')
  return {
    key: linearConnKey({ integrationId: 'int-1', workspaceId: WORKSPACE }),
    agentId: 'agent-1',
    integrationId: 'int-1',
    config: parsed,
    integrations: [{ agentId: 'agent-1', integrationId: 'int-1' }]
  }
}

/** A connection over a scripted fake fetch, with every timer and clock injected. */
function harness(
  opts: {
    config?: Record<string, unknown>
    respond?: (call: RecordedCall) => Response
    requestToken?: LinearDeps['requestToken']
    sendIntervalMs?: number
  } = {}
) {
  const clock = fakeClock()
  const calls: RecordedCall[] = []
  const timers: { fired: boolean; cleared: boolean }[] = []
  const warnings: string[] = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string }
    const parsed = JSON.parse(request.body) as { query: string; variables: Record<string, unknown> }
    const call: RecordedCall = {
      url: String(url),
      authorization: request.headers.authorization ?? '',
      query: parsed.query,
      variables: parsed.variables,
      at: clock.now()
    }
    calls.push(call)
    return opts.respond ? opts.respond(call) : jsonResponse({ data: { ok: true } })
  }) as unknown as typeof fetch

  const conn = new LinearConnection({
    group: group(opts.config ?? linearConfig()),
    requestToken: opts.requestToken ?? (async () => ({ accessToken: 'renewed', expiresAt: FRESH_EXPIRY })),
    fetchImpl,
    endpoint: 'https://linear.example.test/graphql',
    sendIntervalMs: opts.sendIntervalMs ?? 0,
    now: clock.now,
    sleep: clock.sleep,
    setTimer: () => {
      const handle = { fired: false, cleared: false }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log: {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (m) => warnings.push(m),
      error: () => {}
    }
  })
  return { conn, calls, clock, timers, warnings }
}

describe('linear config schema (§6.4 fail-closed)', () => {
  it('accepts a full spec payload and narrows it to the linear module', () => {
    const parsed = platformIntegrationConfig('linear', linearIntegration(linearConfig()))
    expect(parsed).toEqual({
      workspaceId: WORKSPACE,
      workspaceName: 'Example Workspace',
      appUserId: 'app-user-1',
      accessToken: 'snapshot-token',
      accessTokenExpiresAt: FRESH_EXPIRY
    })
  })

  it('accepts the minimal payload: workspace, token and expiry', () => {
    const minimal = { workspaceId: WORKSPACE, accessToken: 't', accessTokenExpiresAt: FRESH_EXPIRY }
    expect(platformIntegrationConfig('linear', linearIntegration(minimal))).toEqual(minimal)
  })

  it('fails closed on a missing token, a missing expiry and a non-datetime expiry', () => {
    const cases = [
      { workspaceId: WORKSPACE, accessTokenExpiresAt: FRESH_EXPIRY },
      { workspaceId: WORKSPACE, accessToken: 't' },
      { workspaceId: WORKSPACE, accessToken: 't', accessTokenExpiresAt: '2026-09-01' },
      { accessToken: 't', accessTokenExpiresAt: FRESH_EXPIRY },
      { workspaceId: WORKSPACE, accessToken: 42, accessTokenExpiresAt: FRESH_EXPIRY }
    ]
    for (const config of cases) {
      expect(platformIntegrationConfig('linear', linearIntegration(config))).toBeUndefined()
    }
  })

  it('refuses to read a linear entry as another platform, and an absent config at all', () => {
    expect(platformIntegrationConfig('slack', linearIntegration(linearConfig()))).toBeUndefined()
    expect(platformIntegrationConfig('linear', linearIntegration(undefined))).toBeUndefined()
  })
})

describe('consolidateLinear (§7.5 groups)', () => {
  it('emits one group per integration, keyed by integration and workspace', () => {
    const groups = consolidateLinear([linearAgent('a', linearConfig()), linearAgent('b', linearConfig())])
    expect([...groups.keys()]).toEqual([
      linearConnKey({ integrationId: 'int-a', workspaceId: WORKSPACE }),
      linearConnKey({ integrationId: 'int-b', workspaceId: WORKSPACE })
    ])
    expect(groups.get(linearConnKey({ integrationId: 'int-a', workspaceId: WORKSPACE }))?.agentId).toBe('a')
  })

  it('skips a config the schema rejects, with a warning naming the integration', () => {
    const warnings: string[] = []
    const log = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {}
    }
    const groups = consolidateLinear([linearAgent('a', { workspaceId: WORKSPACE })], log)
    expect(groups.size).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('int-a')
  })

  it('keys on the workspace too, so a re-pointed integration is a different connection', () => {
    const other = 'b9e1d2c3-1111-4222-8333-444455550004'
    expect(linearConnKey({ integrationId: 'int-1', workspaceId: WORKSPACE })).not.toBe(
      linearConnKey({ integrationId: 'int-1', workspaceId: other })
    )
  })
})

describe('linear token cache (§4.4)', () => {
  it('serves the spec snapshot without a broker request while outside the margin', async () => {
    let requests = 0
    const { conn } = harness({
      requestToken: async () => {
        requests += 1
        return { accessToken: 'renewed', expiresAt: FRESH_EXPIRY }
      }
    })
    await conn.start()
    expect(await conn.token()).toBe('snapshot-token')
    expect(requests).toBe(0)
  })

  it('renews once inside the margin and swaps the cached token', async () => {
    let requests = 0
    const { conn, calls } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        return { accessToken: 'renewed', expiresAt: FRESH_EXPIRY }
      }
    })
    expect(await conn.token()).toBe('renewed')
    expect(requests).toBe(1)
    // The swapped token is now outside the margin, so a second read asks nobody.
    expect(await conn.token()).toBe('renewed')
    expect(requests).toBe(1)
    await conn.createActivity(SESSION, { type: 'thought', body: 'hi' })
    expect(calls[0]?.authorization).toBe('Bearer renewed')
  })

  it('collapses concurrent reads inside the margin into a single broker request', async () => {
    let requests = 0
    const { conn } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        return { accessToken: 'renewed', expiresAt: FRESH_EXPIRY }
      }
    })
    const tokens = await Promise.all([conn.token(), conn.token(), conn.token()])
    expect(tokens).toEqual(['renewed', 'renewed', 'renewed'])
    expect(requests).toBe(1)
  })

  it('issues one request for concurrent sends inside the margin', async () => {
    let requests = 0
    const { conn, calls } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        return { accessToken: 'renewed', expiresAt: FRESH_EXPIRY }
      }
    })
    await Promise.all([
      conn.createActivity(SESSION, { type: 'thought', body: 'a' }),
      conn.createActivity(SESSION, { type: 'thought', body: 'b' })
    ])
    expect(requests).toBe(1)
    expect(calls.map((c) => c.authorization)).toEqual(['Bearer renewed', 'Bearer renewed'])
  })

  it('keeps serving the cached token when renewal fails but the snapshot has not expired', async () => {
    const { conn, warnings } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        throw new Error('LEASE_DENIED')
      }
    })
    expect(await conn.token()).toBe('snapshot-token')
    expect(warnings.some((w) => w.includes('serving the cached token'))).toBe(true)
  })

  it('does not re-ask the broker on every read after a failure, then retries after the backoff', async () => {
    let requests = 0
    const { conn, clock } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        throw new Error('RATE_LIMITED')
      }
    })
    await conn.token()
    await conn.token()
    expect(requests).toBe(1)
    clock.advance(61_000)
    await conn.token()
    expect(requests).toBe(2)
  })

  it('surfaces a send error once the cached token has actually expired', async () => {
    const { conn, calls, clock } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        throw new Error('LEASE_DENIED')
      }
    })
    // Past the snapshot's own expiry: the degradation window is over, the failure is real.
    clock.advance(31 * 60 * 1000)
    await expect(conn.createActivity(SESSION, { type: 'response', body: 'x' })).rejects.toBeInstanceOf(
      LinearTokenUnavailableError
    )
    expect(calls).toHaveLength(0)
  })

  it('adopts a re-pushed spec snapshot without a broker round-trip', async () => {
    let requests = 0
    const { conn, calls } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        return { accessToken: 'renewed', expiresAt: FRESH_EXPIRY }
      }
    })
    conn.applySnapshot({
      workspaceId: WORKSPACE,
      accessToken: 'pushed',
      accessTokenExpiresAt: new Date(START + 23 * 60 * 60 * 1000).toISOString()
    })
    await conn.createActivity(SESSION, { type: 'thought', body: 'hi' })
    expect(requests).toBe(0)
    expect(calls[0]?.authorization).toBe('Bearer pushed')
  })

  it('warms the token on start and clears the refresh timer on stop', async () => {
    const { conn, timers } = harness()
    await conn.start()
    expect(timers).toHaveLength(1)
    await conn.stop()
    expect(timers[0]?.cleared).toBe(true)
  })
})

describe('linear send queue (§5.3)', () => {
  it('spaces activity posts by the minimum interval, in FIFO order', async () => {
    const clock = fakeClock()
    const calls: RecordedCall[] = []
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const request = init as { headers: Record<string, string>; body: string }
      const parsed = JSON.parse(request.body) as { query: string; variables: Record<string, unknown> }
      calls.push({
        url: String(url),
        authorization: request.headers.authorization ?? '',
        query: parsed.query,
        variables: parsed.variables,
        at: clock.now()
      })
      return jsonResponse({ data: { agentActivityCreate: { success: true, agentActivity: { id: 'act' } } } })
    }) as unknown as typeof fetch
    const conn = new LinearConnection({
      group: group(),
      requestToken: async () => ({ accessToken: 'renewed', expiresAt: FRESH_EXPIRY }),
      fetchImpl,
      endpoint: 'https://linear.example.test/graphql',
      sendIntervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: () => undefined,
      clearTimer: () => {}
    })
    await Promise.all([
      conn.createActivity(SESSION, { type: 'thought', body: 'first' }),
      conn.createActivity(SESSION, { type: 'thought', body: 'second' }),
      conn.createActivity(SESSION, { type: 'thought', body: 'third' })
    ])
    const bodies = calls.map((c) => (c.variables.input as { content: { body: string } }).content.body)
    expect(bodies).toEqual(['first', 'second', 'third'])
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1_000)
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(1_000)
  })
})

describe('linear graphql client (§9.4)', () => {
  it('posts agentActivityCreate with the session, content and ephemeral flag', async () => {
    const { conn, calls } = harness({
      respond: () => jsonResponse({ data: { agentActivityCreate: { success: true, agentActivity: { id: 'act-1' } } } })
    })
    const id = await conn.createActivity(SESSION, { type: 'thought', body: 'reading' }, { ephemeral: true })
    expect(id).toBe('act-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://linear.example.test/graphql')
    expect(calls[0]!.authorization).toBe('Bearer snapshot-token')
    expect(calls[0]!.query).toContain('agentActivityCreate')
    expect(calls[0]!.variables).toEqual({
      input: { agentSessionId: SESSION, content: { type: 'thought', body: 'reading' }, ephemeral: true }
    })
  })

  it('carries an action activity’s action/parameter/result verbatim', async () => {
    const { conn, calls } = harness()
    await conn.createActivity(SESSION, { type: 'action', action: 'Read', parameter: 'src/app.ts', result: 'ok' })
    expect(calls[0]!.variables).toEqual({
      input: {
        agentSessionId: SESSION,
        content: { type: 'action', action: 'Read', parameter: 'src/app.ts', result: 'ok' }
      }
    })
  })

  it('omits ephemeral and signal when the caller names neither', async () => {
    const { conn, calls } = harness()
    await conn.createActivity(SESSION, { type: 'response', body: 'done' })
    expect(calls[0]!.variables).toEqual({
      input: { agentSessionId: SESSION, content: { type: 'response', body: 'done' } }
    })
  })

  it('sends the plan as a full-array replace on agentSessionUpdate', async () => {
    const { conn, calls } = harness()
    await conn.updateSessionPlan(SESSION, [
      { content: 'read the issue', status: 'completed' },
      { content: 'write the patch', status: 'inProgress' }
    ])
    expect(calls[0]!.query).toContain('agentSessionUpdate')
    expect(calls[0]!.variables).toEqual({
      id: SESSION,
      input: {
        plan: [
          { content: 'read the issue', status: 'completed' },
          { content: 'write the patch', status: 'inProgress' }
        ]
      }
    })
  })

  it('publishes external URLs additively, and sends nothing for an empty set', async () => {
    const { conn, calls } = harness()
    await conn.addSessionExternalUrls(SESSION, [{ label: 'PR #123', url: 'https://code.example.test/pr/123' }])
    await conn.addSessionExternalUrls(SESSION, [])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.variables).toEqual({
      id: SESSION,
      input: { addedExternalUrls: [{ label: 'PR #123', url: 'https://code.example.test/pr/123' }] }
    })
  })

  it('propagates a GraphQL errors[] refusal, with the extensions code', async () => {
    const { conn } = harness({
      respond: () =>
        jsonResponse({ errors: [{ message: 'Entity not found', extensions: { code: 'ENTITY_NOT_FOUND' } }] })
    })
    const err = await conn.createActivity(SESSION, { type: 'thought', body: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearApiError)
    expect((err as LinearApiError).code).toBe('ENTITY_NOT_FOUND')
    expect((err as LinearApiError).retryable).toBe(false)
    expect((err as LinearApiError).message).toContain('Entity not found')
  })

  it('marks a rate-limit refusal and a 5xx retryable, and a 400 not', async () => {
    const limited = harness({ respond: () => jsonResponse({ errors: [{ extensions: { code: 'RATELIMITED' } }] }) })
    const server = harness({ respond: () => jsonResponse({}, 503) })
    const client = harness({ respond: () => jsonResponse({}, 400) })
    for (const [h, retryable] of [
      [limited, true],
      [server, true],
      [client, false]
    ] as const) {
      const err = await h.conn.createActivity(SESSION, { type: 'thought', body: 'x' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LinearApiError)
      expect((err as LinearApiError).retryable).toBe(retryable)
    }
  })

  it('treats a transport throw as retryable rather than leaking the raw error', async () => {
    const conn = new LinearConnection({
      group: group(),
      requestToken: async () => ({ accessToken: 'renewed', expiresAt: FRESH_EXPIRY }),
      fetchImpl: (async () => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
      sendIntervalMs: 0,
      now: () => START,
      setTimer: () => undefined,
      clearTimer: () => {}
    })
    const err = await conn.createActivity(SESSION, { type: 'thought', body: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearApiError)
    expect((err as LinearApiError).retryable).toBe(true)
  })
})

describe('linear read port (§9.4 — what Linear affords)', () => {
  it('resolves the issue behind a channel id into identifier · title', async () => {
    const { conn, calls } = harness({
      respond: () => jsonResponse({ data: { issue: { id: ISSUE, identifier: 'TEAM-123', title: 'Fix the parser' } } })
    })
    expect(await conn.getChannelInfo(ISSUE)).toEqual({ id: ISSUE, name: 'TEAM-123 · Fix the parser', isIm: false })
    expect(calls[0]!.query).toContain('issue(')
    expect(calls[0]!.variables).toEqual({ id: ISSUE })
  })

  it('answers the bare id for a session with no issue, and for a failed lookup', async () => {
    const missing = harness({ respond: () => jsonResponse({ data: { issue: null } }) })
    expect(await missing.conn.getChannelInfo(SESSION)).toEqual({ id: SESSION, isIm: false })
    const failing = harness({ respond: () => jsonResponse({}, 500) })
    expect(await failing.conn.getChannelInfo(SESSION)).toEqual({ id: SESSION, isIm: false })
  })

  it('resolves a Linear user, preferring the display name and keeping the full name', async () => {
    const { conn, calls } = harness({
      respond: () =>
        jsonResponse({
          data: {
            user: {
              id: 'user-9',
              name: 'Ada Lovelace',
              displayName: 'ada',
              avatarUrl: 'https://cdn.example.test/a.png'
            }
          }
        })
    })
    expect(await conn.getUserProfile('user-9')).toEqual({
      id: 'user-9',
      name: 'ada',
      realName: 'Ada Lovelace',
      avatarUrl: 'https://cdn.example.test/a.png',
      isBot: false
    })
    expect(calls[0]!.query).toContain('user(')
  })

  it('reports the app’s own user id as a bot — the self-echo guard', async () => {
    const { conn } = harness({ respond: () => jsonResponse({ data: { user: { id: 'app-user-1', name: 'Agent' } } }) })
    expect((await conn.getUserProfile('app-user-1')).isBot).toBe(true)
    expect(conn.isSelfAuthored('app-user-1')).toBe(true)
    expect(conn.isSelfAuthored('user-9')).toBe(false)
    expect(conn.isSelfAuthored(undefined)).toBe(false)
  })

  it('never claims self-authorship when the spec carried no app user id', () => {
    const { conn } = harness({ config: linearConfig({ appUserId: undefined }) })
    expect(conn.botUserId).toBeUndefined()
    expect(conn.isSelfAuthored('anything')).toBe(false)
  })

  it('answers empty for the ports Linear has no surface for, without a request', async () => {
    const { conn, calls } = harness()
    expect(await conn.listMembers(ISSUE)).toEqual([])
    expect(await conn.listChannels()).toEqual([])
    expect(await conn.downloadFile('anything')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('declares no bot-channel enumeration, no leave affordance and no thread history', () => {
    const proto = LinearConnection.prototype as unknown as Record<string, unknown>
    for (const member of ['listBotChannels', 'leaveChannel', 'leaveSpace', 'getThreadReplies', 'getChannelHistory']) {
      expect(typeof proto[member], member).toBe('undefined')
    }
  })

  it('exposes the workspace as its durable tenant and no permalink base', () => {
    const { conn } = harness()
    expect(conn.workspaceId()).toBe(WORKSPACE)
    expect(conn.workspaceUrl).toBe('')
    expect(RENEW_MARGIN_MS).toBe(2 * 60 * 60 * 1000)
  })
})
