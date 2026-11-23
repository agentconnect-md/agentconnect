import { describe, it, expect } from 'vitest'
import { DAEMON_CONNECT_GRACE_MS, computeGettingStarted } from './getting-started'
import type { Agent, DaemonRow, IntegrationRow, Session } from '@/lib/data'
import type { MemberDto } from '@/lib/api'

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'bot',
    model: 'default',
    runtime: 'claude',
    daemon: 'd1',
    workspace: { mode: 'scratch' },
    ...over
  }) as Agent
const NOW = Date.parse('2026-06-01T12:00:00.000Z')
type Rt = DaemonRow['runtimeModels'][number]
const READY: Partial<Rt> = { runtime: 'claude', acpProtocolVersion: 1 }
const daemon = (status: DaemonRow['status'], over: Partial<DaemonRow> = {}): DaemonRow =>
  ({
    daemonId: 'd1',
    status,
    lastSeenAt: '2026-06-01T11:59:00.000Z',
    createdAtIso: '2026-05-01T00:00:00.000Z',
    runtimeModels: [READY as Rt],
    ...over
  }) as DaemonRow
// Provisioned by AddDaemon but never heartbeated.
const unconnected = (createdAtIso: string, id = 'd1'): DaemonRow =>
  daemon('offline', { daemonId: id, lastSeenAt: null, createdAtIso, runtimeModels: [] })
const item = (key: string, over: Partial<Parameters<typeof computeGettingStarted>[0]>) =>
  computeGettingStarted({ ...empty, now: NOW, ...over }).items.find((i) => i.key === key)!
const empty = { agents: [], daemons: [], integrations: [], sessions: [], members: [], authOn: true }

describe('computeGettingStarted', () => {
  it('starts all-incomplete for a fresh org and reports progress', () => {
    const gs = computeGettingStarted(empty)
    expect(gs.done).toBe(0)
    expect(gs.total).toBe(7) // 5 core + invite + session-access (auth mode)
    expect(gs.fraction).toBe(0)
    expect(gs.allDone).toBe(false)
  })

  it('orders the steps per the design: daemon, runtime, slack, github, conversation, invite, session-access', () => {
    expect(computeGettingStarted(empty).items.map((i) => i.key)).toEqual([
      'daemon',
      'runtime',
      'slack',
      'github',
      'conversation',
      'invite',
      'session-access'
    ])
  })

  // A pool Pod is install-wide infrastructure, not a machine this org connected — and with the
  // pool hidden the console does not show it at all. It must not tick "Connect a daemon".
  it('does not tick the daemon step from a pool member Pod', () => {
    const done = (rows: DaemonRow[]) =>
      computeGettingStarted({ ...empty, daemons: rows }).items.find((i) => i.key === 'daemon')!.done
    expect(done([daemon('online', { daemonId: 'pool-1', pool: true })])).toBe(false)
    expect(done([daemon('online')])).toBe(true)
  })

  // Cloud pool on: agents run there, so there is no daemon to connect and the step goes.
  it('drops the daemon and runtime steps where the deployment offers the cloud pool', () => {
    const pooled = computeGettingStarted({ ...empty, poolEnabled: true, daemons: [daemon('online')] })
    expect(pooled.items.map((i) => i.key)).not.toContain('daemon')
    expect(pooled.items.map((i) => i.key)).not.toContain('runtime')
    expect(pooled.total).toBe(5)
    // off (a self-hosted install) it is still the first step
    expect(computeGettingStarted(empty).items[0]!.key).toBe('daemon')
  })

  it('drops the invite AND session-access items in no-auth mode (no /settings there)', () => {
    expect(computeGettingStarted({ ...empty, authOn: false }).total).toBe(5)
    expect(computeGettingStarted({ ...empty, authOn: false }).items.some((i) => i.key === 'invite')).toBe(false)
    expect(computeGettingStarted({ ...empty, authOn: false }).items.some((i) => i.key === 'session-access')).toBe(false)
  })

  it('ticks session-access only from the client-side reviewed flag — no CP signal exists', () => {
    const step = (sessionAccessReviewed?: boolean) =>
      computeGettingStarted({ ...empty, sessionAccessReviewed }).items.find((i) => i.key === 'session-access')!
    expect(step().done).toBe(false)
    expect(step(true).done).toBe(true)
    expect(step().action).toEqual({ kind: 'session-access' })
  })

  it('hides session-access when its card would render nothing — the CTA must not point at a missing anchor', () => {
    const has = (sessionAccessAvailable?: boolean) =>
      computeGettingStarted({ ...empty, sessionAccessAvailable }).items.some((i) => i.key === 'session-access')
    expect(has(false)).toBe(false)
    // undefined (probe in flight / failed) keeps the step — same convention as githubEnabled
    expect(has(undefined)).toBe(true)
    expect(has(true)).toBe(true)
  })

  it('leaves the daemon step at the default "add" CTA when there is no daemon', () => {
    expect(item('daemon', {})).toMatchObject({ done: false, action: { kind: 'daemon' } })
    expect(item('daemon', {}).variant).toBeUndefined()
  })

  it('keeps a created-but-never-connected daemon incomplete and points at a fresh connect command', () => {
    const fresh = item('daemon', { daemons: [unconnected(new Date(NOW - 60_000).toISOString())] })
    expect(fresh).toMatchObject({
      done: false,
      variant: 'waiting',
      action: { kind: 'daemon-reconnect', daemonId: 'd1' }
    })
    // past the grace the copy names causes instead of waiting
    const stale = item('daemon', { daemons: [unconnected(new Date(NOW - DAEMON_CONNECT_GRACE_MS).toISOString())] })
    expect(stale).toMatchObject({ done: false, variant: 'not-connected' })
    // no creation time to judge by ⇒ the neutral wording
    expect(item('daemon', { daemons: [unconnected('')] }).variant).toBe('waiting')
    // several unconnected rows ⇒ the newest one
    const rows = [unconnected('2026-05-01T00:00:00.000Z', 'old'), unconnected('2026-05-20T00:00:00.000Z', 'new')]
    expect(item('daemon', { daemons: rows }).action).toEqual({ kind: 'daemon-reconnect', daemonId: 'new' })
  })

  it('keeps the daemon step done for a daemon that connected once and is now offline', () => {
    expect(item('daemon', { daemons: [daemon('offline')] }).done).toBe(true)
    expect(item('daemon', { daemons: [daemon('online')] }).done).toBe(true)
    // one connected machine is enough even beside a never-connected row
    expect(item('daemon', { daemons: [unconnected('2026-05-01T00:00:00.000Z', 'x'), daemon('offline')] }).done).toBe(
      true
    )
  })

  it('ticks the runtime step only for a probe-confirmed runtime with no install or login issue', () => {
    const rt = (r: Partial<Rt>[]) => item('runtime', { daemons: [daemon('online', { runtimeModels: r as Rt[] })] })
    expect(rt([READY]).done).toBe(true)
    // an offline machine keeps what it last reported
    expect(item('runtime', { daemons: [daemon('offline')] }).done).toBe(true)
    // probe pending: no warning yet, but nothing confirmed either
    expect(rt([{ runtime: 'claude' }])).toMatchObject({ done: false, variant: 'checking' })
    expect(rt([])).toMatchObject({ done: false, variant: 'checking' })
    // a confirmed probe that later needed a login is not ready
    expect(rt([{ ...READY, authRequired: true }]).done).toBe(false)
    expect(rt([{ runtime: 'codex', unavailableReason: 'host-binary-missing' }]).done).toBe(false)
    // pool Pods never count
    expect(item('runtime', { daemons: [daemon('online', { pool: true })] }).done).toBe(false)
  })

  it('points an online daemon with no usable runtime at the fix', () => {
    const rt = (r: Partial<Rt>[]) => item('runtime', { daemons: [daemon('online', { runtimeModels: r as Rt[] })] })
    // a login wins over a probe that has not settled
    expect(
      rt([{ runtime: 'claude' }, { runtime: 'codex', authRequired: true, credentialsConfigured: false }])
    ).toMatchObject({
      done: false,
      variant: 'login',
      action: { kind: 'runtime-login', daemonId: 'd1', runtimeId: 'codex' }
    })
    // only missing installs: the default copy and the daemon page
    const missing = rt([{ runtime: 'claude', unavailableReason: 'host-binary-missing' }])
    expect(missing).toMatchObject({ done: false, action: { kind: 'daemon-detail', daemonId: 'd1' } })
    expect(missing.variant).toBeUndefined()
  })

  it('keeps the runtime step on its default copy until a daemon has connected', () => {
    expect(item('runtime', {})).toMatchObject({ done: false, action: { kind: 'daemon-detail', daemonId: null } })
    expect(item('runtime', { daemons: [unconnected('2026-05-01T00:00:00.000Z')] }).variant).toBeUndefined()
  })

  it('merges GitHub + repository into one step, done when a repo is attached', () => {
    const gh = (agents: Agent[]) => computeGettingStarted({ ...empty, agents }).items.find((i) => i.key === 'github')!
    expect(gh([agent()]).done).toBe(false)
    expect(
      gh([agent({ workspace: { mode: 'git', provider: 'github', repo: 'acme/x' } as Agent['workspace'] })]).done
    ).toBe(true)
    // the old separate 'repo' step is gone
    expect(computeGettingStarted(empty).items.some((i) => i.key === 'repo')).toBe(false)
  })

  it('marks slack, conversation, and invite from their signals', () => {
    const gs = computeGettingStarted({
      ...empty,
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1', statusLabel: 'completed' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto]
    })
    expect(gs.items.find((i) => i.key === 'slack')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'conversation')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'invite')!.done).toBe(true)
  })

  it('marks the conversation done as soon as ANY session exists — no re-chat just to clear the step', () => {
    const convo = (sessions: Session[]) =>
      computeGettingStarted({ ...empty, sessions }).items.find((i) => i.key === 'conversation')!.done
    expect(convo([])).toBe(false)
    // running / channel-triggered / whoever ran it — a session existing at all means a
    // conversation has been driven here (product decision; see getting-started.ts).
    expect(convo([{ id: 's1', statusLabel: 'running' } as Session])).toBe(true)
    expect(convo([{ id: 's1', statusLabel: 'completed', triggeredBy: 'u_teammate' } as Session])).toBe(true)
  })

  it('prefers the org-wide orgHasSessions boolean over the caller-visible list', () => {
    const convo = (orgHasSessions: boolean | undefined, sessions: Session[] = []) =>
      computeGettingStarted({ ...empty, sessions, orgHasSessions }).items.find((i) => i.key === 'conversation')!.done
    // a collaborator who can see NO sessions still gets the tick when the org has some
    // (restricted/private rows are filtered out of GET /sessions)
    expect(convo(true)).toBe(true)
    // the boolean is authoritative in both directions once present
    expect(convo(false, [{ id: 's1' } as Session])).toBe(false)
    // not yet loaded / older CP: fall back to the visible list
    expect(convo(undefined, [{ id: 's1' } as Session])).toBe(true)
    expect(convo(undefined)).toBe(false)
  })

  it('points agent-scoped CTAs at the built-in agent first, else the first agent', () => {
    const withBuiltin = computeGettingStarted({
      ...empty,
      agents: [agent({ id: 'a9' }), agent({ id: 'ac', builtin: true })]
    })
    expect(withBuiltin.items.find((i) => i.key === 'slack')!.action).toEqual({ kind: 'slack', agentId: 'ac' })
    expect(computeGettingStarted(empty).items.find((i) => i.key === 'github')!.action).toEqual({
      kind: 'github',
      agentId: null
    })
  })

  it('adds the GitHub-profile step only for a signed-in user with NO GitHub identity', () => {
    const step = (githubLinked?: boolean) =>
      computeGettingStarted({ ...empty, githubLinked }).items.find((i) => i.key === 'github-profile')
    // auth off / no GitHub connector / account still loading → omitted entirely
    expect(step(undefined)).toBeUndefined()
    // GitHub sign-ins are born linked — never show them the step
    expect(step(true)).toBeUndefined()
    expect(step(false)).toMatchObject({ done: false, action: { kind: 'github-profile' } })
    // slots in right after the org-level GitHub install step
    const keys = computeGettingStarted({ ...empty, githubLinked: false }).items.map((i) => i.key)
    expect(keys.indexOf('github-profile')).toBe(keys.indexOf('github') + 1)
  })

  it('hides both GitHub steps when the deployment has no GitHub App provider', () => {
    const keys = (githubEnabled?: boolean, githubLinked?: boolean) =>
      computeGettingStarted({ ...empty, githubEnabled, githubLinked }).items.map((i) => i.key)
    expect(keys(false)).not.toContain('github')
    expect(keys(false, false)).not.toContain('github-profile')
    // undefined (probe in flight / failed) keeps the step — the hosted default
    expect(keys(undefined)).toContain('github')
    expect(keys(true)).toContain('github')
  })

  it('reaches allDone with a full ring when every signal is satisfied', () => {
    const gs = computeGettingStarted({
      agents: [
        agent({
          workspace: { mode: 'git', provider: 'github', repo: 'acme/x' } as Agent['workspace'],
          hookKinds: ['github']
        })
      ],
      daemons: [daemon('online')],
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1', statusLabel: 'completed' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto],
      authOn: true,
      sessionAccessReviewed: true
    })
    expect(gs.allDone).toBe(true)
    expect(gs.fraction).toBe(1)
    // dash length equals the full circumference (2π·10.5 ≈ 65.97)
    expect(gs.ring.split(' ')[0]).toBe(gs.ring.split(' ')[1])
  })
})
