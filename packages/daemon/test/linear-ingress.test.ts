/**
 * Linear's daemon-side ingress composition (linear-integration.md §9.4): the ≤10 s
 * acknowledgement and its strict dedup-before-ack ordering (§10.1), the §4.5 issue-less
 * surface that answers without starting a turn, and the §6.3 stop decoder.
 *
 * Platform-neutral: no real network, no real timers on the paths asserted, and the only
 * clock the assertions depend on is the daemon's own injectable one.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { sessionKey } from '../src/store/local-store.js'
import { initialLinearTurnState, type LinearActivityInput } from '../src/platforms/linear/turn-output.js'
import {
  linearFailureBody,
  LINEAR_STOP_RESPONSE_BODY,
  LINEAR_UNSUPPORTED_SURFACE_BODY,
  MAX_FAILURE_BODY
} from '../src/platforms/linear/message-strategy.js'

const AGENT = 'review-bot'
const INTEGRATION = 'int-linear'
const BOT = '8f0a1c62-9a0f-4c6e-8b2b-7d3f5a1c0001'
const WORKSPACE = 'a2f2f0d4-0e33-4c4b-9a4b-4f7a0f1f0001'
const SESSION = 'c3f1e0aa-4d2f-4f0a-9b1e-2b6d5c4a0002'
const ISSUE = 'd7c2b1aa-6e5f-4a3b-8c9d-1e2f3a4b0003'
const ISSUE_URL = 'https://linear.app/example/issue/TEAM-123/ship-the-thing'
const FAR_FUTURE = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString()

/** Every activity the daemon posts, in order, plus the inbox state at post time. */
interface Posted {
  sessionId: string
  activity: LinearActivityInput
  inboxAdmitted: boolean
}

function scaffold(outputMode: 'none' | 'low' = 'low', expiresAt: string = FAR_FUTURE): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-linear-ingress-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      displayName: 'Review Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'linear',
          core: { mode: 'shared', bindRules: [{ match: { kind: 'mention' } }] },
          config: {
            workspaceId: WORKSPACE,
            workspaceName: 'Example Workspace',
            appUserId: 'app-user-1',
            accessToken: 'snapshot-token',
            accessTokenExpiresAt: expiresAt
          }
        }
      ],
      output: { mode: outputMode }
    })
  )
  return root
}

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

interface BootOpts {
  outputMode?: 'none' | 'low'
  /** Swap the ACP host to drive a turn failure — a rejecting `prompt` fails WARM (a Pending
   *  exists), a rejecting `newSession` fails COLD (it never does). */
  host?: () => unknown
  expiresAt?: string
}

async function boot(opts: BootOpts = {}) {
  const daemon = new Daemon({
    root: scaffold(opts.outputMode ?? 'low', opts.expiresAt ?? FAR_FUTURE),
    hostFactory: () => (opts.host ? opts.host() : fakeHost()) as any
  })
  await daemon.start()
  // Converge the pool deterministically instead of racing the fire-and-forget boot call,
  // then take the binding over with a recording fake — no GraphQL leaves this test.
  await (daemon as any).connections.reconcileLinearConnections()
  const posted: Posted[] = []
  const store = (daemon as any).store
  const conn = {
    integrationId: INTEGRATION,
    botUserId: 'app-user-1',
    workspaceId: () => WORKSPACE,
    async postActivity(sessionId: string, activity: LinearActivityInput) {
      // The ordering assertion itself: read the durable inbox AT POST TIME, so a row that
      // only lands later cannot make an out-of-order first activity look admitted.
      const rows = await store.listInboxBySessionKeyFifo()
      posted.push({ sessionId, activity, inboxAdmitted: rows.length > 0 })
    },
    async updateSession() {}
  }
  ;(daemon as any).lnConnByIntegration.set(INTEGRATION, conn)
  /** Rows for work still owed. A born-completed receipt is excluded — outliving the turn is
   *  exactly its job, so counting it would never let a settlement barrier resolve. */
  const pendingRows = async (): Promise<number> =>
    (await store.listInboxBySessionKeyFifo()).filter((row: { completedAt: number | null }) => row.completedAt === null)
      .length
  /** Wait until this delivery's turn has been admitted AND has fully settled. The order is
   *  load-bearing: polling for zero alone passes instantly, before the row is ever written. */
  const turnSettled = async (): Promise<void> => {
    await vi.waitFor(async () => expect(await pendingRows()).toBe(1), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await pendingRows()).toBe(0), { timeout: 10_000 })
  }
  return { daemon, posted, store, pendingRows, turnSettled }
}

const transportScope = (daemon: Daemon): string | undefined =>
  (daemon as any).transportScopeForIntegrationIds([INTEGRATION])

function delivery(payloadOver: Record<string, unknown> = {}, extOver: Record<string, unknown> = {}) {
  const msgId = `linear:${SESSION}:created`
  return {
    source: 'im' as const,
    agentId: AGENT,
    botId: BOT,
    integrationId: INTEGRATION,
    sessionKey: `${ISSUE}/${SESSION}`,
    msgId,
    payload: {
      msgId,
      traceId: msgId,
      source: 'user' as const,
      platform: 'linear' as const,
      channel: ISSUE,
      thread: SESSION,
      threadUrl: ISSUE_URL,
      sender: { id: 'linear:user-1', isBot: false, name: 'Dana' },
      text: 'take a look at the failing job',
      mentionedBots: ['app-user-1'],
      isDm: false,
      trigger: 'mention' as const,
      adapterExt: {
        linear: {
          agentSessionId: SESSION,
          issueIdentifier: 'TEAM-123',
          issueTitle: 'Ship the thing',
          ...extOver
        }
      },
      ...payloadOver
    }
  }
}

const acks = (posted: Posted[]) => posted.filter((p) => p.activity.type === 'thought' && p.activity.ephemeral === true)
const responses = (posted: Posted[]) => posted.filter((p) => p.activity.type === 'response')

const im = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayIm(msg)

describe('§10.1 the pre-spawn acknowledgement', () => {
  it('names the acting agent and the issue, after the durable inbox admitted the delivery', async () => {
    const { daemon, posted } = await boot()
    const ack = await im(daemon, delivery())
    expect(ack).toEqual({ msgId: `linear:${SESSION}:created`, accepted: true })
    await vi.waitFor(() => expect(acks(posted).length).toBe(1))
    expect(acks(posted)[0]!.activity.body).toBe('**Review Bot** · reading TEAM-123 …')
    expect(acks(posted)[0]!.sessionId).toBe(SESSION)
    // Dedup FIRST, acknowledgement second — the row is already durable when the feed row is written.
    expect(acks(posted)[0]!.inboxAdmitted).toBe(true)
    await daemon.stop()
  })

  it('collapses a redelivery of the same msgId onto ONE acknowledgement', async () => {
    const { daemon, posted, turnSettled } = await boot()
    await im(daemon, delivery())
    await vi.waitFor(() => expect(acks(posted).length).toBe(1))
    // Redeliver only once the turn has SETTLED. Redelivering while it is still in flight
    // proves nothing: the dispatch row is still there to dedup against, so any ordering
    // works. Linear's ladder is 1 min / 1 h / 6 h, so the settled state is the real one.
    await turnSettled()
    await im(daemon, delivery())
    await im(daemon, delivery())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acks(posted).length).toBe(1)
    await daemon.stop()
  })

  it('runs no second TURN for a redelivery that arrives after the first turn settled', async () => {
    const { daemon, posted, turnSettled } = await boot()
    await im(daemon, delivery())
    await vi.waitFor(() => expect(acks(posted).length).toBe(1))
    await turnSettled()
    // The dispatch row is gone by now — core deletes it at terminal state — so only the
    // durable receipt can absorb this. Without it the whole turn re-runs, not just the ack.
    const dispatch = vi.fn(async () => null)
    ;(daemon as any).dispatch = dispatch
    expect(await im(daemon, delivery())).toEqual({ msgId: `linear:${SESSION}:created`, accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dispatch).not.toHaveBeenCalled()
    expect(posted.filter((entry) => entry.activity.type === 'thought')).toHaveLength(1)
    await daemon.stop()
  })

  it('refuses the delivery rather than acking when the durable row cannot be written', async () => {
    const { daemon, posted, store } = await boot()
    // §10.1's dedup fence IS the durable row, so a swallowed write would let a redelivery
    // double-post an append-only feed. Refusing is the correct trade — the relay retries.
    vi.spyOn(store, 'appendInbox').mockRejectedValue(new Error('disk is gone'))
    await im(daemon, delivery())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posted).toEqual([])
    await daemon.stop()
  })

  it('collapses CONCURRENT deliveries of the same msgId onto ONE acknowledgement', async () => {
    const { daemon, posted } = await boot()
    await Promise.all([im(daemon, delivery()), im(daemon, delivery()), im(daemon, delivery())])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acks(posted).length).toBe(1)
    await daemon.stop()
  })

  it('marks the queued variant when the session is already working', async () => {
    const { daemon, posted } = await boot()
    const key = sessionKey('linear', ISSUE, SESSION, AGENT, transportScope(daemon))
    ;(daemon as any).inflight.add(key)
    await im(daemon, delivery())
    await vi.waitFor(() => expect(acks(posted).length).toBe(1))
    expect(acks(posted)[0]!.activity.body).toBe('**Review Bot** · queued behind the current task')
    await daemon.stop()
  })

  it('stays silent in `none` mode — no acknowledgement, no activities', async () => {
    const { daemon, posted } = await boot({ outputMode: 'none' })
    await im(daemon, delivery())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posted).toEqual([])
    await daemon.stop()
  })

  it('records the issue name as the session channel name', async () => {
    const { daemon, store } = await boot()
    await im(daemon, delivery())
    expect((await store.getDisplayNames([ISSUE])).get(ISSUE)).toBe('TEAM-123 · Ship the thing')
    await daemon.stop()
  })

  it('rewrites the dispatched text into the §8 prompt', async () => {
    const { daemon } = await boot()
    const dispatched: { text: string; headless?: boolean }[] = []
    ;(daemon as any).dispatch = vi.fn(async (_a: string, msg: any) => {
      dispatched.push(msg)
      return null
    })
    await im(daemon, delivery())
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.text.startsWith('Linear TEAM-123 "Ship the thing" — delegated by Dana')).toBe(true)
    expect(dispatched[0]!.headless).toBe(false)
    await daemon.stop()
  })
})

describe('§5 the Layer-2 surface', () => {
  it("resolves its egress port from the turn's own integration binding", async () => {
    const { daemon, posted } = await boot()
    const surface = (daemon as any).turnSurfaces.for('linear')
    const turn = {
      entry: { integrationId: INTEGRATION },
      plan: { thread: SESSION, platform: 'linear', agentId: AGENT, sessionKey: 'k' },
      turnState: initialLinearTurnState()
    }
    await surface.apply(turn, { kind: 'activity', type: 'response', body: 'done' })
    expect(responses(posted).map((p) => p.activity.body)).toEqual(['done'])
    expect(responses(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })

  it('no-ops when no Linear connection is bound to the turn', async () => {
    const { daemon, posted } = await boot()
    const surface = (daemon as any).turnSurfaces.for('linear')
    const turn = {
      entry: { integrationId: 'int-unbound' },
      plan: { thread: SESSION, platform: 'linear', agentId: AGENT, sessionKey: 'k' },
      turnState: initialLinearTurnState()
    }
    await surface.apply(turn, { kind: 'activity', type: 'response', body: 'done' })
    expect(posted).toEqual([])
    await daemon.stop()
  })
})

describe('§4.5 the issue-less surface', () => {
  const issueless = () =>
    delivery({ channel: SESSION, threadUrl: undefined }, { issueIdentifier: undefined, issueTitle: undefined })

  it('answers once and starts NO turn', async () => {
    const { daemon, posted } = await boot()
    const dispatch = vi.fn(async () => null)
    ;(daemon as any).dispatch = dispatch
    const ack = await im(daemon, issueless())
    expect(ack).toEqual({ msgId: `linear:${SESSION}:created`, accepted: true })
    expect(dispatch).not.toHaveBeenCalled()
    expect(responses(posted).map((p) => p.activity.body)).toEqual([LINEAR_UNSUPPORTED_SURFACE_BODY])
    expect(responses(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })

  it('keys the session on the AgentSession UUID and admits it durably before answering', async () => {
    const { daemon, posted, store } = await boot()
    ;(daemon as any).dispatch = vi.fn(async () => null)
    await im(daemon, issueless())
    expect(posted[0]!.inboxAdmitted).toBe(true)
    const key = sessionKey('linear', SESSION, SESSION, AGENT, transportScope(daemon))
    const rows = await store.listInboxBySessionKeyFifo()
    expect(rows.map((row: { sessionKey: string }) => row.sessionKey)).toEqual([key])
    await daemon.stop()
  })

  it('answers a redelivery exactly once', async () => {
    const { daemon, posted } = await boot()
    ;(daemon as any).dispatch = vi.fn(async () => null)
    await im(daemon, issueless())
    await im(daemon, issueless())
    expect(responses(posted)).toHaveLength(1)
    await daemon.stop()
  })
})

describe('§6.3 the stop decoder', () => {
  const stop = (payload: unknown) => ({
    source: 'platform_action' as const,
    platformId: 'linear',
    agentId: AGENT,
    sessionKey: `${ISSUE}/${SESSION}`,
    msgId: 'linear:activity-stop',
    botId: BOT,
    integrationId: INTEGRATION,
    userId: 'user-1',
    payload
  })
  const action = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayPlatformAction(msg)

  it('interrupts the addressed session and settles it with a `response`', async () => {
    const { daemon, posted, store } = await boot()
    const key = sessionKey('linear', ISSUE, SESSION, AGENT, transportScope(daemon))
    await store.upsertSession({
      key,
      sessionId: 'sess-1',
      agentId: AGENT,
      platform: 'linear',
      channel: ISSUE,
      thread: SESSION,
      transportScope: transportScope(daemon),
      acpSessionId: 'acp-1',
      state: 'active',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const interrupt = vi.fn(async () => {})
    ;(daemon as any).interruptTurn = interrupt

    expect(await action(daemon, stop({ kind: 'stop', agentSessionId: SESSION }))).toEqual({
      msgId: 'linear:activity-stop',
      accepted: true
    })
    expect(interrupt.mock.calls[0]?.slice(0, 4)).toEqual([AGENT, key, 'stop', 'acp-1'])
    expect(responses(posted).map((p) => p.activity.body)).toEqual([LINEAR_STOP_RESPONSE_BODY])
    await daemon.stop()
  })

  it('still settles the Linear session when this daemon holds no session for it', async () => {
    const { daemon, posted } = await boot()
    const interrupt = vi.fn(async () => {})
    ;(daemon as any).interruptTurn = interrupt
    expect((await action(daemon, stop({ kind: 'stop', agentSessionId: SESSION }))).accepted).toBe(true)
    expect(interrupt).not.toHaveBeenCalled()
    expect(responses(posted).map((p) => p.activity.body)).toEqual([LINEAR_STOP_RESPONSE_BODY])
    await daemon.stop()
  })

  it('answers an undecodable payload with unsupported_action instead of a turn', async () => {
    const { daemon, posted } = await boot()
    expect(await action(daemon, stop({ kind: 'launch-the-missiles' }))).toEqual({
      msgId: 'linear:activity-stop',
      accepted: false,
      reason: 'unsupported_action'
    })
    expect(posted).toEqual([])
    await daemon.stop()
  })

  it('is registered at all — the payload does not fall through to unsupported_action', async () => {
    const { daemon } = await boot()
    expect((daemon as any).platformActionDecoders.has('linear')).toBe(true)
    await daemon.stop()
  })
})

describe('§5.1 turn failure settles the Linear session', () => {
  const errors = (posted: Posted[]) => posted.filter((p) => p.activity.type === 'error')

  it('posts the settling `error` when the turn fails WARM (a Pending exists)', async () => {
    const { daemon, posted } = await boot({
      host: () => ({
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-1'),
        prompt: vi.fn(async () => {
          throw new Error('provider quota exhausted')
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      })
    })
    await im(daemon, delivery())
    // Without the Linear arm this enqueues a Slack-shaped `post`, which `applyLinearAction`
    // has no arm for — the session would stay `active` forever with nothing in the feed.
    await vi.waitFor(() => expect(errors(posted).length).toBe(1), { timeout: 10_000 })
    expect(errors(posted)[0]!.activity.body).toContain('provider quota exhausted')
    expect(errors(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })

  it('posts a bounded `error` when the turn fails COLD, before any Pending exists', async () => {
    const { daemon, posted } = await boot({
      host: () => ({
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => {
          throw new Error('acp handshake never completed')
        }),
        prompt: vi.fn(async () => 'end_turn'),
        cancel: vi.fn(),
        stop: vi.fn()
      })
    })
    await im(daemon, delivery())
    // A cold failure has no converger to settle through and no reply connection of its own,
    // so only the registered failure sink can reach the feed at all.
    await vi.waitFor(() => expect(errors(posted).length).toBe(1), { timeout: 10_000 })
    expect(errors(posted)[0]!.activity.body).toContain('acp handshake never completed')
    expect(errors(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })

  it('bounds a runaway failure body rather than posting the whole thing', async () => {
    expect(linearFailureBody('x'.repeat(MAX_FAILURE_BODY * 3))).toHaveLength(MAX_FAILURE_BODY + 1)
    expect(linearFailureBody('  ')).toBe('the turn failed')
  })
})

describe('§7.4 in-conversation commands', () => {
  it('resolves a Linear connection for the command seat, which the reply path excludes', async () => {
    const { daemon } = await boot()
    // The turn REPLY path deliberately excludes Linear (it has no free-text surface); the
    // COMMAND seat must not, or the registered chrome surface could never be reached.
    expect((daemon as any).replyConnFor(AGENT, INTEGRATION)).toBeUndefined()
    expect((daemon as any).commandConnFor(AGENT, INTEGRATION)).toBe(
      (daemon as any).lnConnByIntegration.get(INTEGRATION)
    )
    await daemon.stop()
  })

  it('answers `/status` on the activity feed instead of consuming it silently', async () => {
    const { daemon, posted } = await boot()
    const dispatch = vi.fn(async () => null)
    ;(daemon as any).dispatch = dispatch
    await im(daemon, delivery({ text: '/status' }))
    await vi.waitFor(() => expect(responses(posted).length).toBe(1), { timeout: 10_000 })
    // A command is not a prompt: it must not reach the agent as one.
    expect(dispatch).not.toHaveBeenCalled()
    expect(responses(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })
})

describe('§4.4 the brokered token', () => {
  it('resolves the control-plane client at CALL time, not at connection construction', async () => {
    // Reconcile runs before the CP socket connects on an ordinary startup, so a client
    // captured at construction would be `undefined` for the connection's whole life.
    const nearExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    const { daemon } = await boot({ expiresAt: nearExpiry })
    const conn = [...(daemon as any).connections.linearPool.all()][0] as {
      token(): Promise<string>
      applySnapshot(config: Record<string, unknown>): void
    }
    expect(conn).toBeDefined()
    // The CP arrives only now — after the connection was built and its warm-up already failed.
    const requestLinearCred = vi.fn(async () => ({ accessToken: 'brokered', expiresAt: FAR_FUTURE }))
    ;(daemon as any).cpClient = { requestLinearCred, stop: vi.fn() }
    // Clear the renewal backoff the failed warm-up armed, without leaving the margin.
    conn.applySnapshot({
      workspaceId: WORKSPACE,
      accessToken: 'snapshot-token',
      accessTokenExpiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString()
    })
    expect(await conn.token()).toBe('brokered')
    expect(requestLinearCred).toHaveBeenCalledWith({ integrationId: INTEGRATION })
    await daemon.stop()
  })
})
