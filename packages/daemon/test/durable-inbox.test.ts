import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { LocalStore, sessionKey, type InboxRow } from '../src/store/local-store.js'
import { statePath } from '../src/paths.js'
import { Daemon } from '../src/daemon.js'
import { stableMessageId } from '../src/messages/normalized.js'
import type { WebchatOutput, WebchatDone } from '@agentconnect.md/protocol'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT, waitBudget } from './wait-support.js'

/**
 * §6.9 #353 durable inbox: an admitted-but-queued message is persisted to the node:sqlite
 * local store BEFORE the admission ACK and replayed FIFO-by-sessionKey on startup, so a hard
 * kill / agent move never loses a message the caller was already told delivered:true. These
 * cover the store methods, write-before-ACK (incl. queue-full = no accepted row), remove-on-
 * completion, startup replay + FIFO order, replay idempotency, unknown-agent skip, and the
 * webchat non-persistence decision.
 */

// ── store-level unit tests ──────────────────────────────────────────────────
async function store(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-inbox-')), 'local.sqlite'))
}

const row = (id: string, key: string, enqueuedAt: string, agentId = 'bot-a'): InboxRow => ({
  id,
  sessionKey: key,
  agentId,
  msg: JSON.stringify({ msgId: id }),
  integrationId: 'int-a',
  callMeta: null,
  isQueueCmd: null,
  enqueuedAt
})

describe('LocalStore inbox', () => {
  it('appends, lists FIFO-by-sessionKey, and removes', async () => {
    const s = await store()
    const kA = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const kB = sessionKey('slack', 'C1', 'T2', 'bot-a')
    // Interleaved insert order; listing must group by sessionKey then order by enqueuedAt.
    await s.appendInbox(row('a2', kA, '200'))
    await s.appendInbox(row('b1', kB, '150'))
    await s.appendInbox(row('a1', kA, '100'))
    const listed = (await s.listInboxBySessionKeyFifo()).map((r) => r.id)
    expect(listed).toEqual(['a1', 'a2', 'b1'])

    await s.removeInbox('a1')
    expect((await s.listInboxBySessionKeyFifo()).map((r) => r.id)).toEqual(['a2', 'b1'])
    await s.close()
  })

  it('commits an admission row and its delivery receipt together, or neither', async () => {
    // The receipt outlives the turn and is what a late redelivery is recognized by; the
    // ordinary row is deleted at settlement. Written separately, a crash between them leaves
    // a row that replays with no receipt, and the next redelivery runs the turn again.
    const s = await store()
    const k = sessionKey('linear', 'issue-1', 'session-1', 'bot-a')
    const admission = row('deliver-1', k, '100')
    const receipt = { ...admission, id: 'served\u001fdeliver-1', completedAt: 1 }

    expect(await s.appendInboxWithReceipt(admission, receipt)).toEqual({ admitted: true })
    expect((await s.listInboxBySessionKeyFifo()).map((r) => r.id).sort()).toEqual([
      'deliver-1',
      'served\u001fdeliver-1'
    ])

    // A redelivery loses the CAS on the receipt, so it admits NOTHING — not even quietly, and
    // in particular it does not re-create the admission row a settled turn already removed.
    await s.removeInbox('deliver-1')
    expect(await s.appendInboxWithReceipt(admission, receipt)).toEqual({ admitted: false })
    expect((await s.listInboxBySessionKeyFifo()).map((r) => r.id)).toEqual(['served\u001fdeliver-1'])
    await s.close()
  })

  it('rolls the receipt back when the admission row cannot be written', async () => {
    // The crash window, forced: the receipt inserts and the admission row then fails. Both
    // must vanish — a surviving receipt would swallow every future redelivery of a message
    // this daemon never actually admitted.
    const s = await store()
    const k = sessionKey('linear', 'issue-1', 'session-2', 'bot-a')
    const receipt = { ...row('deliver-2', k, '100'), id: 'served\u001fdeliver-2', completedAt: 1 }
    const unwritable = { ...row('deliver-2', k, '100'), msg: undefined as unknown as string }

    await expect(s.appendInboxWithReceipt(unwritable, receipt)).rejects.toThrow()
    expect(await s.listInboxBySessionKeyFifo()).toEqual([])
    // And because nothing was recorded, the retry is a FIRST admission rather than a duplicate.
    expect(await s.appendInboxWithReceipt(row('deliver-2', k, '100'), receipt)).toEqual({ admitted: true })
    await s.close()
  })

  it('append preserves the first delivery payload while durably advancing its loop marker', async () => {
    const s = await store()
    const k = sessionKey('slack', 'C1', 'T1', 'bot-a')
    expect(await s.appendInbox(row('dup', k, '100'))).toBe(true)
    expect(await s.appendInbox({ ...row('dup', k, '999'), loopGuardCounted: 1 })).toBe(false)
    const rows = await s.listInboxBySessionKeyFifo()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.enqueuedAt).toBe('100')
    expect(rows[0]!.loopGuardCounted).toBe(1)
    await s.close()
  })

  it('atomically charges and marks a migrated inbox delivery', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    await s.appendInbox(row('legacy-count', key, '100'))
    expect(
      await s.recordLoopGuardTurnForInbox('legacy-count', 'slack:C1:dm', 100, true, {
        windowMs: 60_000,
        maxTotal: 60,
        maxAutomatic: 8
      })
    ).toMatchObject({ allowed: true, automaticCount: 1 })
    expect((await s.listInboxBySessionKeyFifo())[0]!.loopGuardCounted).toBe(1)
    expect(await s.getLoopGuard('slack:C1:dm')).toMatchObject({ automaticCount: 1 })
    await s.close()
  })

  it('retains a redacted terminal hook receipt for restart-safe redelivery dedup', async () => {
    const s = await store()
    const k = sessionKey('hook', 'hook-1', 'delivery-1', 'bot-a')
    expect(
      await s.appendInbox({
        ...row('hook-1:delivery-1', k, '100'),
        msg: JSON.stringify({ text: 'untrusted webhook body' }),
        hookContext: JSON.stringify({ hookId: 'hook-1', deliveryKey: 'delivery-1' })
      })
    ).toBe(true)
    const report = JSON.stringify({ hookId: 'hook-1', status: 'success' })
    expect(await s.completeHookInbox('hook-1:delivery-1', report, 123)).toBe('completed')
    expect(await s.completeHookInbox('hook-1:delivery-1', '{"status":"failed"}', 999)).toBe('already-terminal')
    expect(await s.completeHookInbox('missing', report, 123)).toBe('missing')

    const receipt = (await s.listInboxBySessionKeyFifo())[0]!
    expect(receipt).toMatchObject({ id: 'hook-1:delivery-1', msg: '{}', terminalReport: report, completedAt: 123 })
    expect(receipt.hookContext).toBeNull()
    expect(await s.hasInbox('hook-1:delivery-1')).toBe(true)
    expect(await s.appendInbox(row('hook-1:delivery-1', k, '999'))).toBe(false)
    expect(await s.acknowledgeHookInbox('hook-1:delivery-1')).toBe(true)
    expect((await s.listInboxBySessionKeyFifo())[0]).toMatchObject({
      id: 'hook-1:delivery-1',
      terminalReport: null,
      completedAt: 123
    })
    expect(await s.hasInbox('hook-1:delivery-1')).toBe(true)
    await s.close()
  })

  it('atomically persists a coalesced hook leader and terminalizes its follower', async () => {
    const s = await store()
    const key = sessionKey('hook', 'acme/repo', '42', 'bot-a')
    expect(await s.appendInbox({ ...row('leader', key, '100'), hookContext: '{"batch":["first"]}' })).toBe(true)
    expect(await s.appendInbox({ ...row('follower', key, '200'), hookContext: '{"batch":["second"]}' })).toBe(true)

    expect(
      await s.coalesceHookInbox({
        leaderId: 'leader',
        leaderMsg: '{"text":"first and second"}',
        leaderHookContext: '{"batch":["first","second"]}',
        followerId: 'follower',
        followerTerminalReport: '{"status":"success","reason":"coalesced_review_batch"}',
        completedAt: 123
      })
    ).toBe(true)
    const rows = await s.listInboxBySessionKeyFifo()
    expect(rows.find((entry) => entry.id === 'leader')).toMatchObject({
      msg: '{"text":"first and second"}',
      hookContext: '{"batch":["first","second"]}',
      completedAt: null
    })
    expect(rows.find((entry) => entry.id === 'follower')).toMatchObject({
      msg: '{}',
      hookContext: null,
      terminalReport: '{"status":"success","reason":"coalesced_review_batch"}',
      completedAt: 123
    })

    expect(
      await s.coalesceHookInbox({
        leaderId: 'leader',
        leaderMsg: '{"text":"must roll back"}',
        leaderHookContext: '{"batch":["wrong"]}',
        followerId: 'missing',
        followerTerminalReport: '{}',
        completedAt: 999
      })
    ).toBe(false)
    expect((await s.listInboxBySessionKeyFifo()).find((entry) => entry.id === 'leader')?.msg).toBe(
      '{"text":"first and second"}'
    )
    await s.close()
  })

  it('capacity-prunes only CP-acknowledged receipts, never pending reports', async () => {
    const s = await store()
    const k = sessionKey('hook', 'hook-1', 'delivery', 'bot-a')
    for (let i = 1; i <= 3; i++) {
      const id = `hook-1:delivery-${i}`
      expect(await s.appendInbox({ ...row(id, k, String(i)), hookContext: '{}' })).toBe(true)
      expect(await s.completeHookInbox(id, JSON.stringify({ hookId: 'hook-1', deliveryKey: String(i) }), i)).toBe(
        'completed'
      )
    }

    expect(await s.acknowledgeHookInbox('hook-1:delivery-1', { maxAcknowledgedReceipts: 1 })).toBe(true)
    expect(await s.acknowledgeHookInbox('hook-1:delivery-2', { maxAcknowledgedReceipts: 1 })).toBe(true)
    const remaining = await s.listInboxBySessionKeyFifo()
    expect(remaining.map((receipt) => receipt.id).sort()).toEqual(['hook-1:delivery-2', 'hook-1:delivery-3'])
    expect(remaining.find((receipt) => receipt.id.endsWith('-3'))?.terminalReport).not.toBeNull()
    await s.close()
  })

  // ── shared pool outbox (#1035) ────────────────────────────────────────────
  // Every member of a daemon pool reads and writes ONE data-plane store, so the
  // hook terminal-report outbox is install-wide. Ownership, not presence, decides
  // who may emit a row: the CP accepts a completion only from the daemon its
  // dispatch named, and answers every other member a permanent CONFLICT.
  const LEASE_MS = 2 * 60 * 1_000

  async function poolMember(database: DatabaseSync, ownerId: string): Promise<LocalStore> {
    return await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(database),
      shared: true,
      ownerId,
      orgForAgent: () => 'org-1'
    })
  }

  async function pooledReport(
    s: LocalStore,
    id: string,
    agentId: string,
    ownerDaemonId: string,
    at: number
  ): Promise<void> {
    const key = sessionKey('hook', 'hook-1', id, agentId)
    expect(await s.appendInbox({ ...row(id, key, String(at), agentId), hookContext: '{}' })).toBe(true)
    expect(await s.completeHookInbox(id, JSON.stringify({ id }), at, ownerDaemonId)).toBe('completed')
  }

  it("offers a pool member only the reports it owns, never a live peer's", async () => {
    const database = new DatabaseSync(':memory:')
    const a = await poolMember(database, 'store-a')
    const b = await poolMember(database, 'store-b')
    await pooledReport(a, 'from-a', 'agent-a', 'daemon-a', 1_000)
    await pooledReport(b, 'from-b', 'agent-b', 'daemon-b', 1_000)

    const ids = async (s: LocalStore, ownerId: string, agentIds: string[]) =>
      (await s.listHookTerminalReports(1_500, ownerId, agentIds)).map((entry) => entry.id)
    expect(await ids(a, 'daemon-a', ['agent-a'])).toEqual(['from-a'])
    // B serves both agents and still may not touch A's row: A's claim is live.
    expect(await ids(b, 'daemon-b', ['agent-a', 'agent-b'])).toEqual(['from-b'])
    expect(await b.claimHookTerminalReport('from-a', 'daemon-b', 1_500)).toBe(false)
    // An owner drains its own row wherever the agent is placed now.
    expect(await ids(a, 'daemon-a', [])).toEqual(['from-a'])
    await a.close()
  })

  it('lets the member that serves the agent take over after the owner claim lapses', async () => {
    const database = new DatabaseSync(':memory:')
    const a = await poolMember(database, 'store-a')
    const b = await poolMember(database, 'store-b')
    await pooledReport(a, 'from-a', 'agent-a', 'daemon-a', 1_000)
    const lapsed = 1_000 + LEASE_MS + 1

    // Still not B's to take while B does not serve the agent.
    expect(await b.listHookTerminalReports(lapsed, 'daemon-b', ['agent-b'])).toEqual([])
    expect((await b.listHookTerminalReports(lapsed, 'daemon-b', ['agent-a'])).map((entry) => entry.id)).toEqual([
      'from-a'
    ])
    expect(await b.claimHookTerminalReport('from-a', 'daemon-b', lapsed)).toBe(true)
    // The takeover is exclusive: the dead owner's id no longer holds the row.
    expect(await a.listHookTerminalReports(lapsed, 'daemon-a', [])).toEqual([])
    expect(await a.claimHookTerminalReport('from-a', 'daemon-a', lapsed)).toBe(false)
    await a.close()
  })

  it('keeps a peer report body out of reach of every member but its owner', async () => {
    const database = new DatabaseSync(':memory:')
    const a = await poolMember(database, 'store-a')
    const b = await poolMember(database, 'store-b')
    await pooledReport(a, 'from-a', 'agent-a', 'daemon-a', 1_000)
    const lapsed = 1_000 + LEASE_MS + 1
    expect(await b.claimHookTerminalReport('from-a', 'daemon-b', lapsed)).toBe(true)

    // The CP rejects B as the reporter — B returns the row instead of dead-lettering it.
    expect(await b.releaseHookTerminalReport('from-a', 'daemon-a', lapsed)).toBe(true)
    expect(await b.acknowledgeHookInbox('from-a', { ownerId: 'daemon-b' })).toBe(false)
    const retained = await a.listHookTerminalReports(lapsed, 'daemon-a', [])
    expect(retained.map((entry) => entry.id)).toEqual(['from-a'])
    expect(retained[0]!.terminalReport).toBe('{"id":"from-a"}')
    // Its owner still releases it on a real ACK.
    expect(await a.acknowledgeHookInbox('from-a', { ownerId: 'daemon-a' })).toBe(true)
    await a.close()
  })

  it('leaves a local store single-owner: every report drains and ACKs unfenced', async () => {
    const s = await store()
    await pooledReport(s, 'local-1', 'bot-a', 'daemon-a', 1)
    await pooledReport(s, 'local-2', 'bot-b', 'daemon-b', 2)
    expect((await s.listHookTerminalReports(Number.MAX_SAFE_INTEGER)).map((entry) => entry.id)).toEqual([
      'local-1',
      'local-2'
    ])
    expect(await s.claimHookTerminalReport('local-2', undefined, 3)).toBe(true)
    expect(await s.releaseHookTerminalReport('local-2', 'daemon-b', 3)).toBe(false)
    expect(await s.acknowledgeHookInbox('local-2')).toBe(true)
    await s.close()
  })

  it('agent lifecycle purge preserves live hook owners and unacknowledged reports', async () => {
    const s = await store()
    const key = sessionKey('hook', 'hook-1', 'shared', 'bot-a')
    expect(await s.appendInbox(row('ordinary', key, '1'))).toBe(true)
    expect(await s.appendInbox({ ...row('hook-live', key, '2'), hookContext: '{"hookId":"hook-1"}' })).toBe(true)

    expect(await s.appendInbox({ ...row('hook-pending', key, '3'), hookContext: '{}' })).toBe(true)
    expect(await s.completeHookInbox('hook-pending', '{"status":"failed"}', 3)).toBe('completed')

    expect(await s.appendInbox({ ...row('hook-acked', key, '4'), hookContext: '{}' })).toBe(true)
    expect(await s.completeHookInbox('hook-acked', '{"status":"success"}', 4)).toBe('completed')
    expect(await s.acknowledgeHookInbox('hook-acked')).toBe(true)

    expect((await s.removeInboxByAgentId('bot-a')).sort()).toEqual(['hook-acked', 'ordinary'])
    expect((await s.listInboxBySessionKeyFifo()).map((entry) => entry.id).sort()).toEqual(['hook-live', 'hook-pending'])
    expect(
      (await s.listInboxBySessionKeyFifo()).find((entry) => entry.id === 'hook-pending')?.terminalReport
    ).not.toBeNull()
    await s.close()
  })
})

// ── daemon integration (drive dispatch directly with a gated host) ───────────
function scaffold(agentIds: string[] = ['bot-a']): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-dinbox-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // This suite pins one-persisted-row-per-turn inbox replay; queue coalescing
      // under the refresh fence is covered by turn-output-workflow.
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agentIds) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

function writePause(root: string, pause: boolean, agentId = 'bot-a'): void {
  const path = join(root, 'agents', agentId, 'agent.json')
  const agent = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...agent, pause }))
}

function gatedHost(sessionId = 'acp-1') {
  const releases: Array<() => void> = []
  const started: string[] = []
  let calls = 0
  const failAt = new Set<number>()
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => sessionId),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      const n = ++calls
      started.push(blocks.map((b) => b.text ?? '').join('|'))
      await new Promise<void>((r) => releases.push(r))
      if (failAt.has(n)) throw new Error(`boom-${n}`)
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return {
    host,
    started,
    releaseOne: () => releases.shift()?.(),
    releaseAll: () => {
      while (releases.length) releases.shift()!()
    },
    failNext: (n: number) => failAt.add(n),
    blockedCount: () => releases.length
  }
}

function coldReplayHost() {
  let releaseCold!: () => void
  const cold = new Promise<void>((resolve) => (releaseCold = resolve))
  const releases: Array<() => void> = []
  const started: string[] = []
  let sessions = 0
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => {
      const n = ++sessions
      if (n === 1) await cold
      return `acp-${n}`
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      started.push(blocks.map((b) => b.text ?? '').join('|'))
      await new Promise<void>((resolve) => releases.push(resolve))
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return {
    host,
    started,
    releaseCold: () => releaseCold(),
    releasePrompt: () => releases.shift()?.()
  }
}

const msg = (ts: string, text: string, thread = 'T1') => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

const HOOK_AGENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HOOK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function retainedHook(deliveryKey: string) {
  const id = `${HOOK_ID}:${deliveryKey}`
  return {
    row: {
      id,
      sessionKey: sessionKey('slack', 'C1', 'T1', HOOK_AGENT_ID),
      agentId: HOOK_AGENT_ID,
      msg: JSON.stringify({
        ...msg(deliveryKey, 'retained hook'),
        msgId: id,
        traceId: deliveryKey,
        source: 'hook',
        sender: { id: `hook:${HOOK_ID}`, isBot: false },
        trigger: 'hook'
      }),
      integrationId: 'int-a',
      callMeta: null,
      hookContext: JSON.stringify({
        hookId: HOOK_ID,
        agentId: HOOK_AGENT_ID,
        deliveryKey,
        firedAt: new Date(0).toISOString()
      }),
      isQueueCmd: null,
      enqueuedAt: deliveryKey
    } satisfies InboxRow,
    id
  }
}

async function boot(root: string, host: any) {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any })
  await daemon.start()
  return daemon
}

async function inbox(root: string): Promise<InboxRow[]> {
  const s = await LocalStore.open(statePath(root))
  const rows = await s.listInboxBySessionKeyFifo()
  await s.close()
  return rows
}

async function loopGuard(root: string, scope = 'slack:C1:dm') {
  const s = await LocalStore.open(statePath(root))
  const row = await s.getLoopGuard(scope)
  await s.close()
  return row
}

describe('daemon durable inbox', () => {
  it('persists an admitted (non-webchat) message before the ACK; queue-full is NOT persisted', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)
    const key = 'slack:C1:T1:bot-a'

    // Head admitted (runs immediately) → row written before it even starts.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    expect((await inbox(root)).map((r) => r.id)).toEqual(['slack:C1:100'])

    // Fill the queue to the cap (10) — each queued entry persists a row.
    const queued: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++)
      queued.push((daemon as any).dispatch('bot-a', msg(`${200 + i}`, `m${i}`), 'int-a').catch(() => 'rej'))
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(10), WAIT)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(11), WAIT)

    // The 11th overflows the cap → rejected fast, NEVER admitted, NO accepted row written.
    const overflow = (daemon as any).dispatch('bot-a', msg('999', 'overflow'), 'int-a')
    await expect(overflow).rejects.toThrow(/queue_full|queue full/)
    expect((await inbox(root)).some((r) => r.id === 'slack:C1:999')).toBe(false)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(11), WAIT)

    // Drain: each queued turn gates only after the previous settles, so this
    // releases one turn per retry tick — 10 serial turns overflow waitFor's
    // default 1s budget on a loaded CI runner (recurring flake).
    g.releaseAll()
    await p1
    await vi.waitFor(
      async () => {
        g.releaseAll()
        expect((daemon as any).inflight.has(key)).toBe(false)
      },
      waitBudget(10_000, 25)
    )
    await Promise.all(queued)
    await daemon.stop()
  })

  it('removes the inbox row when a turn completes (not replayed next startup)', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(1), WAIT)

    g.releaseOne()
    await expect(p1).resolves.toBe('acp-1')
    // Terminal (success) → row deleted.
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })

  it('namespaces durable message identity per physical bot and deduplicates within one bot', async () => {
    const g = gatedHost()
    g.host.newSession = vi.fn().mockResolvedValueOnce('acp-a').mockResolvedValueOnce('acp-b')
    const root = scaffold()
    const daemon = await boot(root, g.host)
    const botA = { ...msg('100', 'from A'), transportScope: 'slack:scope-a' }
    const botB = { ...msg('100', 'from B'), transportScope: 'slack:scope-b' }

    const pA = (daemon as any).dispatch('bot-a', botA, 'int-a')
    const pB = (daemon as any).dispatch('bot-a', botB, 'int-b')
    await vi.waitFor(() => expect(g.blockedCount()).toBe(2), WAIT)
    expect((daemon as any).evaluationTurnIdFor('bot-a', botA)).not.toBe(
      (daemon as any).evaluationTurnIdFor('bot-a', botB)
    )
    expect((await inbox(root)).map((row) => row.id).sort()).toEqual(
      [stableMessageId(botA), stableMessageId(botB)].sort()
    )

    await expect((daemon as any).dispatch('bot-a', { ...botA }, 'int-a')).resolves.toBeNull()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(2), WAIT)

    g.releaseAll()
    await Promise.all([pA, pB])
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })

  it('a fail-stopped queued rest has its rows removed too', async () => {
    const g = gatedHost()
    g.failNext(1)
    const root = scaffold()
    const daemon = await boot(root, g.host)
    const key = 'slack:C1:T1:bot-a'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(2), WAIT)

    g.releaseOne()
    await expect(p1).rejects.toThrow('boom-1')
    await expect(p2).rejects.toThrow(/fail_stop|not auto-run/)
    // Both the failed head and the fail-stopped queued entry are removed.
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    expect((daemon as any).serialQueue.has(key)).toBe(false)
    await daemon.stop()
  })

  it('startup replay: pre-seeded rows for a sessionKey are re-admitted through the gate in FIFO order', async () => {
    const g = gatedHost()
    const root = scaffold()
    const transportScope = 'slack:scope-a'
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', transportScope)
    const replayMsg = (ts: string, text: string) => ({ ...msg(ts, text), transportScope })
    // Pre-seed the durable inbox out of enqueuedAt order to prove FIFO ordering on replay.
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: 'slack:C1:300',
      sessionKey: key,
      agentId: 'bot-a',
      msg: JSON.stringify(replayMsg('300', 'third')),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '300'
    })
    await s.appendInbox({
      id: 'slack:C1:100',
      sessionKey: key,
      agentId: 'bot-a',
      msg: JSON.stringify(replayMsg('100', 'first')),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.appendInbox({
      id: 'slack:C1:200',
      sessionKey: key,
      agentId: 'bot-a',
      msg: JSON.stringify(replayMsg('200', 'second')),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '200'
    })
    await s.close()

    const daemon = await boot(root, g.host)
    // The head runs immediately; the other two queue behind it — all in FIFO enqueuedAt order.
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    expect(g.started[0]).toContain('first')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)
    // Adopt the legacy raw ids instead of duplicating them under the new scoped identity.
    expect((await inbox(root)).map((row) => row.id)).toEqual(['slack:C1:100', 'slack:C1:200', 'slack:C1:300'])
    // Every migrated row is marked only after its replay admission was charged.
    expect((await inbox(root)).every((row) => row.loopGuardCounted === 1)).toBe(true)

    g.releaseOne()
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('second')
    g.releaseOne()
    await vi.waitFor(() => expect(g.started.length).toBe(3), WAIT)
    expect(g.started[2]).toContain('third')
    g.releaseAll()
    await vi.waitFor(() => expect((daemon as any).inflight.has(key)).toBe(false), WAIT)
    // All replayed rows removed once their turns completed.
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })

  it('startup replay trips on a persisted anonymous empty event, purges it without prompting, and stays open after another restart', async () => {
    const root = scaffold()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const poison = {
      ...msg('100', ''),
      sender: { id: 'unknown', isBot: false }
    }
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: poison.msgId,
      sessionKey: key,
      agentId: 'bot-a',
      msg: JSON.stringify(poison),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()

    const firstHost = gatedHost()
    const first = await boot(root, firstHost.host)
    expect(firstHost.host.prompt).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    expect(await loopGuard(root)).toMatchObject({ reason: 'malformed_platform_event' })
    await first.stop()

    // A daemon restart must not reset the safety latch. Even a fresh, otherwise-valid
    // turn in the same DM is dropped until an explicit !resume resets the guard.
    const secondHost = gatedHost()
    const second = await boot(root, secondHost.host)
    await expect((second as any).dispatch('bot-a', msg('200', 'fresh'), 'int-a')).resolves.toBeNull()
    expect(secondHost.host.prompt).not.toHaveBeenCalled()
    expect(await loopGuard(root)).toMatchObject({ reason: 'malformed_platform_event' })
    await second.stop()
  })

  it('bounds a legacy non-empty platform-echo backlog that predates loop counters', async () => {
    const root = scaffold()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const s = await LocalStore.open(statePath(root))
    for (let n = 1; n <= 9; n++) {
      const echo = {
        ...msg(String(n), `legacy echo ${n}`),
        sender: { id: 'unknown', isBot: false }
      }
      await s.appendInbox({
        id: echo.msgId,
        sessionKey: key,
        agentId: 'bot-a',
        msg: JSON.stringify(echo),
        integrationId: 'int-a',
        callMeta: null,
        isQueueCmd: null,
        enqueuedAt: String(n).padStart(3, '0')
      })
    }
    await s.close()

    const g = gatedHost()
    const daemon = await boot(root, g.host)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    expect(g.host.prompt).not.toHaveBeenCalled()
    expect(await loopGuard(root)).toMatchObject({ reason: 'automatic_turn_burst' })
    await daemon.stop()
  })

  it('counts legacy marker-zero rows even when another owner already created the scope guard', async () => {
    const root = scaffold()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const s = await LocalStore.open(statePath(root))
    const now = Date.now()
    const limits = { windowMs: 60_000, maxTotal: 60, maxAutomatic: 8 }
    for (let n = 0; n < 4; n++) await s.recordLoopGuardTurn('slack:C1:dm', now + n, true, limits)
    for (let n = 1; n <= 5; n++) {
      const echo = {
        ...msg(String(n), `cross-owner echo ${n}`),
        sender: { id: 'unknown', isBot: false }
      }
      await s.appendInbox({
        id: echo.msgId,
        sessionKey: key,
        agentId: 'bot-a',
        msg: JSON.stringify(echo),
        integrationId: 'int-a',
        callMeta: null,
        isQueueCmd: null,
        // Omitted/default 0: retained by a previous owner before the marker existed.
        enqueuedAt: String(n).padStart(3, '0')
      })
    }
    await s.close()

    const g = gatedHost()
    const daemon = await boot(root, g.host)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    expect(g.host.prompt).not.toHaveBeenCalled()
    expect(await loopGuard(root)).toMatchObject({ automaticCount: 9, reason: 'automatic_turn_burst' })
    await daemon.stop()
  })

  it('resumes an unrelated durable replay after a legacy scope trips and its safety drain closes', async () => {
    const root = scaffold()
    const noisyKey = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const healthyKey = sessionKey('slack', 'C2', 'T2', 'bot-a')
    const s = await LocalStore.open(statePath(root))
    for (let n = 1; n <= 9; n++) {
      const echo = {
        ...msg(String(n), `legacy echo ${n}`),
        sender: { id: 'unknown', isBot: false }
      }
      await s.appendInbox({
        id: echo.msgId,
        sessionKey: noisyKey,
        agentId: 'bot-a',
        msg: JSON.stringify(echo),
        integrationId: 'int-a',
        callMeta: null,
        isQueueCmd: null,
        enqueuedAt: String(n).padStart(3, '0')
      })
    }
    const healthy = {
      ...msg('100', 'healthy replay', 'T2'),
      msgId: 'slack:C2:100',
      traceId: '100',
      channel: 'C2'
    }
    await s.appendInbox({
      id: healthy.msgId,
      sessionKey: healthyKey,
      agentId: 'bot-a',
      msg: JSON.stringify(healthy),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()

    const g = coldReplayHost()
    const daemon = await boot(root, g.host)
    await vi.waitFor(() => expect(g.host.newSession).toHaveBeenCalledTimes(1), WAIT)
    // The noisy scope is purged, but the other accepted row stays durable while
    // the host-wide cancel backstop makes new admission temporarily unsafe.
    expect((await inbox(root)).map((row) => row.id)).toEqual([healthy.msgId])
    expect(g.started).toHaveLength(0)

    g.releaseCold()
    await vi.waitFor(() => expect(g.started).toHaveLength(1), WAIT)
    expect(g.started[0]).toContain('healthy replay')
    g.releasePrompt()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)

    await daemon.stop()
  })

  it('does not resurrect a deferred replay that pause purged before a quick unpause', async () => {
    const root = scaffold()
    const s = await LocalStore.open(statePath(root))
    for (let n = 1; n <= 9; n++) {
      const echo = {
        ...msg(String(n), `legacy echo ${n}`),
        sender: { id: 'unknown', isBot: false }
      }
      await s.appendInbox({
        id: echo.msgId,
        sessionKey: sessionKey('slack', 'C1', 'T1', 'bot-a'),
        agentId: 'bot-a',
        msg: JSON.stringify(echo),
        integrationId: 'int-a',
        callMeta: null,
        isQueueCmd: null,
        enqueuedAt: String(n).padStart(3, '0')
      })
    }
    const deferred = {
      ...msg('100', 'must stay purged', 'T2'),
      msgId: 'slack:C2:100',
      traceId: '100',
      channel: 'C2'
    }
    await s.appendInbox({
      id: deferred.msgId,
      sessionKey: sessionKey('slack', 'C2', 'T2', 'bot-a'),
      agentId: 'bot-a',
      msg: JSON.stringify(deferred),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()

    const g = coldReplayHost()
    const daemon = await boot(root, g.host)
    await vi.waitFor(() => expect(g.host.newSession).toHaveBeenCalledTimes(1), WAIT)
    expect((await inbox(root)).map((row) => row.id)).toEqual([deferred.msgId])

    writePause(root, true)
    await daemon.reconcile()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    writePause(root, false)
    await daemon.reconcile()

    g.releaseCold()
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    await vi.waitFor(() => expect((daemon as any).safetyDrainingAgents.size).toBe(0), WAIT)
    expect(g.started).toHaveLength(0)

    const fresh = (daemon as any).dispatch('bot-a', {
      ...deferred,
      msgId: 'slack:C2:200',
      traceId: '200',
      text: 'fresh after unpause'
    })
    await vi.waitFor(() => expect(g.started).toHaveLength(1), WAIT)
    g.releasePrompt()
    await expect(fresh).resolves.toBe('acp-2')
    await daemon.stop()
  })

  it('startup with a paused agent purges its inbox so unpause plus another restart cannot resurrect old work', async () => {
    const root = scaffold()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: 'slack:C1:100',
      sessionKey: key,
      agentId: 'bot-a',
      msg: JSON.stringify(msg('100', 'must never run')),
      integrationId: 'int-a',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()
    writePause(root, true)

    const pausedHost = gatedHost()
    const paused = await boot(root, pausedHost.host)
    expect(pausedHost.host.prompt).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await paused.stop()

    writePause(root, false)
    const resumedHost = gatedHost()
    const resumed = await boot(root, resumedHost.host)
    // Startup stays silent: the pre-pause row was terminally discarded, not deferred.
    expect(resumedHost.host.prompt).not.toHaveBeenCalled()
    const fresh = (resumed as any).dispatch('bot-a', msg('200', 'fresh after resume'), 'int-a')
    await vi.waitFor(() => expect(resumedHost.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    expect(resumedHost.started[0]).toContain('fresh after resume')
    resumedHost.releaseOne()
    await expect(fresh).resolves.toBe('acp-1')
    await resumed.stop()
  })

  it('startup pause terminalizes a retained hook instead of deleting or replaying its report', async () => {
    const root = scaffold([HOOK_AGENT_ID])
    const retained = retainedHook('paused-startup')
    const s = await LocalStore.open(statePath(root))
    expect(await s.appendInbox(retained.row)).toBe(true)
    await s.close()
    writePause(root, true, HOOK_AGENT_ID)

    const pausedHost = gatedHost()
    const paused = await boot(root, pausedHost.host)
    expect(pausedHost.host.prompt).not.toHaveBeenCalled()
    const [receipt] = await inbox(root)
    expect(receipt).toMatchObject({ id: retained.id, hookContext: null, terminalReport: expect.any(String) })
    expect(JSON.parse(receipt!.terminalReport!)).toMatchObject({
      hookId: HOOK_ID,
      agentId: HOOK_AGENT_ID,
      deliveryKey: 'paused-startup',
      status: 'failed',
      reason: 'pause'
    })
    await paused.stop()

    writePause(root, false, HOOK_AGENT_ID)
    const resumedHost = gatedHost()
    const resumed = await boot(root, resumedHost.host)
    expect(resumedHost.host.prompt).not.toHaveBeenCalled()
    expect((await inbox(root))[0]).toMatchObject({ id: retained.id, terminalReport: expect.any(String) })
    await resumed.stop()
  })

  it('startup open-loop purges ordinary backlog but terminalizes a retained hook in the same scope', async () => {
    const root = scaffold([HOOK_AGENT_ID])
    const retained = retainedHook('loop-startup')
    const pendingReport = retainedHook('loop-pending-report')
    const s = await LocalStore.open(statePath(root))
    const limits = { windowMs: 60_000, maxTotal: 60, maxAutomatic: 8 }
    const now = Date.now()
    for (let n = 0; n < 9; n++) await s.recordLoopGuardTurn('slack:C1:dm', now + n, true, limits)
    expect(
      await s.appendInbox({
        ...row('ordinary-loop-backlog', retained.row.sessionKey, '001', HOOK_AGENT_ID),
        msg: JSON.stringify({ ...msg('ordinary-loop-backlog', 'old automatic turn'), msgId: 'ordinary-loop-backlog' })
      })
    ).toBe(true)
    expect(await s.appendInbox({ ...pendingReport.row, enqueuedAt: '0015' })).toBe(true)
    expect(
      await s.completeHookInbox(
        pendingReport.id,
        JSON.stringify({
          hookId: HOOK_ID,
          agentId: HOOK_AGENT_ID,
          deliveryKey: 'loop-pending-report',
          status: 'failed'
        }),
        now
      )
    ).toBe('completed')
    expect(await s.appendInbox({ ...retained.row, enqueuedAt: '002' })).toBe(true)
    await s.close()

    const host = gatedHost()
    const daemon = await boot(root, host.host)
    expect(host.host.prompt).not.toHaveBeenCalled()
    const rows = await inbox(root)
    expect(rows.map((row) => row.id).sort()).toEqual([pendingReport.id, retained.id].sort())
    const terminalized = rows.find((row) => row.id === retained.id)
    expect(terminalized).toMatchObject({ hookContext: null, terminalReport: expect.any(String) })
    expect(JSON.parse(terminalized!.terminalReport!)).toMatchObject({
      deliveryKey: 'loop-startup',
      status: 'failed',
      reason: 'loop protection'
    })
    expect(rows.find((row) => row.id === pendingReport.id)?.terminalReport).not.toBeNull()
    await daemon.stop()
  })

  it('an untrusted platform-turn burst opens the guard, clears the durable queue, and cancels the running turn', async () => {
    const root = scaffold()
    const g = gatedHost()
    const daemon = await boot(root, g.host)
    const automatic = (n: number) => ({
      ...msg(String(n), `automatic-${n}`),
      source: 'user' as const,
      sender: { id: 'unknown', isBot: false }
    })

    const head = (daemon as any).dispatch('bot-a', automatic(1), 'int-a')
    await vi.waitFor(() => expect(g.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    const queued: Array<Promise<unknown>> = []
    // Eight automatic admissions are allowed. The ninth consecutive one opens the
    // circuit before admission and atomically discards the seven buffered turns.
    for (let n = 2; n <= 8; n++) queued.push((daemon as any).dispatch('bot-a', automatic(n), 'int-a'))
    await vi.waitFor(() => expect((daemon as any).serialQueue.get('slack:C1:T1:bot-a')).toHaveLength(7), WAIT)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(8), WAIT)

    await expect((daemon as any).dispatch('bot-a', automatic(9), 'int-a')).resolves.toBeNull()
    await expect(Promise.all(queued)).resolves.toEqual(Array(7).fill(null))
    expect((daemon as any).serialQueue.size).toBe(0)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    expect(await loopGuard(root)).toMatchObject({ reason: 'automatic_turn_burst' })
    expect(g.host.cancel).toHaveBeenCalledWith('acp-1')

    // An explicit resume cannot reopen the conversation while the cancelled old
    // turn is still unwinding.
    const agent = (daemon as any).agents.get('bot-a')
    agent.integrations = [
      {
        id: 'int-a',
        platform: 'slack',
        core: { bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: 'b', appToken: 'a', botUserId: 'UBOT' }
      }
    ]
    const conn = { postMessage: vi.fn(async () => undefined), setStatus: vi.fn(async () => {}) }
    ;(daemon as any).connByIntegration.set('int-a', conn)
    await (daemon as any).onInboundOutcome(msg('10', '!resume'))
    expect(await loopGuard(root)).toMatchObject({ reason: 'automatic_turn_burst' })
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('still stopping'), 'T1', {
      chrome: true
    })

    g.releaseOne()
    await expect(head).resolves.toBeNull()
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    await vi.waitFor(() => expect((daemon as any).safetyDrainingAgents.size).toBe(0), WAIT)
    await (daemon as any).onInboundOutcome(msg('11', '!resume'))
    expect(await loopGuard(root)).toBeUndefined()
    await daemon.stop()
  })

  it('shares one guard across agents in a thread while leaving another thread unaffected', async () => {
    const root = scaffold(['bot-a', 'bot-b'])
    const a = gatedHost('acp-a')
    const b = gatedHost('acp-b')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (agent) => (agent.id === 'bot-a' ? a.host : b.host) as any
    })
    await daemon.start()
    for (const [agentId, integrationId] of [
      ['bot-a', 'int-a'],
      ['bot-b', 'int-b']
    ] as const) {
      ;(daemon as any).agents.get(agentId).integrations = [
        {
          id: integrationId,
          platform: 'slack',
          core: { mode: 'direct', bindRules: [] },
          config: { botToken: 'b', appToken: 'p' }
        }
      ]
      ;(daemon as any).connByIntegration.set(integrationId, {
        workspaceId: vi.fn(() => 'T1'),
        setStatus: vi.fn(async () => {}),
        postMessage: vi.fn(async () => undefined)
      })
    }
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue(undefined)
    const echo = (n: number, thread = 'T1') => ({
      ...msg(String(n), `echo-${n}`, thread),
      isDm: false,
      sender: { id: 'unknown', isBot: false }
    })

    const headA = (daemon as any).dispatch('bot-a', echo(1), 'int-a')
    const headB = (daemon as any).dispatch('bot-b', echo(2), 'int-b')
    await vi.waitFor(() => expect(a.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await vi.waitFor(() => expect(b.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    const queued = [
      (daemon as any).dispatch('bot-a', echo(3), 'int-a'),
      (daemon as any).dispatch('bot-b', echo(4), 'int-b'),
      (daemon as any).dispatch('bot-a', echo(5), 'int-a'),
      (daemon as any).dispatch('bot-b', echo(6), 'int-b'),
      (daemon as any).dispatch('bot-a', echo(7), 'int-a'),
      (daemon as any).dispatch('bot-b', echo(8), 'int-b')
    ]
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(8), WAIT)

    await expect((daemon as any).dispatch('bot-a', echo(9), 'int-a')).resolves.toBeNull()
    await expect(Promise.all(queued)).resolves.toEqual(Array(6).fill(null))
    expect(a.host.cancel).toHaveBeenCalledWith('acp-a')
    expect(b.host.cancel).toHaveBeenCalledWith('acp-b')
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)

    a.releaseOne()
    b.releaseOne()
    await expect(headA).resolves.toBeNull()
    await expect(headB).resolves.toBeNull()
    await vi.waitFor(() => expect((daemon as any).safetyDrainingAgents.size).toBe(0), WAIT)

    // Same channel, different non-DM thread is a distinct conversation scope.
    const fresh = (daemon as any).dispatch('bot-a', {
      ...echo(10, 'T2'),
      sender: { id: 'U1', isBot: false },
      text: 'fresh human turn'
    })
    await vi.waitFor(() => expect(a.host.prompt).toHaveBeenCalledTimes(2), WAIT)
    a.releaseOne()
    await expect(fresh).resolves.toBe('acp-a')
    await daemon.stop()
  })

  it('replay idempotency: a row whose entry is already live in the gate is not double-processed', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)

    // Admit a message (persists a live row) and freeze its turn in prompt.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    expect((await inbox(root)).map((r) => r.id)).toEqual(['slack:C1:100'])

    // Replay while that id is still live → it must be skipped, not re-dispatched.
    ;(daemon as any).replayInbox()
    await new Promise((r) => setTimeout(r, 20))
    expect(g.started.length).toBe(1)
    expect((daemon as any).serialQueue.get('slack:C1:T1:bot-a') ?? []).toHaveLength(0)

    g.releaseOne()
    await p1
    await daemon.stop()
  })

  it('a redelivery with an existing durable id is acknowledged without a second QueueEntry', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)

    const first = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)

    // Simulates an ACK-cache loss/restart race: SQLite still owns the stable
    // delivery id, so INSERT OR IGNORE must also gate in-memory admission.
    const duplicate = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await expect(duplicate).resolves.toBeNull()
    expect((daemon as any).serialQueue.get('slack:C1:T1:bot-a') ?? []).toHaveLength(0)
    expect(g.started).toHaveLength(1)

    g.releaseOne()
    await first
    await daemon.stop()
  })

  it('replays an unknown-agent row only after its CP integration binding converges', async () => {
    const g = gatedHost()
    const root = scaffold(['bot-a']) // only bot-a exists on this daemon
    const integrationId = '66666666-6666-4666-8666-666666666666'
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: 'slack:C1:100',
      sessionKey: sessionKey('slack', 'C1', 'T1', 'ghost'),
      agentId: 'ghost',
      msg: JSON.stringify({ ...msg('100', 'orphan'), isDm: false, trigger: 'mention' }),
      integrationId,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()

    const daemon = await boot(root, g.host)
    await new Promise((r) => setTimeout(r, 30))
    // Never dispatched; the row is LEFT for another owner.
    expect(g.started.length).toBe(0)
    expect((await inbox(root)).map((r) => r.id)).toEqual(['slack:C1:100'])

    const conn = {
      workspaceId: vi.fn(() => 'T_READY'),
      setStatus: vi.fn(async () => {}),
      postMessage: vi.fn(async () => {})
    }
    vi.spyOn((daemon as any).connections, 'reconcileSlackConnections').mockImplementation(async () => {
      const integration = (daemon as any).agents
        .get('ghost')
        ?.integrations.find((candidate: { id: string }) => candidate.id === integrationId)
      if (integration) (daemon as any).connByIntegration.set(integrationId, conn)
    })
    await (daemon as any).cpConfigApply().applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [{ agentId: 'ghost', name: 'ghost', runtime: 'claude' }],
      integrations: [
        {
          integrationId,
          agentId: 'ghost',
          platform: 'slack',
          core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }], mutedChannels: [], gated: false },
          config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
        }
      ],
      crons: [],
      leases: [],
      drop: { assignments: [], agents: [], integrations: [], crons: [] }
    })
    await vi.waitFor(() => expect(g.started).toHaveLength(1), WAIT)
    expect((daemon as any).connByIntegration.get(integrationId)).toBe(conn)
    expect(g.started[0]).toContain('orphan')

    g.releaseOne()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })

  it('purges a retained unknown-agent row when that agent is later added already paused', async () => {
    const root = scaffold(['bot-a'])
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: 'slack:C9:100',
      sessionKey: sessionKey('slack', 'C9', 'T9', 'ghost'),
      agentId: 'ghost',
      msg: JSON.stringify({ ...msg('100', 'old work', 'T9'), msgId: 'slack:C9:100', channel: 'C9' }),
      integrationId: 'int-ghost',
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await s.close()

    const g = gatedHost()
    const daemon = await boot(root, g.host)
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(1), WAIT)

    const agentDir = join(root, 'agents', 'ghost')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'ghost',
        name: 'ghost',
        status: 'active',
        pause: true,
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
    await daemon.reconcile()
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    expect(g.host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('SHUTDOWN keeps rows for replay: a deadline-cancel that unwinds the in-flight prompt must NOT delete the head OR queued rows', async () => {
    // Bug (§6.9 #353): on a shutdown that hits the drain deadline, drainForShutdown calls
    // host.cancel(sid) on the in-flight turn. That unwinds the blocked ACP prompt →
    // dispatchOne THROWS → runLoop's catch would (pre-fix) removeInbox() the head AND every
    // queued rest — exactly the admitted-but-unrun rows startup replay is meant to recover.
    // With the fix, when this.draining those removals are skipped, so the rows SURVIVE.
    const releases: Array<(err?: Error) => void> = []
    const started: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
        started.push(blocks.map((b) => b.text ?? '').join('|'))
        // Block until either released normally or cancel() throws to unwind us.
        await new Promise<void>((resolve, reject) => releases.push((err) => (err ? reject(err) : resolve())))
        return 'end_turn'
      }),
      // Simulate a deadline-cancel unwinding the blocked prompt: reject the pending prompt.
      cancel: vi.fn(async () => releases.shift()?.(new Error('cancelled by shutdown'))),
      stop: vi.fn(async () => {})
    }

    const root = scaffold()
    const daemon = await boot(root, host as any)
    // Force the drain deadline to fire immediately so cancel() is invoked on the in-flight turn.
    ;(daemon as any).cfg.limits.shutdownDrainMs = 0
    const key = 'slack:C1:T1:bot-a'

    // Head admitted + running (blocked in prompt); two more queued behind it. All persisted.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    const p3 = (daemon as any).dispatch('bot-a', msg('300', 'third'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)
    expect((await inbox(root)).map((r) => r.id).sort()).toEqual(['slack:C1:100', 'slack:C1:200', 'slack:C1:300'])

    // Observe the settlements so no unhandled rejection escapes.
    void p1.catch(() => {})
    void p2.catch(() => {})
    void p3.catch(() => {})

    // Shutdown: drain deadline hits → cancel(sid) unwinds prompt → dispatchOne throws while
    // this.draining is true. The catch/fail-stop path must KEEP every row for replay.
    await daemon.stop()

    // All three rows SURVIVE (head + queued rest) so a subsequent replayInbox would recover them.
    expect((await inbox(root)).map((r) => r.id).sort()).toEqual(['slack:C1:100', 'slack:C1:200', 'slack:C1:300'])
  })

  it('a webchat message is NOT durably persisted (live sink cannot be restored)', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)
    const key = 'slack:C1:T1:bot-a'
    const dones: WebchatDone[] = []
    const sink = { output: (_o: WebchatOutput) => {}, done: (d: WebchatDone) => dones.push(d) }
    const turnId = '77777777-7777-4777-8777-777777777777'

    // Head non-webchat turn runs; a webchat turn queues behind it. The webchat entry admits
    // into the gate but must NOT write a durable inbox row.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'wc'), 'int-a', {
      conversationId: 'conv-a',
      turnId,
      sink
    })
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)
    // Only the non-webchat head has a row; the webchat entry is absent.
    expect((await inbox(root)).map((r) => r.id)).toEqual(['slack:C1:100'])

    void p2.catch(() => {})
    g.releaseAll()
    await p1
    await daemon.stop()
    // Still no webchat row after the head drained.
    expect((await inbox(root)).some((r) => r.id === 'slack:C1:200')).toBe(false)
  })

  it('durably persists an agent-initiated post-only webchat wake', async () => {
    const g = gatedHost()
    const root = scaffold()
    const daemon = await boot(root, g.host)
    const conversationId = '88888888-8888-4888-8888-888888888888'
    const deliveryId = 'agent-post-only'
    const wake = {
      msgId: `agentcall:${conversationId}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent' as const,
      platform: 'webchat' as const,
      channel: conversationId,
      thread: `webchat:${conversationId}`,
      sender: { id: 'bot-b', isBot: true },
      text: 'reply into the browser conversation',
      mentionedBots: [] as string[],
      isDm: false
    }
    const turn = (daemon as any).dispatch(
      'bot-a',
      wake,
      undefined,
      (daemon as any).webchatTransport.webchatWakeContext('webchat', conversationId),
      { callFrom: 'bot-b', hopCount: 1, deliveryId }
    )

    await vi.waitFor(() => expect(g.started).toHaveLength(1), WAIT)
    expect((await inbox(root)).map((row) => row.id)).toEqual([deliveryId])

    g.releaseOne()
    await expect(turn).resolves.toBe('acp-1')
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })

  it('replays an agent-initiated webchat wake with its canonical live post sink', async () => {
    const root = scaffold()
    const conversationId = '99999999-9999-4999-8999-999999999999'
    const deliveryId = 'replayed-agent-post'
    const wake = {
      msgId: `agentcall:${conversationId}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent' as const,
      platform: 'webchat' as const,
      channel: conversationId,
      thread: `webchat:${conversationId}`,
      sender: { id: 'bot-b', isBot: true },
      text: 'recover this reply into the browser conversation',
      mentionedBots: [] as string[],
      isDm: false
    }
    const persisted = await LocalStore.open(statePath(root))
    await persisted.appendInbox({
      id: deliveryId,
      sessionKey: sessionKey('webchat', conversationId, `webchat:${conversationId}`, 'bot-a'),
      agentId: 'bot-a',
      msg: JSON.stringify(wake),
      integrationId: null,
      callMeta: JSON.stringify({ callFrom: 'bot-b', hopCount: 1, deliveryId }),
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await persisted.close()

    let onUpdate!: (sessionId: string, update: unknown) => void
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-replayed-webchat'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'recovered browser reply' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    const sendWebchatPost = vi.fn()
    ;(daemon as any).relays = { sendWebchatPost, stop: vi.fn(async () => {}) }

    await daemon.start()
    await vi.waitFor(() => expect(sendWebchatPost).toHaveBeenCalledTimes(1), WAIT)
    expect(sendWebchatPost).toHaveBeenCalledWith({
      conversationId,
      agentId: 'bot-a',
      post: expect.objectContaining({
        postId: expect.any(String),
        conversationId,
        // The replayed wake's CallMeta carried hopCount 1, and the commit stamps the
        // authoring turn's depth on the post (webchat-multi-agents.md §5.2a).
        author: { kind: 'agent', agentId: 'bot-a', hopCount: 1 },
        text: 'recovered browser reply',
        at: expect.any(Number)
      }),
      initiator: 'agent'
    })
    await vi.waitFor(async () => expect(await inbox(root)).toHaveLength(0), WAIT)
    await daemon.stop()
  })
})
