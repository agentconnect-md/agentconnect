import { describe, expect, it, vi } from 'vitest'
import {
  REPLY_BUDGET,
  REPO_CANDIDATE_DESCRIPTION_MAX,
  REPO_CANDIDATES_MAX,
  RepoCandidatesReply
} from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentInstallationAuthorizationRecord,
  AgentRepoAuthorizationRecord,
  GithubInstallationRecord
} from '../persistence/ports.js'
import { ROSTER_MAX_PAGES, RepoCandidatesService, repoCandidatesReply } from './repo-candidates.js'

const ORG = OrgId('example-org')
const AGENT = {
  id: AgentId('77777777-7777-4777-8777-777777777777'),
  orgId: ORG,
  workspace: { mode: 'scratch' as const },
  workspaceRepoId: undefined
}

function installation(installationId: bigint, over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: `installation-${installationId}`,
    orgId: ORG,
    installationId,
    accountLogin: `account-${installationId}`,
    accountType: 'Organization',
    repositorySelection: 'all',
    suspendedAt: null,
    permissions: { metadata: 'read' },
    revokedAt: null,
    createdAt: new Date(0),
    ...over
  }
}

function grant(
  installationId: bigint,
  materialize: AgentInstallationAuthorizationRecord['materialize'] = 'decision'
): AgentInstallationAuthorizationRecord {
  return {
    id: `grant-${installationId}`,
    agentId: AGENT.id,
    provider: 'github',
    installationId,
    accountLogin: `account-${installationId}`,
    access: 'read',
    materialize,
    createdAt: new Date(0),
    createdBy: null
  }
}

function row(repoId: bigint): AgentRepoAuthorizationRecord {
  return {
    id: `row-${repoId}`,
    agentId: AGENT.id,
    provider: 'github',
    repoId,
    repoFullName: `acme/row-${repoId}`,
    access: 'read',
    materialize: 'always',
    createdAt: new Date(0),
    createdBy: null
  }
}

function repo(id: number, pushedAt: string | null = null, description: string | null = null) {
  return {
    id: String(id),
    full_name: `acme/repo-${id}`,
    private: true,
    default_branch: 'main',
    description,
    pushed_at: pushedAt
  }
}

type Repo = ReturnType<typeof repo>

function service(input: {
  grants: AgentInstallationAuthorizationRecord[]
  installations: GithubInstallationRecord[]
  rosters: Map<bigint, Repo[]>
  rows?: AgentRepoAuthorizationRecord[]
}) {
  const listRepos = vi.fn(async (ins: GithubInstallationRecord, page: number, perPage: number) => {
    const all = input.rosters.get(ins.installationId) ?? []
    return { repos: all.slice((page - 1) * perPage, page * perPage), totalCount: all.length }
  })
  const listRows = vi.fn(async () => input.rows ?? [])
  const listForOrg = vi.fn(async () => input.installations)
  const svc = new RepoCandidatesService({
    installationAuths: { listForAgent: async () => input.grants },
    repoAuths: { listForAgent: listRows },
    installations: { listForOrg },
    github: { listRepos }
  })
  return { svc, listRepos, listRows, listForOrg }
}

const roster = (repos: Repo[], complete = true) => ({ repos, complete })

describe('repository selector candidates (multi-repository-workspaces.md, The selector)', () => {
  it('answers empty without reading anything when no grant is marked decision', async () => {
    const { svc, listRepos, listRows, listForOrg } = service({
      grants: [grant(1n, 'on-demand')],
      installations: [installation(1n)],
      rosters: new Map([[1n, [repo(1)]]])
    })
    await expect(svc.forAgent(AGENT)).resolves.toEqual({ candidates: [], partial: false })
    expect(listRepos).not.toHaveBeenCalled()
    expect(listRows).not.toHaveBeenCalled()
    expect(listForOrg).not.toHaveBeenCalled()
  })

  it('reads only the decision grants, most recent push first, with description and pushed-at passed through', async () => {
    const { svc, listRepos } = service({
      grants: [grant(1n), grant(2n, 'on-demand')],
      installations: [installation(1n), installation(2n)],
      rosters: new Map([
        [1n, [repo(10, '2026-09-01T10:00:00Z', 'Build tooling'), repo(11, '2026-09-20T08:30:00Z'), repo(12)]],
        [2n, [repo(20, '2026-09-24T00:00:00Z')]]
      ])
    })
    const reply = await svc.forAgent(AGENT)
    expect(RepoCandidatesReply.parse(reply)).toEqual(reply)
    expect(reply).toEqual({
      candidates: [
        { provider: 'github', repoFullName: 'acme/repo-11', repoId: '11', pushedAt: '2026-09-20T08:30:00.000Z' },
        {
          provider: 'github',
          repoFullName: 'acme/repo-10',
          repoId: '10',
          description: 'Build tooling',
          pushedAt: '2026-09-01T10:00:00.000Z'
        },
        { provider: 'github', repoFullName: 'acme/repo-12', repoId: '12' }
      ],
      partial: false
    })
    expect(listRepos.mock.calls.map(([ins]) => ins.installationId)).toEqual([1n])
  })

  it('leaves out repositories with their own row and the GitHub workspace repository', async () => {
    const { svc } = service({
      grants: [grant(1n)],
      installations: [installation(1n)],
      rosters: new Map([[1n, [repo(1), repo(2), repo(3), repo(4)]]]),
      rows: [row(2n), { ...row(3n), provider: 'gitlab' }]
    })
    const workspace = {
      mode: 'git' as const,
      gitRepo: 'https://github.com/acme/repo-4',
      credential: { provider: 'github' as const, installationId: 'installation-1', access: 'write' as const }
    }
    const reply = await svc.forAgent({ ...AGENT, workspace, workspaceRepoId: 4n })
    // A gitlab row numbers a different repository, so the GitHub repository with that id stays a candidate.
    expect(reply.candidates.map((candidate) => candidate.repoId)).toEqual(['1', '3'])
  })

  it('skips a grant whose installation is suspended, revoked, or not this organization’s', async () => {
    const { svc, listRepos } = service({
      grants: [grant(1n), grant(2n), grant(3n), grant(4n)],
      installations: [
        installation(1n, { suspendedAt: new Date(0) }),
        installation(2n, { revokedAt: new Date(0) }),
        installation(4n)
      ],
      rosters: new Map([
        [1n, [repo(1)]],
        [2n, [repo(2)]],
        [3n, [repo(3)]],
        [4n, [repo(4)]]
      ])
    })
    await expect(svc.forAgent(AGENT)).resolves.toEqual({
      candidates: [{ provider: 'github', repoFullName: 'acme/repo-4', repoId: '4' }],
      partial: false
    })
    expect(listRepos.mock.calls.map(([ins]) => ins.installationId)).toEqual([4n])
  })

  it('walks every page of a roster and stops at the page bound with partial set', async () => {
    const pages = (count: number) => Array.from({ length: count }, (_, i) => repo(i + 1, null))
    const whole = service({
      grants: [grant(1n)],
      installations: [installation(1n)],
      rosters: new Map([[1n, pages(250)]])
    })
    const reply = await whole.svc.forAgent(AGENT)
    expect(whole.listRepos.mock.calls.map(([, page, perPage]) => [page, perPage])).toEqual([
      [1, 100],
      [2, 100],
      [3, 100]
    ])
    expect(reply.partial).toBe(false)
    expect(reply.candidates).toHaveLength(250)

    const long = service({
      grants: [grant(1n)],
      installations: [installation(1n)],
      rosters: new Map([[1n, pages(ROSTER_MAX_PAGES * 100 + 1)]])
    })
    const cut = await long.svc.forAgent(AGENT)
    expect(long.listRepos).toHaveBeenCalledTimes(ROSTER_MAX_PAGES)
    expect(cut.partial).toBe(true)
    expect(cut.candidates).toHaveLength(REPO_CANDIDATES_MAX)
  })

  it('bounds the reply to 512 candidates and sets partial only when the bound cut some', () => {
    const repos = Array.from({ length: REPO_CANDIDATES_MAX + 1 }, (_, i) =>
      repo(i + 1, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString())
    )
    const exact = repoCandidatesReply([roster(repos.slice(1))], new Set())
    expect(exact).toMatchObject({ partial: false })
    expect(exact.candidates).toHaveLength(REPO_CANDIDATES_MAX)
    const over = repoCandidatesReply([roster(repos)], new Set())
    expect(over.partial).toBe(true)
    expect(over.candidates).toHaveLength(REPO_CANDIDATES_MAX)
    // The oldest push is the one the bound drops.
    expect(over.candidates.map((candidate) => candidate.repoId)).not.toContain('1')
    expect(over.candidates[0]!.repoId).toBe(String(REPO_CANDIDATES_MAX + 1))
  })

  it('keeps the reply within one frame and cuts a description at the wire limit', () => {
    // Two UTF-8 bytes a character, so 512 full descriptions exceed one frame.
    const long = 'é'.repeat(REPO_CANDIDATE_DESCRIPTION_MAX + 50)
    const reply = repoCandidatesReply(
      [roster(Array.from({ length: REPO_CANDIDATES_MAX }, (_, i) => repo(i + 1, null, long)))],
      new Set()
    )
    expect(reply.partial).toBe(true)
    expect(reply.candidates.length).toBeLessThan(REPO_CANDIDATES_MAX)
    expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThanOrEqual(REPLY_BUDGET)
    expect(reply.candidates[0]!.description).toHaveLength(REPO_CANDIDATE_DESCRIPTION_MAX)
    // The cut would land inside the last emoji's surrogate pair, so it drops that half.
    const pair = 'a' + '😀'.repeat(REPO_CANDIDATE_DESCRIPTION_MAX)
    const [emoji] = repoCandidatesReply([roster([repo(1, null, pair)])], new Set()).candidates
    expect(emoji!.description!.length).toBe(REPO_CANDIDATE_DESCRIPTION_MAX - 1)
    expect(emoji!.description!.endsWith('😀')).toBe(true)
  })

  it('carries an incomplete roster through as partial, deduplicates, and drops an entry the wire refuses', () => {
    const reply = repoCandidatesReply(
      [roster([repo(1), repo(2)], false), roster([repo(2), { ...repo(3), id: 'not-a-number' }])],
      new Set()
    )
    expect(reply).toEqual({
      candidates: [
        { provider: 'github', repoFullName: 'acme/repo-1', repoId: '1' },
        { provider: 'github', repoFullName: 'acme/repo-2', repoId: '2' }
      ],
      partial: true
    })
  })
})
