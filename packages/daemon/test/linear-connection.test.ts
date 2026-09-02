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
/** The channel coordinate (§4.5) — a team of the connected workspace. */
const TEAM = 'e8d3c2bb-7f60-4b4c-9dae-2f3a4b5c0004'
const OTHER_TEAM = 'f9e4d3cc-8071-4c5d-aebf-3a4b5c6d0005'
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
  signal?: AbortSignal
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  }) as unknown as Response

/** Let the timer callback's async chain settle before asserting on what it re-armed. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
  // Deterministic idempotency keys: a real UUID would make every request assertion unpinnable.
  let minted = 0
  const activityIds: string[] = []
  const clock = fakeClock()
  const calls: RecordedCall[] = []
  const timers: { fn: () => void; delay: number; cleared: boolean }[] = []
  const warnings: string[] = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string; signal?: AbortSignal }
    const parsed = JSON.parse(request.body) as { query: string; variables: Record<string, unknown> }
    const call: RecordedCall = {
      url: String(url),
      authorization: request.headers.authorization ?? '',
      query: parsed.query,
      variables: parsed.variables,
      at: clock.now(),
      ...(request.signal ? { signal: request.signal } : {})
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
    newActivityId: () => {
      minted += 1
      const id = `activity-${minted}`
      activityIds.push(id)
      return id
    },
    setTimer: (fn, delay) => {
      const handle = { fn, delay, cleared: false }
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
  /** The one timer currently armed — `scheduleRefresh` clears the old before setting the new. */
  const armed = (): { fn: () => void; delay: number; cleared: boolean }[] => timers.filter((t) => !t.cleared)
  /** Run the armed timer's callback and let its async chain settle. */
  const fireTimer = async (): Promise<void> => {
    const timer = armed().at(-1)
    if (!timer) throw new Error('no timer is armed')
    timer.cleared = true
    timer.fn()
    await settle()
  }
  return { conn, calls, clock, timers, warnings, armed, fireTimer, activityIds }
}

/** The idempotency key the connection put on one recorded `agentActivityCreate`. */
const sentActivityId = (call: RecordedCall): unknown => (call.variables.input as { id?: unknown }).id

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
    const { conn, timers, armed } = harness()
    await conn.start()
    expect(timers).toHaveLength(1)
    await conn.stop()
    expect(armed()).toHaveLength(0)
  })

  it('re-arms the refresh timer with backoff after a failed renewal', async () => {
    // Without the re-arm a transient refusal ends the refresh chain: the integration then
    // discovers recovery only on a live send, inside Linear's ≤10 s ack budget.
    let requests = 0
    const { conn, clock, armed, fireTimer } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        throw new Error('RATE_LIMITED')
      }
    })
    await conn.start()
    expect(requests).toBe(1)
    expect(armed()).toHaveLength(1)
    expect(armed()[0]!.delay).toBeGreaterThanOrEqual(60_000)

    // Firing inside the backoff must not re-drive the broker — but must leave a timer armed.
    await fireTimer()
    expect(requests).toBe(1)
    expect(armed()).toHaveLength(1)

    // …and once the backoff has elapsed, the timer alone recovers the credential.
    clock.advance(61_000)
    await fireTimer()
    expect(requests).toBe(2)
    expect(armed()).toHaveLength(1)
  })

  it('stops re-arming once the connection is stopped', async () => {
    const { conn, armed } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        throw new Error('LEASE_DENIED')
      }
    })
    await conn.start()
    const pending = armed()[0]!
    await conn.stop()
    expect(armed()).toHaveLength(0)
    // A callback already in flight when stop() lands must not resurrect the chain.
    pending.fn()
    await settle()
    expect(armed()).toHaveLength(0)
  })

  it('holds the renewal backoff even once the cached token expired, so sends do not hammer the broker', async () => {
    // The bug this pins: the backoff used to be conditional on the cached token still being
    // valid, so an expired token meant every single send re-drove a `linearcred` REQ.
    let requests = 0
    const { conn, calls, clock } = harness({
      config: linearConfig({ accessTokenExpiresAt: NEAR_EXPIRY }),
      requestToken: async () => {
        requests += 1
        throw new Error('LEASE_DENIED')
      }
    })
    clock.advance(31 * 60 * 1000)
    for (let i = 0; i < 4; i += 1) {
      await expect(conn.createActivity(SESSION, { type: 'thought', body: `x${i}` })).rejects.toBeInstanceOf(
        LinearTokenUnavailableError
      )
    }
    expect(requests).toBe(1)
    expect(calls).toHaveLength(0)

    clock.advance(61_000)
    await expect(conn.createActivity(SESSION, { type: 'thought', body: 'after' })).rejects.toBeInstanceOf(
      LinearTokenUnavailableError
    )
    expect(requests).toBe(2)
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
      input: {
        id: 'activity-1',
        agentSessionId: SESSION,
        content: { type: 'thought', body: 'reading' },
        ephemeral: true
      }
    })
  })

  it('carries an action activity’s action/parameter/result verbatim', async () => {
    const { conn, calls } = harness()
    await conn.createActivity(SESSION, { type: 'action', action: 'Read', parameter: 'src/app.ts', result: 'ok' })
    expect(calls[0]!.variables).toEqual({
      input: {
        id: 'activity-1',
        agentSessionId: SESSION,
        content: { type: 'action', action: 'Read', parameter: 'src/app.ts', result: 'ok' }
      }
    })
  })

  it('omits ephemeral and signal when the caller names neither', async () => {
    const { conn, calls } = harness()
    await conn.createActivity(SESSION, { type: 'response', body: 'done' })
    expect(calls[0]!.variables).toEqual({
      input: { id: 'activity-1', agentSessionId: SESSION, content: { type: 'response', body: 'done' } }
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

  it('marks a rate-limit refusal and a 5xx retryable, and a bare 400 terminal', async () => {
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

  it('reads the GraphQL code on an HTTP 400, so a rate limit retries and then succeeds', async () => {
    // Linear reports a rate limit as HTTP 400 carrying `RATELIMITED` in the body. Classifying
    // on the status alone called that terminal and dropped the write — a final `response`
    // would simply never land.
    let attempts = 0
    const { conn, calls } = harness({
      respond: () => {
        attempts += 1
        return attempts === 1
          ? jsonResponse({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 400)
          : jsonResponse({ data: { agentActivityCreate: { success: true, agentActivity: { id: 'act-2' } } } })
      }
    })
    expect(await conn.createActivity(SESSION, { type: 'response', body: 'final' })).toBe('act-2')
    expect(calls).toHaveLength(2)
  })

  it('waits the provider’s Retry-After before the retry rather than its own backoff', async () => {
    let attempts = 0
    const { conn, calls } = harness({
      respond: () => {
        attempts += 1
        return attempts === 1
          ? jsonResponse({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400, { 'retry-after': '2' })
          : jsonResponse({ data: { agentActivityCreate: { agentActivity: { id: 'act-3' } } } })
      }
    })
    await conn.createActivity(SESSION, { type: 'response', body: 'final' })
    expect(calls[1]!.at - calls[0]!.at).toBe(2_000)
  })

  it('gives up after the bounded attempts and surfaces the rate-limit error', async () => {
    const { conn, calls } = harness({
      respond: () => jsonResponse({ errors: [{ message: 'Rate limit', extensions: { code: 'RATELIMITED' } }] }, 400)
    })
    const err = await conn.createActivity(SESSION, { type: 'response', body: 'final' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearApiError)
    expect((err as LinearApiError).code).toBe('RATELIMITED')
    expect(calls).toHaveLength(3)
  })

  it('reuses one caller-supplied id across a retry, so an append-only create cannot double-post', async () => {
    // The retry made this reachable: activities are append-only, and a 5xx after the write
    // committed is indeterminate — without our own id the retry appends a second row.
    let attempts = 0
    const { conn, calls } = harness({
      respond: () => {
        attempts += 1
        return attempts === 1
          ? jsonResponse({}, 500)
          : jsonResponse({ data: { agentActivityCreate: { agentActivity: { id: 'activity-1' } } } })
      }
    })
    expect(await conn.createActivity(SESSION, { type: 'response', body: 'final' })).toBe('activity-1')
    expect(calls).toHaveLength(2)
    expect(sentActivityId(calls[0]!)).toBe('activity-1')
    expect(sentActivityId(calls[1]!)).toBe('activity-1')
  })

  it('treats a duplicate-id refusal on a retry as the earlier attempt having committed', async () => {
    let attempts = 0
    const { conn, calls } = harness({
      respond: () => {
        attempts += 1
        return attempts === 1
          ? jsonResponse({}, 503)
          : jsonResponse({ errors: [{ message: 'A record with that id already exists' }] }, 400)
      }
    })
    expect(await conn.createActivity(SESSION, { type: 'response', body: 'final' })).toBe('activity-1')
    expect(calls).toHaveLength(2)
  })

  it('surfaces a duplicate-id refusal on the FIRST attempt — that is a reused key, not a retry', async () => {
    const { conn, calls } = harness({
      respond: () => jsonResponse({ errors: [{ message: 'A record with that id already exists' }] }, 400)
    })
    await expect(conn.createActivity(SESSION, { type: 'response', body: 'final' })).rejects.toBeInstanceOf(
      LinearApiError
    )
    expect(calls).toHaveLength(1)
  })

  it('surfaces an ambiguous refusal on a retry rather than inventing a success', async () => {
    let attempts = 0
    const { conn } = harness({
      respond: () => {
        attempts += 1
        return attempts === 1 ? jsonResponse({}, 500) : jsonResponse({ errors: [{ message: 'Invalid input' }] }, 400)
      }
    })
    const err = await conn.createActivity(SESSION, { type: 'response', body: 'final' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearApiError)
    expect((err as LinearApiError).message).toContain('Invalid input')
  })

  it('gives every logical activity its own id', async () => {
    const { conn, calls, activityIds } = harness()
    await conn.createActivity(SESSION, { type: 'thought', body: 'one' })
    await conn.createActivity(SESSION, { type: 'thought', body: 'two' })
    await conn.createActivity(SESSION, { type: 'response', body: 'three' })
    const sent = calls.map(sentActivityId)
    expect(sent).toEqual(['activity-1', 'activity-2', 'activity-3'])
    expect(new Set(sent).size).toBe(3)
    expect(activityIds).toEqual(['activity-1', 'activity-2', 'activity-3'])
  })

  it('mints a real UUID when no factory is injected', async () => {
    const sent: { input?: { id?: unknown } }[] = []
    const conn = new LinearConnection({
      group: group(),
      requestToken: async () => ({ accessToken: 'renewed', expiresAt: FRESH_EXPIRY }),
      fetchImpl: (async (_url: unknown, init: unknown) => {
        const request = init as { body: string }
        sent.push((JSON.parse(request.body) as { variables: { input?: { id?: unknown } } }).variables)
        return jsonResponse({ data: { agentActivityCreate: { agentActivity: {} } } })
      }) as unknown as typeof fetch,
      sendIntervalMs: 0,
      now: () => START,
      sleep: async () => {},
      setTimer: () => undefined,
      clearTimer: () => {}
    })
    await conn.createActivity(SESSION, { type: 'thought', body: 'x' })
    expect(sent[0]?.input?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('sends no idempotency key on agentSessionUpdate, whose replaces converge on their own', async () => {
    const { conn, calls } = harness()
    await conn.updateSessionPlan(SESSION, [{ content: 'step', status: 'pending' }])
    expect(calls[0]!.variables).not.toHaveProperty('input.id')
    expect(calls[0]!.variables).toEqual({ id: SESSION, input: { plan: [{ content: 'step', status: 'pending' }] } })
  })

  it('sends the issue resource as one attachmentCreate, keyed by Linear on the URL', async () => {
    const { conn, calls } = harness()
    const input = {
      issueId: 'issue-uuid',
      url: 'https://console.example.test/sessions/s1',
      title: 'AgentConnect session'
    }
    await conn.createIssueAttachment(input)
    expect(calls[0]!.query).toContain('attachmentCreate(')
    expect(calls[0]!.variables).toEqual({ input })
  })

  it('never retries a terminal refusal', async () => {
    const { conn, calls } = harness({
      respond: () =>
        jsonResponse({ errors: [{ message: 'Entity not found', extensions: { code: 'ENTITY_NOT_FOUND' } }] })
    })
    await conn.createActivity(SESSION, { type: 'thought', body: 'x' }).catch(() => undefined)
    expect(calls).toHaveLength(1)
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
      // Injected so the bounded retry's backoff costs the suite no real time.
      sleep: async () => {},
      setTimer: () => undefined,
      clearTimer: () => {}
    })
    const err = await conn.createActivity(SESSION, { type: 'thought', body: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearApiError)
    expect((err as LinearApiError).retryable).toBe(true)
  })
})

describe('linear read port (§9.4 — what Linear affords)', () => {
  it('names the channel after the workspace and its TEAM, never after a key or an issue', async () => {
    // The one display slot is shared by every session in the team (§4.5): an issue-derived
    // answer here would relabel all of them with whichever issue was read last. The team KEY
    // is an identifier, so it never reaches the label either.
    const { conn, calls } = harness({
      respond: () => jsonResponse({ data: { team: { id: TEAM, key: 'ENG', name: 'Engineering' } } })
    })
    expect(await conn.getChannelInfo(TEAM)).toEqual({
      id: TEAM,
      name: 'Example Workspace / Engineering',
      isIm: false
    })
    expect(calls[0]!.query).toContain('team(id: $id) { id key name icon color }')
    expect(calls[0]!.variables).toEqual({ id: TEAM })
  })

  it('degrades to the bare team id when Linear refuses the lookup', async () => {
    const { conn } = harness({ respond: () => jsonResponse({ errors: [{ message: 'entity not found' }] }, 400) })
    expect(await conn.getChannelInfo(TEAM)).toEqual({ id: TEAM, isIm: false })
  })

  it('answers the issue-less workspace channel from the spec, with no lookup at all', async () => {
    const { conn, calls } = harness()
    expect(await conn.getChannelInfo(WORKSPACE)).toEqual({ id: WORKSPACE, name: 'Example Workspace', isIm: false })
    const bare = { ...linearConfig() } as Record<string, unknown>
    delete bare.workspaceName
    const unnamed = harness({ config: bare })
    expect(await unnamed.conn.getChannelInfo(WORKSPACE)).toEqual({ id: WORKSPACE, isIm: false })
    expect([...calls, ...unnamed.calls]).toHaveLength(0)
  })

  it('answers the workspace’s team list as its channels, and empty on a refusal', async () => {
    const { conn, calls } = harness({
      respond: () =>
        jsonResponse({
          data: {
            teams: {
              nodes: [
                { id: TEAM, key: 'ENG', name: 'Engineering' },
                { id: OTHER_TEAM, key: 'DOCS', name: 'Docs' },
                // A team the workspace answered without a key still routes under its own id.
                { id: 'team-3' }
              ]
            }
          }
        })
    })
    expect(await conn.listChannels()).toEqual([
      { id: TEAM, name: 'Example Workspace / Engineering', isPrivate: false },
      { id: OTHER_TEAM, name: 'Example Workspace / Docs', isPrivate: false },
      { id: 'team-3', isPrivate: false }
    ])
    expect(calls[0]!.query).toContain('teams(first: 100) { nodes { id key name icon color } }')
    // The report this feeds is a non-authoritative name refresh (§9.2), so a refusal costs a
    // refresh and never throws at the reconcile that asked.
    const refused = harness({ respond: () => jsonResponse({ errors: [{ message: 'no access' }] }, 400) })
    expect(await refused.conn.listChannels()).toEqual([])
  })

  it('carries a team’s own icon and color, dropping either when Linear spells it another way', async () => {
    const { conn } = harness({
      respond: () =>
        jsonResponse({
          data: {
            teams: {
              nodes: [
                { id: TEAM, key: 'ENG', name: 'Engineering', icon: 'Feather', color: '#5E6AD2' },
                // An emoji is an icon too — the console renders it in place of a set member.
                { id: OTHER_TEAM, key: 'DOCS', name: 'Docs', icon: '📚', color: 'rebeccapurple' },
                { id: 'team-3', key: 'OPS', name: 'Ops', icon: 'x'.repeat(65), color: '5E6AD2' }
              ]
            }
          }
        })
    })
    expect(await conn.listChannels()).toEqual([
      { id: TEAM, name: 'Example Workspace / Engineering', icon: 'Feather', color: '#5E6AD2', isPrivate: false },
      // A color the wire row would refuse costs its own field, never the whole report.
      { id: OTHER_TEAM, name: 'Example Workspace / Docs', icon: '📚', isPrivate: false },
      // …and so does an over-long icon; a bare triplet is still a color.
      { id: 'team-3', name: 'Example Workspace / Ops', color: '5E6AD2', isPrivate: false }
    ])
  })

  it('names the channel with the team’s glyph on the single-team read too', async () => {
    const { conn } = harness({
      respond: () =>
        jsonResponse({ data: { team: { id: TEAM, key: 'ENG', name: 'Engineering', icon: '🚀', color: '#5E6AD2' } } })
    })
    expect(await conn.getChannelInfo(TEAM)).toEqual({
      id: TEAM,
      name: 'Example Workspace / Engineering',
      icon: '🚀',
      color: '#5E6AD2',
      isIm: false
    })
  })

  it('bounds both team reads end to end — the caller’s deadline, else one of their own', async () => {
    // A provider that accepts and then stalls may cost a display name, never a caller: the read
    // is signalled all the way down, and the signal covers the token wait as well (§9.4).
    const listing = harness({ respond: () => jsonResponse({ data: { teams: { nodes: [] } } }) })
    await listing.conn.listChannels()
    expect(listing.calls[0]!.signal?.aborted).toBe(false)
    const naming = harness({ respond: () => jsonResponse({ data: { team: null } }) })
    await naming.conn.getChannelInfo(TEAM)
    expect(naming.calls[0]!.signal?.aborted).toBe(false)
    // A caller's own deadline wins, and one already blown answers WITHOUT sending anything —
    // the read gives up on the token wait rather than turning into a live request.
    const passed = new AbortController().signal
    const custom = harness({ respond: () => jsonResponse({ data: { teams: { nodes: [] } } }) })
    await custom.conn.listChannels({ signal: passed })
    expect(custom.calls[0]!.signal).toBe(passed)
    const blown = harness()
    expect(await blown.conn.listChannels({ signal: AbortSignal.abort() })).toEqual([])
    expect(await blown.conn.getChannelInfo(TEAM, { signal: AbortSignal.abort() })).toEqual({
      id: TEAM,
      isIm: false
    })
    expect(blown.calls).toHaveLength(0)
  })

  it('gives up on a stalled endpoint at the deadline instead of hanging its caller', async () => {
    // The failure this exists for: a request the provider ACCEPTS and never answers. The signal
    // reaches `fetch`, so the read ends at its own deadline and degrades like any refusal.
    const conn = new LinearConnection({
      group: group(),
      requestToken: async () => ({ accessToken: 'renewed', expiresAt: FRESH_EXPIRY }),
      fetchImpl: ((_url: unknown, init: unknown) =>
        new Promise((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal }).signal
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })) as unknown as typeof fetch,
      sendIntervalMs: 0,
      now: () => START,
      sleep: async () => {},
      setTimer: () => undefined,
      clearTimer: () => {}
    })
    expect(await conn.listChannels({ signal: AbortSignal.timeout(20) })).toEqual([])
    expect(await conn.getChannelInfo(TEAM, { signal: AbortSignal.timeout(20) })).toEqual({ id: TEAM, isIm: false })
  })

  it('strips the relay’s linear: prefix for the user query and answers under the caller’s key', async () => {
    const { conn, calls } = harness({
      respond: () => jsonResponse({ data: { user: { id: 'user-9', name: 'Ada Lovelace', displayName: 'ada' } } })
    })
    // The display cache is keyed by the id the message carried, so the answer keeps it.
    expect(await conn.getUserProfile('linear:user-9')).toMatchObject({ id: 'linear:user-9', name: 'ada' })
    expect(calls[0]!.variables).toEqual({ id: 'user-9' })
    // The self-echo guard compares bare ids on both sides.
    const self = harness({ respond: () => jsonResponse({ data: { user: { id: 'app-user-1', name: 'Agent' } } }) })
    expect((await self.conn.getUserProfile('linear:app-user-1')).isBot).toBe(true)
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

describe('linear auto-start (§10.2)', () => {
  const ISSUE = 'issue-uuid-1'
  const states = [
    { id: 'st-done', name: 'Done', type: 'completed', position: 4 },
    { id: 'st-review', name: 'In Review', type: 'started', position: 3 },
    { id: 'st-progress', name: 'In Progress', type: 'started', position: 2 },
    { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0 }
  ]
  const issueIn =
    (state: { id: string; name: string; type: string }, nodes = states) =>
    (call: RecordedCall) =>
      call.query.includes('issueUpdate')
        ? jsonResponse({ data: { issueUpdate: { success: true } } })
        : jsonResponse({ data: { issue: { state, team: { states: { nodes } } } } })

  it('moves a backlog issue to the team’s LOWEST-position started state', async () => {
    const { conn, calls } = harness({ respond: issueIn(states[4]!) })
    const result = await conn.startIssue(ISSUE)
    expect(result).toEqual({ outcome: 'moved', from: 'Backlog', state: 'In Progress' })
    expect(calls.map((c) => c.variables)).toEqual([{ id: ISSUE }, { id: ISSUE, input: { stateId: 'st-progress' } }])
    expect(calls[0]!.query).toContain('issue(id: $id)')
    expect(calls[1]!.query).toContain('issueUpdate(id: $id, input: $input)')
  })

  it('moves an unstarted issue too — the delegation is the start of work', async () => {
    const { conn, calls } = harness({ respond: issueIn(states[3]!) })
    expect(await conn.startIssue(ISSUE)).toEqual({ outcome: 'moved', from: 'Todo', state: 'In Progress' })
    expect(calls).toHaveLength(2)
  })

  it('leaves a started, completed or canceled issue exactly where it is', async () => {
    for (const state of [
      { id: 'st-review', name: 'In Review', type: 'started' },
      { id: 'st-done', name: 'Done', type: 'completed' },
      { id: 'st-nope', name: 'Canceled', type: 'canceled' }
    ]) {
      const { conn, calls } = harness({ respond: issueIn(state) })
      expect(await conn.startIssue(ISSUE)).toEqual({ outcome: 'unchanged', state: state.name })
      expect(calls).toHaveLength(1)
    }
  })

  it('skips a triage issue, so an automation delegating out of triage keeps human triage', async () => {
    const { conn, calls } = harness({ respond: issueIn({ id: 'st-triage', name: 'Triage', type: 'triage' }) })
    expect(await conn.startIssue(ISSUE)).toEqual({ outcome: 'skipped', reason: 'issue is in triage' })
    expect(calls).toHaveLength(1)
  })

  it('skips a team with no started state, and an issue it cannot read', async () => {
    const noStarted = harness({ respond: issueIn(states[4]!, [states[0]!, states[3]!]) })
    expect(await noStarted.conn.startIssue(ISSUE)).toEqual({ outcome: 'skipped', reason: 'team has no started state' })
    expect(noStarted.calls).toHaveLength(1)
    const unreadable = harness({ respond: () => jsonResponse({ data: { issue: null } }) })
    expect(await unreadable.conn.startIssue(ISSUE)).toEqual({
      outcome: 'skipped',
      reason: 'issue or its state is unreadable'
    })
  })

  it('surfaces a refused state write as the API error it is', async () => {
    const { conn } = harness({
      respond: (call) =>
        call.query.includes('issueUpdate')
          ? jsonResponse({ errors: [{ message: 'no', extensions: { code: 'FORBIDDEN' } }] })
          : issueIn(states[4]!)(call)
    })
    await expect(conn.startIssue(ISSUE)).rejects.toBeInstanceOf(LinearApiError)
  })
})

describe('the session → issue association (§12)', () => {
  it('answers the issue a delivery said the session sits on, and nothing for a session never seen', () => {
    const { conn } = harness()
    expect(conn.issueOfSession('session-1')).toBeUndefined()
    conn.noteSessionIssue('session-1', 'issue-a')
    conn.noteSessionIssue('session-2', 'issue-b')
    expect(conn.issueOfSession('session-1')).toBe('issue-a')
    expect(conn.issueOfSession('session-2')).toBe('issue-b')
    // A later delivery for the same session wins; the map never holds two issues for one session.
    conn.noteSessionIssue('session-1', 'issue-c')
    expect(conn.issueOfSession('session-1')).toBe('issue-c')
  })
})
