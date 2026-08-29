// Gaining a duty replays that agent's shared durable-inbox backlog — whether or not the grant had
// to install anything (#1034). A crashed holder leaves its admitted rows pending in the shared
// store; its successor usually still has the replica warm (a release is never a removal, #948),
// so the grant fetches nothing and no reconcile `toStart` ever asks for a replay. These pin that
// the duty gain itself is the replay trigger, exactly once, and that a term bump on the current
// holder is not one.
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { LocalStore, sessionKey, type InboxRow } from '../src/store/local-store.js'
import { statePath } from '../src/paths.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '11111111-1111-4111-8111-111111111111'
const INTEGRATION = 'int-a'
const ORG = 'org-1'

/** A member root; with `sharedStateOf`, its durable store IS that root's file — one shared inbox. */
async function scaffold(sharedStateOf?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-inbox-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  if (sharedStateOf) {
    mkdirSync(join(root, 'state'), { recursive: true })
    symlinkSync(statePath(sharedStateOf), statePath(root))
  } else {
    await (await LocalStore.open(statePath(root))).close()
  }
  return root
}

const grant = (term = '1'): DutyGrantEntry => ({
  groupId: GROUP,
  orgId: ORG,
  term,
  members: [{ kind: 'agent', refId: AGENT }]
})

// No integrations: a socket would be a real network call, and the inbox path needs none.
const bundle = () => ({
  agentId: AGENT,
  spec: {
    orgId: ORG,
    name: 'scout',
    runtime: 'claude',
    workspace: { mode: 'scratch' as const, isolation: 'shared' as const }
  },
  integrations: [],
  crons: []
})

/** A host whose prompts block until released, so an admitted turn stays in flight on demand. */
function gatedHost() {
  const releases: Array<() => void> = []
  const started: string[] = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      started.push(blocks.map((b) => b.text ?? '').join('|'))
      await new Promise<void>((resolve) => releases.push(resolve))
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return { host, started, releaseAll: () => releases.splice(0).forEach((r) => r()) }
}

const msg = (ts: string, text: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

/** A frame-scope member with a stub CP client that serves the one agent's bundle. */
async function boot(root: string) {
  const g = gatedHost()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => g.host as any })
  await daemon.start()
  const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    emitMemoryConnectionFacts: vi.fn(() => {}),
    fetchDutyAgent
  }
  return { daemon, ...g, fetchDutyAgent }
}

const admit = (d: Daemon, term = '1') =>
  (d as any).dutyCoordinator.admitDutyGrants([grant(term)]) as Promise<Set<string>>
const fence = (d: Daemon) => (d as any).dutyCoordinator.fenceDuties([GROUP])
const holds = (d: Daemon): boolean => (d as any).duties.holdsAgent(AGENT)
/** The reconcile a duty change requests has run to completion. */
const settled = (d: Daemon) =>
  vi.waitFor(() => {
    expect((d as any).dutyCoordinator.dutyConnectionsConverged).toBe(
      (d as any).dutyCoordinator.dutyConnectionsRequested
    )
    expect((d as any).reconcileRun).toBeUndefined()
  }, WAIT)

async function inbox(root: string): Promise<InboxRow[]> {
  const s = await LocalStore.open(statePath(root))
  const rows = await s.listInboxBySessionKeyFifo()
  await s.close()
  return rows
}

describe('replaying the shared inbox on a duty gain', () => {
  // The shared store is faked by symlinking a peer's local.sqlite here, and Windows shows the second
  // daemon none of the first's rows through it.
  it.skipIf(process.platform === 'win32')(
    'a re-grant to a member whose replica is already installed replays the crashed holder’s backlog exactly once',
    async () => {
      const rootA = await scaffold()
      const a = await boot(rootA)
      const b = await boot(await scaffold(rootA))
      // B held the agent earlier and kept the replica; the duty then moved on.
      await admit(b.daemon)
      await settled(b.daemon)
      expect(b.fetchDutyAgent).toHaveBeenCalledTimes(1)
      fence(b.daemon)
      await settled(b.daemon)
      expect(holds(b.daemon)).toBe(false)

      // A holds the duty, admits a turn (the row is durable before the ACK), and then dies mid-turn.
      await admit(a.daemon)
      await settled(a.daemon)
      const turnOnA = (a.daemon as any).dispatch(AGENT, msg('100', 'finish the report'), INTEGRATION)
      void turnOnA.catch(() => {})
      await vi.waitFor(() => expect(a.started).toHaveLength(1), WAIT)
      expect(a.started[0]).toContain('finish the report')
      expect((await inbox(rootA)).map((r) => r.id)).toEqual(['slack:C1:100'])

      // The duty comes back to B at a later term. The replica is current, so nothing is fetched —
      // and that must not mean nothing is replayed.
      await admit(b.daemon, '2')
      expect(b.fetchDutyAgent).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(b.started).toHaveLength(1), WAIT)
      expect(b.started[0]).toContain('finish the report')
      await settled(b.daemon)
      expect(b.host.prompt).toHaveBeenCalledTimes(1)

      // A term bump on the CURRENT holder gains no agent, so it replays nothing more.
      const replay = vi.spyOn(b.daemon as any, 'replayInbox')
      await admit(b.daemon, '3')
      await settled(b.daemon)
      expect(replay).not.toHaveBeenCalled()
      expect(b.host.prompt).toHaveBeenCalledTimes(1)

      b.releaseAll()
      await vi.waitFor(async () => expect(await inbox(rootA)).toHaveLength(0), WAIT)
      // The dead holder's process is only released here so its handles close; the row is long gone.
      a.releaseAll()
      await turnOnA.catch(() => {})
      await Promise.all([a.daemon.stop(), b.daemon.stop()])
    }
  )

  // The shared store is faked by symlinking a peer's local.sqlite here, and Windows shows the second
  // daemon none of the first's rows through it.
  it.skipIf(process.platform === 'win32')('a fresh install still replays the backlog exactly once', async () => {
    const rootA = await scaffold()
    const seed = await LocalStore.open(statePath(rootA))
    await seed.appendInbox({
      id: 'slack:C1:100',
      sessionKey: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      msg: JSON.stringify(msg('100', 'orphaned turn')),
      integrationId: INTEGRATION,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await seed.close()
    const b = await boot(await scaffold(rootA))
    expect(b.started).toEqual([])

    await admit(b.daemon)
    expect(b.fetchDutyAgent).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(b.started).toHaveLength(1), WAIT)
    expect(b.started[0]).toContain('orphaned turn')
    await settled(b.daemon)
    expect(b.host.prompt).toHaveBeenCalledTimes(1)

    b.releaseAll()
    await vi.waitFor(async () => expect(await inbox(rootA)).toHaveLength(0), WAIT)
    await b.daemon.stop()
  })

  it('a member holding the replica but not the duty leaves the backlog for the holder', async () => {
    const rootA = await scaffold()
    const b = await boot(await scaffold(rootA))
    await admit(b.daemon)
    await settled(b.daemon)
    fence(b.daemon)
    await settled(b.daemon)

    const seed = await LocalStore.open(statePath(rootA))
    await seed.appendInbox({
      id: 'slack:C1:100',
      sessionKey: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      msg: JSON.stringify(msg('100', 'someone else’s turn')),
      integrationId: INTEGRATION,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    await seed.close()

    // A replay for an agent this member has but does not serve must not run it here.
    ;(b.daemon as any).replayInbox(new Set([AGENT]))
    await new Promise((r) => setTimeout(r, 50))
    expect(b.host.prompt).not.toHaveBeenCalled()
    expect((await inbox(rootA)).map((r) => r.id)).toEqual(['slack:C1:100'])
    await b.daemon.stop()
  })
})

// A duty handoff is not an agent removal (#1050). `stopServingAgent` interrupts the turns running
// here, but on a pool's shared store the agent's admitted-but-unrun rows are the work the successor
// holder has to replay — purging them makes a GRACEFUL revoke/fence/drain lose messages a crash
// would have preserved. These pin that the retiring member keeps the rows and that removal, the
// other caller of the same interrupt, still discards them. HOOK rows are the exception — fenced to
// their accepted dispatch daemon, so a handoff reports them instead (daemon-hook.test.ts).
describe('a duty handoff leaves the agent’s unrun inbox to its successor', () => {
  const seedRow = async (root: string, ts: string, text: string) => {
    const s = await LocalStore.open(statePath(root))
    await s.appendInbox({
      id: `slack:C1:${ts}`,
      sessionKey: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      msg: JSON.stringify(msg(ts, text)),
      integrationId: INTEGRATION,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: ts
    })
    await s.close()
  }

  // The shared store is faked by symlinking a peer's local.sqlite here, and Windows shows the second
  // daemon none of the first's rows through it.
  it.skipIf(process.platform === 'win32')(
    'a graceful fence keeps the admitted row and the successor runs it exactly once',
    async () => {
      const rootA = await scaffold()
      const a = await boot(rootA)
      await admit(a.daemon)
      await settled(a.daemon)
      // Admitted before the ACK settled and not yet started — the row a crash would leave behind.
      seedRow(rootA, '100', 'finish the report')

      fence(a.daemon)
      await settled(a.daemon)
      expect(holds(a.daemon)).toBe(false)
      expect(a.host.prompt).not.toHaveBeenCalled()
      // On main the fence purged this row, so the successor below had nothing to replay.
      expect((await inbox(rootA)).map((r) => r.id)).toEqual(['slack:C1:100'])

      const b = await boot(await scaffold(rootA))
      await admit(b.daemon, '2')
      await vi.waitFor(() => expect(b.started).toHaveLength(1), WAIT)
      expect(b.started[0]).toContain('finish the report')
      await settled(b.daemon)
      expect(b.host.prompt).toHaveBeenCalledTimes(1)

      b.releaseAll()
      await vi.waitFor(async () => expect(await inbox(rootA)).toHaveLength(0), WAIT)
      await Promise.all([a.daemon.stop(), b.daemon.stop()])
    }
  )

  it('the interrupted head and everything queued behind it survive the retiring member’s teardown', async () => {
    const rootA = await scaffold()
    const a = await boot(rootA)
    await admit(a.daemon)
    await settled(a.daemon)
    const head = (a.daemon as any).dispatch(AGENT, msg('100', 'first'), INTEGRATION)
    void head.catch(() => {})
    await vi.waitFor(() => expect(a.started).toHaveLength(1), WAIT)
    const queued = (a.daemon as any).dispatch(AGENT, msg('200', 'second'), INTEGRATION)
    void queued.catch(() => {})
    await vi.waitFor(async () => expect(await inbox(rootA)).toHaveLength(2), WAIT)

    fence(a.daemon)
    await settled(a.daemon)
    expect((await inbox(rootA)).map((r) => r.id)).toEqual(['slack:C1:100', 'slack:C1:200'])
    // The cancelled head settles through dispatch's own terminal paths afterwards; those must
    // not delete the row the handoff just kept.
    a.releaseAll()
    await head.catch(() => {})
    await queued.catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect((await inbox(rootA)).map((r) => r.id)).toEqual(['slack:C1:100', 'slack:C1:200'])
    await a.daemon.stop()
  })

  it('removing the agent still discards its unrun rows', async () => {
    const rootA = await scaffold()
    const a = await boot(rootA)
    await admit(a.daemon)
    await settled(a.daemon)
    seedRow(rootA, '100', 'work nobody will do')
    expect(await inbox(rootA)).toHaveLength(1)

    // The destructive authority-release fence every agent removal runs.
    await (a.daemon as any).quiesceAgentWorkspaceAuthority(AGENT)
    expect(await inbox(rootA)).toHaveLength(0)
    await a.daemon.stop()
  })
})
