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

const WAIT = { timeout: 10_000 }
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '11111111-1111-4111-8111-111111111111'
const INTEGRATION = 'int-a'
const ORG = 'org-1'

/** A member root; with `sharedStateOf`, its durable store IS that root's file — one shared inbox. */
function scaffold(sharedStateOf?: string): string {
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
    new LocalStore(statePath(root)).close()
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
  const daemon = new Daemon({ root, hostFactory: () => g.host as any })
  await daemon.start()
  const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    emitMemoryConnectionFacts: vi.fn(() => {}),
    fetchDutyAgent
  }
  return { daemon, ...g, fetchDutyAgent }
}

const admit = (d: Daemon, term = '1') => (d as any).admitDutyGrants([grant(term)]) as Promise<Set<string>>
const fence = (d: Daemon) => (d as any).fenceDuties([GROUP])
const holds = (d: Daemon): boolean => (d as any).duties.holdsAgent(AGENT)
/** The reconcile a duty change requests has run to completion. */
const settled = (d: Daemon) =>
  vi.waitFor(() => {
    expect((d as any).dutyConnectionsConverged).toBe((d as any).dutyConnectionsRequested)
    expect((d as any).reconcileRun).toBeUndefined()
  }, WAIT)

function inbox(root: string): InboxRow[] {
  const s = new LocalStore(statePath(root))
  const rows = s.listInboxBySessionKeyFifo()
  s.close()
  return rows
}

describe('replaying the shared inbox on a duty gain', () => {
  it('a re-grant to a member whose replica is already installed replays the crashed holder’s backlog exactly once', async () => {
    const rootA = scaffold()
    const a = await boot(rootA)
    const b = await boot(scaffold(rootA))
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
    expect(inbox(rootA).map((r) => r.id)).toEqual(['slack:C1:100'])

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
    await vi.waitFor(() => expect(inbox(rootA)).toHaveLength(0), WAIT)
    // The dead holder's process is only released here so its handles close; the row is long gone.
    a.releaseAll()
    await turnOnA.catch(() => {})
    await Promise.all([a.daemon.stop(), b.daemon.stop()])
  }, 20_000)

  it('a fresh install still replays the backlog exactly once', async () => {
    const rootA = scaffold()
    const seed = new LocalStore(statePath(rootA))
    seed.appendInbox({
      id: 'slack:C1:100',
      sessionKey: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      msg: JSON.stringify(msg('100', 'orphaned turn')),
      integrationId: INTEGRATION,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    seed.close()
    const b = await boot(scaffold(rootA))
    expect(b.started).toEqual([])

    await admit(b.daemon)
    expect(b.fetchDutyAgent).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(b.started).toHaveLength(1), WAIT)
    expect(b.started[0]).toContain('orphaned turn')
    await settled(b.daemon)
    expect(b.host.prompt).toHaveBeenCalledTimes(1)

    b.releaseAll()
    await vi.waitFor(() => expect(inbox(rootA)).toHaveLength(0), WAIT)
    await b.daemon.stop()
  }, 20_000)

  it('a member holding the replica but not the duty leaves the backlog for the holder', async () => {
    const rootA = scaffold()
    const b = await boot(scaffold(rootA))
    await admit(b.daemon)
    await settled(b.daemon)
    fence(b.daemon)
    await settled(b.daemon)

    const seed = new LocalStore(statePath(rootA))
    seed.appendInbox({
      id: 'slack:C1:100',
      sessionKey: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      msg: JSON.stringify(msg('100', 'someone else’s turn')),
      integrationId: INTEGRATION,
      callMeta: null,
      isQueueCmd: null,
      enqueuedAt: '100'
    })
    seed.close()

    // A replay for an agent this member has but does not serve must not run it here.
    ;(b.daemon as any).replayInbox(new Set([AGENT]))
    await new Promise((r) => setTimeout(r, 50))
    expect(b.host.prompt).not.toHaveBeenCalled()
    expect(inbox(rootA).map((r) => r.id)).toEqual(['slack:C1:100'])
    await b.daemon.stop()
  }, 20_000)
})
