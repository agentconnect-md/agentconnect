// The repository selector's installation rosters (multi-repository-workspaces.md, The selector), read through the picker's page cache.
import {
  REPLY_BUDGET,
  REPO_CANDIDATE_DESCRIPTION_MAX,
  REPO_CANDIDATES_MAX,
  RepoCandidate,
  type RepoCandidatesReply
} from '@agentconnect.md/protocol'
import type {
  AgentInstallationAuthorizationRepo,
  AgentRecord,
  AgentRepoAuthorizationRepo,
  GithubInstallationRecord,
  GithubInstallationRepo
} from '../persistence/ports.js'
import type { GithubService } from './service.js'

const PAGE_SIZE = 100
const PAGE_CONCURRENCY = 4
// One installation's walk reads at most this many pages; a longer roster sets `partial`.
export const ROSTER_MAX_PAGES = 20

type RosterRepo = Awaited<ReturnType<GithubService['listRepos']>>['repos'][number]

export interface InstallationRoster {
  repos: readonly RosterRepo[]
  complete: boolean
}

export interface RepoCandidatesDeps {
  installationAuths: Pick<AgentInstallationAuthorizationRepo, 'listForAgent'>
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  installations: Pick<GithubInstallationRepo, 'listForOrg'>
  github: Pick<GithubService, 'listRepos'>
}

export class RepoCandidatesService {
  constructor(private readonly deps: RepoCandidatesDeps) {}

  async forAgent(
    agent: Pick<AgentRecord, 'id' | 'orgId' | 'workspace' | 'workspaceRepoId'>
  ): Promise<RepoCandidatesReply> {
    const grants = (await this.deps.installationAuths.listForAgent(agent.id)).filter(
      (grant) => grant.provider === 'github' && grant.materialize === 'decision'
    )
    if (grants.length === 0) return { candidates: [], partial: false }
    const [rows, claimed] = await Promise.all([
      this.deps.repoAuths.listForAgent(agent.id),
      this.deps.installations.listForOrg(agent.orgId)
    ])
    // Only this organization's live claims have a roster; a suspended or revoked one covers nothing it could mint.
    const live = new Map(
      claimed.filter((ins) => !ins.revokedAt && !ins.suspendedAt).map((ins) => [ins.installationId, ins])
    )
    const rosters = await Promise.all(
      grants.flatMap((grant) => {
        const ins = live.get(grant.installationId)
        return ins ? [this.roster(ins)] : []
      })
    )
    // A repository with its own row follows that row, and the workspace repository is always present.
    const excluded = new Set(rows.filter((row) => row.provider === 'github').map((row) => row.repoId.toString()))
    const workspace = agent.workspace
    if (workspace.mode === 'git' && workspace.credential?.provider === 'github' && agent.workspaceRepoId !== undefined)
      excluded.add(agent.workspaceRepoId.toString())
    return repoCandidatesReply(rosters, excluded)
  }

  private async roster(ins: GithubInstallationRecord): Promise<InstallationRoster> {
    const first = await this.deps.github.listRepos(ins, 1, PAGE_SIZE)
    const pages = Math.ceil(first.totalCount / PAGE_SIZE)
    // A short first page is the whole roster, whatever the count says.
    const whole = first.repos.length < PAGE_SIZE
    const last = whole ? 1 : Math.min(pages, ROSTER_MAX_PAGES)
    const repos = [...first.repos]
    for (let page = 2; page <= last; page += PAGE_CONCURRENCY) {
      const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, last - page + 1) }, (_, i) =>
        this.deps.github.listRepos(ins, page + i, PAGE_SIZE)
      )
      for (const next of await Promise.all(batch)) repos.push(...next.repos)
    }
    return { repos, complete: whole || pages <= ROSTER_MAX_PAGES }
  }
}

/** The reply over walked rosters: most recent push first, deduplicated, and cut to the count and frame bounds. */
export function repoCandidatesReply(
  rosters: readonly InstallationRoster[],
  excluded: ReadonlySet<string>
): RepoCandidatesReply {
  const seen = new Set<string>()
  const entries: RepoCandidate[] = []
  for (const repo of rosters.flatMap((roster) => roster.repos)) {
    const parsed = RepoCandidate.safeParse(candidateOf(repo))
    if (!parsed.success || excluded.has(parsed.data.repoId) || seen.has(parsed.data.repoId)) continue
    seen.add(parsed.data.repoId)
    entries.push(parsed.data)
  }
  entries.sort(byMostRecentPush)
  let partial = rosters.some((roster) => !roster.complete)
  const candidates: RepoCandidate[] = []
  let bytes = Buffer.byteLength(JSON.stringify({ candidates, partial: true }), 'utf8')
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (candidates.length === REPO_CANDIDATES_MAX || bytes + size > REPLY_BUDGET) {
      partial = true
      break
    }
    candidates.push(entry)
    bytes += size
  }
  return { candidates, partial }
}

function candidateOf(repo: RosterRepo): RepoCandidate {
  const pushedAt = repo.pushed_at ? Date.parse(repo.pushed_at) : Number.NaN
  return {
    provider: 'github',
    repoFullName: repo.full_name,
    repoId: String(repo.id),
    ...(repo.description ? { description: cut(repo.description, REPO_CANDIDATE_DESCRIPTION_MAX) } : {}),
    ...(Number.isFinite(pushedAt) ? { pushedAt: new Date(pushedAt).toISOString() } : {})
  }
}

// Never ends on half a surrogate pair.
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

function byMostRecentPush(a: RepoCandidate, b: RepoCandidate): number {
  if (a.pushedAt !== b.pushedAt) {
    if (a.pushedAt === undefined) return 1
    if (b.pushedAt === undefined) return -1
    return a.pushedAt < b.pushedAt ? 1 : -1
  }
  if (a.repoFullName !== b.repoFullName) return a.repoFullName < b.repoFullName ? -1 : 1
  return a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0
}
