// GitHub's structured broker (github-app-git-credentials.md, Daemon-Mediated Agent Access): opening and editing a pull request, nothing else.
import {
  bool,
  branch,
  brokerCall,
  compact,
  enforceCapability,
  int,
  record,
  renderPath,
  str,
  type BrokerEndpoint,
  type BrokerLease,
  type CodeHostBrokerOperation,
  type CodeHostEffectBroker,
  type CodeHostEffectTarget
} from '../codehost/broker.js'
import { GITHUB_API_BASE, githubApiHeaders } from './rest.js'

/** THE allowlist: every call renders one of these templates; draft state moves only through GraphQL. */
export const GITHUB_BROKER_ENDPOINTS = {
  'pull.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/pulls/:number' },
  'pull.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/pulls' },
  'pull.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/pulls/:number' },
  'draft.set': { method: 'POST', capability: 'write', path: '/graphql' }
} as const satisfies Record<string, BrokerEndpoint>

type EndpointId = keyof typeof GITHUB_BROKER_ENDPOINTS

const TO_DRAFT =
  'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
const TO_READY =
  'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'

export interface GithubBrokerDeps {
  /** The pull-request token for this target's repository, at the tier the agent's authorization earns. */
  lease: (target: CodeHostEffectTarget) => Promise<BrokerLease>
  /** Drop a cached token GitHub just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (target: CodeHostEffectTarget, token: string) => void
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/** The bounded view of a pull request the model reads back. */
function pullResult(raw: unknown): Record<string, unknown> {
  const pull = record(raw)
  return compact({
    number: int(pull.number),
    title: str(pull.title),
    state: str(pull.state, 50),
    draft: bool(pull.draft),
    htmlUrl: str(pull.html_url),
    sourceBranch: str(record(pull.head).ref),
    targetBranch: str(record(pull.base).ref)
  })
}

export class GithubBroker implements CodeHostEffectBroker {
  constructor(private readonly deps: GithubBrokerDeps) {}

  async execute(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): Promise<unknown> {
    const [owner, repo, ...rest] = (target.repoPath ?? '').split('/')
    if (!owner || !repo || rest.length > 0) throw new Error('this session has no GitHub repository to act on')
    const at = { owner, repo }
    switch (op.kind) {
      case 'createMergeRequest': {
        const lease = await this.lease(target, 'pull.create')
        const created = await this.call(target, lease, 'pull.create', at, {
          ...compact({
            title: op.title,
            head: branch(op.sourceBranch, 'sourceBranch'),
            base: branch(op.targetBranch, 'targetBranch'),
            body: op.description
          }),
          ...(op.draft ? { draft: true } : {})
        })
        return { pullRequest: pullResult(created) }
      }
      case 'updateMergeRequest': {
        const params = { ...at, number: String(op.iid) }
        const fields = compact({
          title: op.title,
          body: op.description,
          base: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch')
        })
        const edits = Object.keys(fields).length > 0
        const lease = await this.lease(target, edits || op.draft !== undefined ? 'pull.update' : 'pull.get')
        let pull = record(
          edits
            ? await this.call(target, lease, 'pull.update', params, fields)
            : await this.call(target, lease, 'pull.get', params)
        )
        if (op.draft !== undefined && bool(pull.draft) !== op.draft) {
          const id = str(pull.node_id)
          if (!id) throw new Error('GitHub returned a pull request without a node id')
          const answer = record(
            await this.call(
              target,
              lease,
              'draft.set',
              {},
              { query: op.draft ? TO_DRAFT : TO_READY, variables: { id } }
            )
          )
          if (Array.isArray(answer.errors) && answer.errors.length > 0) {
            const message = str(record(answer.errors[0]).message, 200) ?? 'unknown error'
            throw new Error(`GitHub could not change the draft state: ${message}`)
          }
          pull = { ...pull, draft: op.draft }
        }
        return { pullRequest: pullResult(pull) }
      }
      default:
        throw new Error(`GitHub ${op.kind} is not available through this broker`)
    }
  }

  private async lease(target: CodeHostEffectTarget, endpoint: EndpointId): Promise<BrokerLease> {
    const lease = await this.deps.lease(target)
    enforceCapability(lease, GITHUB_BROKER_ENDPOINTS[endpoint], 'GitHub repository')
    return lease
  }

  /** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
  private call(
    target: CodeHostEffectTarget,
    lease: BrokerLease,
    id: EndpointId,
    params: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const endpoint = GITHUB_BROKER_ENDPOINTS[id]
    return brokerCall(
      {
        headers: (token) => githubApiHeaders({ accept: 'application/vnd.github+json', token }),
        lease: () => this.deps.lease(target),
        ...(this.deps.invalidateLease
          ? { invalidateLease: (token: string) => this.deps.invalidateLease!(target, token) }
          : {}),
        enforce: (fresh) => enforceCapability(fresh, endpoint, 'GitHub repository'),
        host: 'GitHub',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      lease,
      {
        method: endpoint.method,
        url: `${this.deps.baseUrl ?? GITHUB_API_BASE}${renderPath(endpoint.path, params)}`,
        ...(body !== undefined ? { body } : {})
      }
    )
  }
}
