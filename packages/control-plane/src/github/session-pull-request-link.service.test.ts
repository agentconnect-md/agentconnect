// `SessionPullRequestLinkService` — the head-branch identity source (webchat-side-panels.md §12.6):
// which PR a branch means, which sessions never reach GitHub at all, and the two TTLs. GitHub is a
// scripted `fetchImpl`; no network, no Postgres.
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import {
  SessionPullRequestLinkService,
  chooseHeadPull,
  SESSION_PR_LINK_TTL_MS,
  SESSION_PR_LINK_MISS_TTL_MS,
  type HeadPull
} from './session-pull-request-link.service.js'
import type { GithubService } from './service.js'
import type { InstallationTokenService } from './installation-token.service.js'
import type { FetchLike } from './api.js'
import type { AgentRecord, SessionMetaRecord } from '../persistence/ports.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'

const AGENT = { id: AgentId('agent-1'), orgId: OrgId('org_a') } as unknown as AgentRecord

const SESSION = {
  id: SessionId('sess-1'),
  orgId: OrgId('org_a'),
  agentId: AgentId('agent-1'),
  workspaceIsolation: 'session',
  contentPurgedAt: null
} as unknown as SessionMetaRecord

const REPO = { repoId: 42n, repoFullName: 'acme/repo', installationId: 111n }

/** Which checkout the last branch read asked about — the scope is the service's own decision. */
const readBranchOf = (h: { readBranch: ReturnType<typeof vi.fn> }): unknown => h.readBranch.mock.calls.at(-1)?.[2]

const pull = (number: number, state: string, ref = 'dev/jane/panel'): HeadPull => ({
  number,
  state,
  head: { ref }
})

function harness(opts: {
  pulls?: HeadPull[][]
  branch?: string | null
  repo?: typeof REPO | null
  /** The agent's most recently active session; only the shared arm consults it. */
  latest?: string | null
}): {
  service: SessionPullRequestLinkService
  clock: FakeClock
  fetch: ReturnType<typeof vi.fn>
  readBranch: ReturnType<typeof vi.fn>
  resolveRepo: ReturnType<typeof vi.fn>
} {
  const clock = new FakeClock(1_760_000_000_000)
  const pages = [...(opts.pulls ?? [[pull(7, 'open')]])]
  const fetch = vi.fn(async () => {
    const next = pages.shift() ?? []
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const readBranch = vi.fn(async (_agent: AgentRecord, _session: SessionMetaRecord, _scope: string) =>
    opts.branch === undefined ? 'dev/jane/panel' : opts.branch
  )
  const resolveRepo = vi.fn(async () => (opts.repo === undefined ? REPO : opts.repo))
  const service = new SessionPullRequestLinkService({
    clock,
    github: { resolveWorkspaceRepo: resolveRepo } as unknown as GithubService,
    tokens: {
      mintPullRequestRead: async () => ({ token: 'ghs_test' })
    } as unknown as InstallationTokenService,
    readSessionBranch: readBranch,
    latestSessionIdOfAgent: async () => (opts.latest === undefined ? SESSION.id : opts.latest),
    fetchImpl: fetch as unknown as FetchLike
  })
  return { service, clock, fetch, readBranch, resolveRepo }
}

describe('chooseHeadPull', () => {
  it('prefers the FIRST open pull request and reports the ambiguity', () => {
    expect(chooseHeadPull([pull(9, 'open'), pull(4, 'open'), pull(2, 'closed')], 'dev/jane/panel')).toEqual({
      pullNumber: 4,
      ambiguous: true
    })
  })

  it('takes the newest closed attempt when none is open, without calling that ambiguous', () => {
    expect(chooseHeadPull([pull(3, 'closed'), pull(8, 'closed')], 'dev/jane/panel')).toEqual({
      pullNumber: 8,
      ambiguous: false
    })
  })

  it('is null for an empty answer, and drops a row whose head is another branch', () => {
    expect(chooseHeadPull([], 'dev/jane/panel')).toBeNull()
    expect(chooseHeadPull([pull(5, 'open', 'main')], 'dev/jane/panel')).toBeNull()
  })

  it('keeps a row that carries no head at all — the filter already narrowed it', () => {
    expect(chooseHeadPull([{ number: 5, state: 'open' }], 'dev/jane/panel')).toEqual({
      pullNumber: 5,
      ambiguous: false
    })
  })
})

describe('SessionPullRequestLinkService', () => {
  it('resolves the branch’s pull request and asks GitHub for that head only', async () => {
    const harnessed = harness({})
    const { service, fetch } = harnessed

    expect(await service.resolve(AGENT, SESSION)).toEqual({
      ...REPO,
      pullNumber: 7,
      branch: 'dev/jane/panel',
      scope: 'session',
      ambiguous: false
    })
    expect(readBranchOf(harnessed)).toBe('session')
    const url = String(fetch.mock.calls[0]![0])
    expect(url).toContain('/repos/acme/repo/pulls')
    expect(url).toContain(`head=${encodeURIComponent('acme:dev/jane/panel')}`)
    expect(url).toContain('state=all')
  })

  it('reads the agent’s PRIMARY checkout for a shared-workspace session, and says so', async () => {
    // The checkout the Files and Git tabs already show such a session. Refusing it left the tab
    // permanently empty for every shared-workspace agent; the `scope` is how the panel stays honest
    // about the PR not being exclusively this session's.
    const shared = harness({})

    const link = await shared.service.resolve(AGENT, { ...SESSION, workspaceIsolation: 'shared' } as SessionMetaRecord)

    expect(link).toMatchObject({ pullNumber: 7, scope: 'shared' })
    expect(readBranchOf(shared)).toBe('shared')
  })

  it('refuses the shared checkout for a session that is no longer the one using it', async () => {
    // The tree has ONE branch and it moves with the agent. Handing an older session the NEWEST
    // session's pull request — its checks, its threads — is worse than an empty tab.
    const stale = harness({ latest: 'sess-newer' })

    expect(
      await stale.service.resolve(AGENT, { ...SESSION, workspaceIsolation: 'shared' } as SessionMetaRecord)
    ).toBeNull()
    expect(stale.readBranch).not.toHaveBeenCalled()
    expect(stale.fetch).not.toHaveBeenCalled()
  })

  it('does not ask which session is current for a session worktree — its branch is its own', async () => {
    const own = harness({ latest: 'sess-newer' })

    expect((await own.service.resolve(AGENT, SESSION))?.scope).toBe('session')
  })

  it('spends NO GitHub call for a purged session or a branchless worktree', async () => {
    const purged = harness({})
    expect(
      await purged.service.resolve(AGENT, { ...SESSION, contentPurgedAt: new Date() } as SessionMetaRecord)
    ).toBeNull()
    expect(purged.readBranch).not.toHaveBeenCalled()

    // No branch ⇒ the repo is never even resolved: an offline daemon must not spend the installation's quota.
    const detached = harness({ branch: null })
    expect(await detached.service.resolve(AGENT, SESSION)).toBeNull()
    expect(detached.resolveRepo).not.toHaveBeenCalled()
    expect(detached.fetch).not.toHaveBeenCalled()
  })

  it('reads a denied GitHub answer as an absence, cached as a miss', async () => {
    const clock = new FakeClock(1_760_000_000_000)
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 }))
    const service = new SessionPullRequestLinkService({
      clock,
      github: { resolveWorkspaceRepo: async () => REPO } as unknown as GithubService,
      tokens: { mintPullRequestRead: async () => ({ token: 'ghs_test' }) } as unknown as InstallationTokenService,
      readSessionBranch: async () => 'dev/jane/panel',
      latestSessionIdOfAgent: async () => SESSION.id,
      fetchImpl: fetch as unknown as FetchLike
    })

    expect(await service.resolve(AGENT, SESSION)).toBeNull()
    expect(await service.resolve(AGENT, SESSION)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps transient capture failures retryable and ignores a panel miss cache', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      if (calls <= 2) return new Response(JSON.stringify({ message: 'try later' }), { status: 503 })
      return new Response(JSON.stringify([pull(7, 'open')]), { status: 200 })
    })
    const service = new SessionPullRequestLinkService({
      clock: new FakeClock(1_760_000_000_000),
      github: { resolveWorkspaceRepo: async () => REPO } as unknown as GithubService,
      tokens: { mintPullRequestRead: async () => ({ token: 'ghs_test' }) } as unknown as InstallationTokenService,
      readSessionBranch: async () => 'dev/jane/panel',
      latestSessionIdOfAgent: async () => SESSION.id,
      fetchImpl: fetch as unknown as FetchLike
    })

    expect(await service.resolve(AGENT, SESSION)).toBeNull()
    expect(await service.capture(AGENT, SESSION)).toEqual({ status: 'retry' })
    expect(await service.capture(AGENT, SESSION)).toMatchObject({ status: 'resolved', link: { pullNumber: 7 } })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('classifies an empty head lookup as a definitive capture absence', async () => {
    const { service, fetch } = harness({ pulls: [[]] })

    expect(await service.capture(AGENT, SESSION)).toEqual({ status: 'absent' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('holds a link for its TTL, a miss for the shorter one, and re-reads on force', async () => {
    const { service, clock, fetch } = harness({ pulls: [[pull(7, 'open')], [pull(9, 'open')], [pull(11, 'open')]] })

    expect((await service.resolve(AGENT, SESSION))?.pullNumber).toBe(7)
    clock.advance(SESSION_PR_LINK_TTL_MS - 1)
    expect((await service.resolve(AGENT, SESSION))?.pullNumber).toBe(7)
    expect(fetch).toHaveBeenCalledTimes(1)

    // The panel's refresh bypasses the live entry.
    expect((await service.resolve(AGENT, SESSION, true))?.pullNumber).toBe(9)
    clock.advance(SESSION_PR_LINK_TTL_MS)
    expect((await service.resolve(AGENT, SESSION))?.pullNumber).toBe(11)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('re-asks a miss after the miss TTL — a PR opened seconds ago must appear', async () => {
    const { service, clock, fetch } = harness({ pulls: [[], [pull(7, 'open')]] })

    expect(await service.resolve(AGENT, SESSION)).toBeNull()
    clock.advance(SESSION_PR_LINK_MISS_TTL_MS - 1)
    expect(await service.resolve(AGENT, SESSION)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    clock.advance(1)
    expect((await service.resolve(AGENT, SESSION))?.pullNumber).toBe(7)
  })

  it('shares one resolution between concurrent probes, forced or not', async () => {
    // A resolution is a daemon round trip plus a GitHub list; two panels mounting at once, or a read
    // racing the auto-merge write, must not each spend both.
    const { service, fetch, readBranch } = harness({ pulls: [[pull(7, 'open')]] })

    const [a, b, c] = await Promise.all([
      service.resolve(AGENT, SESSION),
      service.resolve(AGENT, SESSION),
      service.resolve(AGENT, SESSION, true)
    ])

    expect([a?.pullNumber, b?.pullNumber, c?.pullNumber]).toEqual([7, 7, 7])
    expect(readBranch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
