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
import { stableMessageId } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import type { LinearActivityInput } from '../src/platforms/linear/turn-output.js'
import {
  linearDeliveryReceiptId,
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
    workspaceName: 'Example Workspace',
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
   *  exactly its job, so counting it would never reach zero. */
  const pendingRows = async (): Promise<number> =>
    (await store.listInboxBySessionKeyFifo()).filter((row: { completedAt: number | null }) => row.completedAt === null)
      .length
  // `dispatch` resolves (or rejects) when THAT message's turn has fully ended, so holding the
  // promise is a signal that cannot be missed — unlike sampling the durable row, which exists
  // only between admission and teardown and can be inserted and removed between two polls.
  const turns: Promise<unknown>[] = []
  const realDispatch = (daemon as any).dispatch.bind(daemon)
  ;(daemon as any).dispatch = (...args: unknown[]) => {
    const settled = realDispatch(...args)
    // Store a CAUGHT copy: the fake host's turn legitimately fails, and the barrier waits for
    // the turn to be over, not to have succeeded.
    turns.push(Promise.resolve(settled).catch(() => undefined))
    return settled
  }
  /**
   * Wait until everything this delivery can do has happened — no polling anywhere.
   *
   * Two halves, because the turn and the acknowledgement are separate lifetimes:
   *
   *  - the TURN: `runLoop` awaits `removeInbox(entry)` BEFORE settling the entry's own promise
   *    on both the success and the failure path, so awaiting that promise is strictly stronger
   *    than watching the row disappear — once it resolves the dispatch row is already gone.
   *  - the ACKNOWLEDGEMENT: fire-and-forget, so no promise covers it. It is STARTED
   *    synchronously inside `onAdmission`, hence before the turn promise settles, and it then
   *    performs a bounded number of store operations before the feed write. This store
   *    serializes every operation through one mutex, so round-trips issued here queue BEHIND
   *    the ones the acknowledgement already enqueued — draining it instead of racing it.
   */
  const turnSettled = async (): Promise<void> => {
    await Promise.all(turns)
    // The acknowledgement path is receipt CAS → output-mode read → postActivity's own read;
    // one extra round-trip beyond those three leaves no room for it to land later.
    for (let i = 0; i < 4; i += 1) await pendingRows()
    expect(await pendingRows()).toBe(0)
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
    sessionKey: `${WORKSPACE}/${SESSION}`,
    msgId,
    payload: {
      msgId,
      traceId: msgId,
      source: 'user' as const,
      platform: 'linear' as const,
      channel: WORKSPACE,
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

describe('§4.5 the workspace as the one observed conversation', () => {
  it('reports it at reconcile, before any delivery has landed', async () => {
    // The CP dispatch row — and the channel-scoped route the compile makes of it — has to exist
    // BEFORE the first delegation, so the report cannot wait for a session to reach history.
    const { daemon } = await boot()
    const snapshot = (daemon as any).channelSnapshots.get(INTEGRATION)
    expect(snapshot).toMatchObject({ authoritative: false })
    expect(snapshot.channels).toEqual([{ id: WORKSPACE, name: 'Example Workspace', isPrivate: false, kind: 'channel' }])
    await daemon.stop()
  })

  it('labels the workspace id so the console never shows a bare organization UUID', async () => {
    const { daemon, store } = await boot()
    expect((await store.getDisplayNames([WORKSPACE])).get(WORKSPACE)).toBe('Example Workspace')
    await daemon.stop()
  })

  it('re-reports on a reconcile that only rebinds, without duplicating the row', async () => {
    const { daemon } = await boot()
    await (daemon as any).connections.reconcileLinearConnections()
    expect((daemon as any).channelSnapshots.get(INTEGRATION).channels).toHaveLength(1)
    await daemon.stop()
  })
})

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
    // Each redelivery is answered from the receipt inside `prepare`, which `im()` awaits in
    // full — there is no fire-and-forget work left, so no settle window is needed here.
    await im(daemon, delivery())
    await im(daemon, delivery())
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
    expect(dispatch).not.toHaveBeenCalled()
    expect(posted.filter((entry) => entry.activity.type === 'thought')).toHaveLength(1)
    await daemon.stop()
  })

  it('refuses the WHOLE delivery for a copy that loses the receipt CAS, not just its ack', async () => {
    // The window two concurrent deliveries race through: both pass `prepare` because neither
    // sees a receipt yet, both reach admission, and one loses the transaction's CAS. The loser
    // must run nothing — suppressing only its acknowledgement would still start a second turn.
    const { daemon, posted, store, turnSettled } = await boot()
    const normalized = { ...delivery().payload, transportScope: transportScope(daemon) }
    // Stand in for the peer that got there first, and blind the pre-dispatch fast path the way
    // a genuinely concurrent arrival would be blinded.
    await store.appendInbox({
      id: linearDeliveryReceiptId(stableMessageId(normalized)),
      sessionKey: sessionKey('linear', WORKSPACE, SESSION, AGENT, transportScope(daemon)),
      agentId: AGENT,
      msg: '{}',
      completedAt: 1,
      loopGuardCounted: 1,
      enqueuedAt: '1'
    })
    vi.spyOn(store, 'hasInbox').mockResolvedValue(false)
    const handle = vi.fn()
    ;(daemon as any).sessions.handle = handle

    expect(await im(daemon, delivery())).toEqual({ msgId: `linear:${SESSION}:created`, accepted: true })
    await turnSettled()
    expect(posted).toEqual([])
    expect(handle).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('refuses the delivery rather than acking when the durable admission cannot be written', async () => {
    const { daemon, posted, store, turnSettled } = await boot()
    // §10.1's dedup fence IS the durable admission, so a swallowed write would let a
    // redelivery double-post an append-only feed. Refusing is the correct trade — the
    // provider's retry ladder is what recovers it.
    vi.spyOn(store, 'appendInboxWithReceipt').mockRejectedValue(new Error('disk is gone'))
    expect(await im(daemon, delivery())).toEqual({
      msgId: `linear:${SESSION}:created`,
      accepted: false,
      reason: 'durability'
    })
    await turnSettled()
    expect(posted).toEqual([])
    await daemon.stop()
  })

  it('leaves NOTHING behind when the durable admission fails, so no turn replays later', async () => {
    // The crash window: the admission row and its permanent receipt are one transaction, so a
    // failure leaves neither. A surviving row would replay at startup with no receipt, and the
    // provider's next redelivery would then run the very same turn a second time.
    const { daemon, posted, store, turnSettled } = await boot()
    const handle = vi.fn()
    ;(daemon as any).sessions.handle = handle
    vi.spyOn(store, 'appendInboxWithReceipt').mockRejectedValue(new Error('disk is gone'))

    expect(await im(daemon, delivery())).toEqual({
      msgId: `linear:${SESSION}:created`,
      accepted: false,
      reason: 'durability'
    })
    await turnSettled()
    expect(posted).toEqual([])
    expect(handle).not.toHaveBeenCalled()
    expect(await store.listInboxBySessionKeyFifo()).toEqual([])
    await daemon.stop()
  })

  it('collapses CONCURRENT deliveries of the same msgId onto ONE acknowledgement', async () => {
    const { daemon, posted, turnSettled } = await boot()
    await Promise.all([im(daemon, delivery()), im(daemon, delivery()), im(daemon, delivery())])
    await turnSettled()
    expect(acks(posted).length).toBe(1)
    await daemon.stop()
  })

  it('marks the queued variant when the session is already working', async () => {
    const { daemon, posted } = await boot()
    const key = sessionKey('linear', WORKSPACE, SESSION, AGENT, transportScope(daemon))
    ;(daemon as any).inflight.add(key)
    await im(daemon, delivery())
    await vi.waitFor(() => expect(acks(posted).length).toBe(1))
    expect(acks(posted)[0]!.activity.body).toBe('**Review Bot** · queued behind the current task')
    await daemon.stop()
  })

  it('stays silent in `none` mode — no acknowledgement, no activities', async () => {
    const { daemon, posted, turnSettled } = await boot({ outputMode: 'none' })
    await im(daemon, delivery())
    await turnSettled()
    expect(posted).toEqual([])
    await daemon.stop()
  })

  it('records the WORKSPACE name as the session channel name', async () => {
    // The channel is the workspace, so the issue lives on `threadUrl` and the §8 header instead.
    const { daemon, store } = await boot()
    await im(daemon, delivery())
    expect((await store.getDisplayNames([WORKSPACE])).get(WORKSPACE)).toBe('Example Workspace')
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
  it("captures its egress port at turn start, from the turn's own integration", async () => {
    const { daemon, posted } = await boot()
    const surface = (daemon as any).turnSurfaces.for('linear')
    const turn = {
      plan: { thread: SESSION, platform: 'linear', agentId: AGENT, sessionKey: 'k' },
      turnState: surface.initialTurnState({ egress: (daemon as any).lnConnByIntegration.get(INTEGRATION) })
    }
    await surface.apply(turn, { kind: 'activity', type: 'response', body: 'done' })
    expect(responses(posted).map((p) => p.activity.body)).toEqual(['done'])
    expect(responses(posted)[0]!.sessionId).toBe(SESSION)
    await daemon.stop()
  })

  it('keeps posting through the captured port after the binding is dropped mid-turn', async () => {
    // Reconciliation unbinds an integration BEFORE the prune pass stops its client. A turn
    // that re-resolved the map per action would go silent right there and leave the Linear
    // session active forever; the captured port is what still settles it.
    const { daemon, posted } = await boot()
    const surface = (daemon as any).turnSurfaces.for('linear')
    const turn = {
      plan: { thread: SESSION, platform: 'linear', agentId: AGENT, sessionKey: 'k' },
      turnState: surface.initialTurnState({ egress: (daemon as any).lnConnByIntegration.get(INTEGRATION) })
    }
    ;(daemon as any).lnConnByIntegration.delete(INTEGRATION)
    await surface.apply(turn, { kind: 'activity', type: 'error', body: 'boom' })
    expect(posted.map((p) => p.activity.body)).toEqual(['boom'])
    await daemon.stop()
  })

  it('no-ops when no Linear connection is bound to the turn', async () => {
    const { daemon, posted } = await boot()
    const surface = (daemon as any).turnSurfaces.for('linear')
    const turn = {
      plan: { thread: SESSION, platform: 'linear', agentId: AGENT, sessionKey: 'k' },
      turnState: surface.initialTurnState({})
    }
    await surface.apply(turn, { kind: 'activity', type: 'response', body: 'done' })
    expect(posted).toEqual([])
    await daemon.stop()
  })
})

describe('§4.5 the issue-less surface', () => {
  // The channel stays the workspace; only the BAG loses its issue metadata.
  const issueless = () => delivery({ threadUrl: undefined }, { issueIdentifier: undefined, issueTitle: undefined })

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

  it('keys the session on the workspace + AgentSession UUID and admits it durably before answering', async () => {
    const { daemon, posted, store } = await boot()
    ;(daemon as any).dispatch = vi.fn(async () => null)
    await im(daemon, issueless())
    expect(posted[0]!.inboxAdmitted).toBe(true)
    const key = sessionKey('linear', WORKSPACE, SESSION, AGENT, transportScope(daemon))
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
    sessionKey: `${WORKSPACE}/${SESSION}`,
    msgId: 'linear:activity-stop',
    botId: BOT,
    integrationId: INTEGRATION,
    userId: 'user-1',
    payload
  })
  const action = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayPlatformAction(msg)

  it('interrupts the addressed session and settles it with a `response`', async () => {
    const { daemon, posted, store } = await boot()
    const key = sessionKey('linear', WORKSPACE, SESSION, AGENT, transportScope(daemon))
    await store.upsertSession({
      key,
      sessionId: 'sess-1',
      agentId: AGENT,
      platform: 'linear',
      channel: WORKSPACE,
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

describe('§7.5 the turn holds its egress transport', () => {
  it('makes reconciliation wait for the settling activity before stopping the client', async () => {
    // Removing the integration mid-turn must not cut the turn's only reply surface. Without a
    // lease the prune pass stops the client while the model is still running, and the settling
    // activity — the one that ends the Linear session — is simply lost.
    let releasePrompt!: () => void
    let reachedPrompt!: () => void
    const blocked = new Promise<void>((release) => (releasePrompt = release))
    const promptReached = new Promise<void>((resolve) => (reachedPrompt = resolve))
    const { daemon, posted } = await boot({
      host: () => ({
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-1'),
        prompt: vi.fn(async () => {
          reachedPrompt()
          await blocked
          return 'end_turn'
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      })
    })
    // The pooled client and the bound one must be the SAME object: the lease is keyed by the
    // connection the turn holds, and the prune pass waits on the connection it is stopping.
    const pool = (daemon as any).connections.linearPool
    for (const live of pool.all()) pool.remove(live)
    let stoppedAfter = -1
    const bound = (daemon as any).lnConnByIntegration.get(INTEGRATION)
    const conn = {
      integrationId: bound.integrationId,
      botUserId: bound.botUserId,
      workspaceId: bound.workspaceId,
      postActivity: bound.postActivity,
      updateSession: bound.updateSession,
      stop: async () => {
        stoppedAfter = posted.length
      }
    }
    ;(daemon as any).lnConnByIntegration.set(INTEGRATION, conn)
    pool.add(conn)

    await im(daemon, delivery())
    await promptReached

    // The roster no longer references this integration, so reconciliation wants it gone.
    ;(daemon as any).agents.get(AGENT).integrations = []
    let reconciled = false
    const closing = (daemon as any).connections.closeUnusedPlatformConnections().then(() => {
      reconciled = true
    })

    // Give the prune pass every chance to run ahead of the turn.
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    expect(reconciled).toBe(false)
    expect(stoppedAfter).toBe(-1)

    releasePrompt()
    await closing
    expect(reconciled).toBe(true)
    // The client was stopped only after the turn had posted its settling activity through it.
    expect(posted.length).toBeGreaterThan(0)
    expect(stoppedAfter).toBe(posted.length)
    await daemon.stop()
  })
})

describe('§7.5 the leased transport and the emitting port are one object', () => {
  it('keeps emitting through the LEASED connection when reconcile rebinds mid-open', async () => {
    // The transport used to be resolved twice — once to take the lease, once when the output
    // surface seeded its turn state — with session opening in between. A rebind landing in
    // that window left the lease on the old client and the output on the new one: the leased
    // client could be stopped while still being written to, and the new one written to with
    // no lease at all. Rebinding through the registry seam is what that window looked like.
    const { daemon, posted, turnSettled } = await boot()
    const leased = (daemon as any).lnConnByIntegration.get(INTEGRATION)
    const rebound: Posted[] = []
    const replacement = {
      integrationId: INTEGRATION,
      botUserId: 'app-user-1',
      workspaceId: () => WORKSPACE,
      async postActivity(sessionId: string, activity: LinearActivityInput) {
        rebound.push({ sessionId, activity, inboxAdmitted: true })
      },
      async updateSession() {}
    }
    let lookups = 0
    ;(daemon as any).platformTurnEgress.set('linear', () => {
      lookups += 1
      // Anything after the FIRST lookup sees the rebound client, which is exactly what a
      // reconcile between the two old lookups would have produced.
      if (lookups > 1) return replacement
      ;(daemon as any).lnConnByIntegration.set(INTEGRATION, replacement)
      return leased
    })

    await im(daemon, delivery())
    // Settle the WHOLE turn: the turn-state seeding that used to re-resolve happens after
    // session opening, so asserting on the acknowledgement alone would pass either way.
    await turnSettled()

    // One resolution for the whole turn, and every activity went to the connection it leased.
    expect(lookups).toBe(1)
    expect(posted.length).toBeGreaterThan(0)
    expect(rebound).toEqual([])
    await daemon.stop()
  })
})
