// Azure DevOps structured pull-request broker (azure-devops-integration.md §6.6): allowlisted calls under the repository's proxy lease, never an arbitrary path or body.
import { AZURE_DEVOPS_HOST, type AzureDevOpsRepoRouting } from '@agentconnect.md/protocol'
import {
  AuthoredCommentLedger,
  bool,
  branch,
  BROKER_MERGE_METHODS,
  brokerCall,
  changeLists,
  compact,
  enforceCapability,
  int,
  labelNames,
  limited,
  MAX_NOTE_BODY_CHARS,
  record,
  renderPath,
  requireDecimal,
  str,
  type BrokerEndpoint,
  type BrokerLease,
  type BrokerMergeMethod,
  type CodeHostBrokerOperation,
  type CodeHostEffectBroker,
  type CodeHostEffectTarget
} from '../codehost/broker.js'

const REPOSITORY = '/:organization/:projectId/_apis/git/repositories/:repositoryId'
const PULL = `${REPOSITORY}/pullrequests/:id`

/** THE allowlist: every call renders one of these templates below the one repository the lease names. */
export const AZURE_DEVOPS_BROKER_ENDPOINTS = {
  'pull.get': { method: 'GET', capability: 'read', path: PULL },
  'thread.list': { method: 'GET', capability: 'read', path: `${PULL}/threads` },
  'thread.get': { method: 'GET', capability: 'read', path: `${PULL}/threads/:threadId` },
  'thread.create': { method: 'POST', capability: 'comment', path: `${PULL}/threads` },
  'comment.create': { method: 'POST', capability: 'comment', path: `${PULL}/threads/:threadId/comments` },
  'comment.update': { method: 'PATCH', capability: 'comment', path: `${PULL}/threads/:threadId/comments/:commentId` },
  'pull.create': { method: 'POST', capability: 'write', path: `${REPOSITORY}/pullrequests` },
  'pull.update': { method: 'PATCH', capability: 'write', path: PULL },
  'label.add': { method: 'POST', capability: 'write', path: `${PULL}/labels` },
  'label.remove': { method: 'DELETE', capability: 'write', path: `${PULL}/labels/:label` }
} as const satisfies Record<string, BrokerEndpoint>

export type AzureDevOpsBrokerEndpointId = keyof typeof AZURE_DEVOPS_BROKER_ENDPOINTS

const API_VERSION = '7.1'

/** A proxy lease, with the drop that makes the next ask refresh it after Azure DevOps rejects it. */
export interface AzureDevOpsLease extends BrokerLease {
  invalidate?: () => void
}

export interface AzureDevOpsBrokerDeps {
  /** The repository's proxy lease at the agent's tier; the token is the organization's, so the allowlist is what scopes it. */
  lease: (target: CodeHostEffectTarget) => Promise<AzureDevOpsLease>
  /** §11.5: in a hook turn, the hook's own lease at `comment`, which raises a repository held at `read` for comment calls. */
  hookLease?: (target: CodeHostEffectTarget & { hookId: string }) => Promise<AzureDevOpsLease>
  /** The organization, project and repository GUIDs of the target, from the agent's spec. */
  routing: (target: CodeHostEffectTarget) => AzureDevOpsRepoRouting | undefined
  fetchImpl?: typeof fetch
}

// Azure DevOps's own strategies: a merge commit, a squash, or a rebase fast-forwarded onto the target.
const MERGE_STRATEGY: Record<BrokerMergeMethod, string> = {
  merge: 'noFastForward',
  squash: 'squash',
  rebase: 'rebase'
}

/** A text comment, the only kind the broker writes. */
const TEXT = 1
/** A thread opens active, as the web UI opens one. */
const ACTIVE = 1
/** The first comment of a thread: what `createComment` posts, and what a reply answers and an update rewrites. */
const FIRST_COMMENT = '1'

const HEADS = 'refs/heads/'

function branchName(ref: unknown): string | undefined {
  const name = str(ref, 255)
  return name?.startsWith(HEADS) ? name.slice(HEADS.length) : name
}

function headRef(value: string, label: string): string {
  return `${HEADS}${branch(value.startsWith(HEADS) ? value.slice(HEADS.length) : value, label)}`
}

function identity(raw: unknown): string | undefined {
  const person = record(raw)
  return str(person.uniqueName, 200) ?? str(person.displayName, 200)
}

function pullResult(raw: unknown): Record<string, unknown> {
  const pull = record(raw)
  const number = int(pull.pullRequestId)
  const webUrl = str(record(pull.repository).webUrl, 500)
  // Only a create answers with labels; elsewhere their absence says nothing about them.
  const labels = Array.isArray(pull.labels) ? pull.labels.slice(0, 20) : undefined
  return compact({
    number,
    title: str(pull.title, 500),
    status: str(pull.status, 40),
    draft: bool(pull.isDraft),
    mergeStatus: str(pull.mergeStatus, 40),
    author: identity(pull.createdBy),
    labels: labels
      ?.filter((label) => record(label).active !== false)
      .map((label) => str(record(label).name, 100))
      .filter((name) => name !== undefined),
    head: branchName(pull.sourceRefName),
    headSha: str(record(pull.lastMergeSourceCommit).commitId, 64),
    base: branchName(pull.targetRefName),
    htmlUrl: webUrl && number !== undefined ? `${webUrl}/pullrequest/${number}` : undefined,
    createdAt: str(pull.creationDate, 40),
    closedAt: str(pull.closedDate, 40)
  })
}

function commentResult(raw: unknown): Record<string, unknown> {
  const comment = record(raw)
  return compact({
    id: int(comment.id),
    author: identity(comment.author),
    body: str(comment.content, MAX_NOTE_BODY_CHARS),
    type: str(comment.commentType, 40),
    publishedAt: str(comment.publishedDate, 40)
  })
}

function threadResult(raw: unknown, limit?: number): Record<string, unknown> {
  const thread = record(raw)
  const comments = (Array.isArray(thread.comments) ? thread.comments : []).filter(
    (comment) => record(comment).isDeleted !== true
  )
  return compact({
    id: int(thread.id),
    status: str(thread.status, 40),
    filePath: str(record(thread.threadContext).filePath, 500),
    comments: comments.slice(0, Number(limited(limit))).map(commentResult)
  })
}

/** The newest threads, which the review conversation ends with; Azure DevOps lists them oldest first. */
function threadList(raw: unknown, limit: number | undefined): Record<string, unknown>[] {
  const threads = Array.isArray(record(raw).value) ? (record(raw).value as unknown[]) : []
  return threads.slice(-Number(limited(limit))).map((thread) => threadResult(thread))
}

/** What `createComment` and a reply answer: the thread id is the comment's handle for `update` and `reply`. */
function postedComment(threadId: string, raw: unknown): Record<string, unknown> {
  return { comment: compact({ ...commentResult(raw), id: Number(threadId), threadId: Number(threadId) }) }
}

/** A full commit sha: Azure DevOps completes only when the source still ends there. */
function headSha(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('sha must be a full commit sha')
  return value.toLowerCase()
}

function pullRequestOnly(subject: string): void {
  if (subject !== 'merge_request')
    throw new Error('Azure DevOps work items are not repository issues: comment on a pull request instead')
}

function refusePeople(op: { assignees?: string[]; reviewers?: string[] }): void {
  if (op.assignees !== undefined && op.assignees.length > 0)
    throw new Error('Azure DevOps pull requests have no assignees')
  if (op.reviewers !== undefined && op.reviewers.length > 0)
    throw new Error('requesting reviewers is not available through this tool on Azure DevOps')
}

/** One allowlisted call of a plan: the endpoint, its rendered path params, and the bounded payload. */
interface PlannedCall {
  endpoint: AzureDevOpsBrokerEndpointId
  params: Record<string, string>
  body?: Record<string, unknown>
  missingOk?: boolean
}

type Caller = (call: PlannedCall) => Promise<unknown>

/** One resolved operation: every endpoint it may use, clamp-checked before its first request, and the run issuing them. */
interface BrokerPlan {
  uses: AzureDevOpsBrokerEndpointId[]
  run: (call: Caller) => Promise<unknown>
}

function covers(lease: BrokerLease, endpoint: BrokerEndpoint): boolean {
  try {
    enforceCapability(lease, endpoint, 'Azure DevOps repository')
    return true
  } catch {
    return false
  }
}

function using(...ids: (AzureDevOpsBrokerEndpointId | false)[]): AzureDevOpsBrokerEndpointId[] {
  return ids.filter((id): id is AzureDevOpsBrokerEndpointId => id !== false)
}

export class AzureDevOpsBroker implements CodeHostEffectBroker {
  private readonly authored = new AuthoredCommentLedger()

  constructor(private readonly deps: AzureDevOpsBrokerDeps) {}

  async execute(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): Promise<unknown> {
    const routing = this.deps.routing(target)
    if (!routing) throw new Error(`repository ${target.repoPath ?? target.repoId} is not authorized for this agent`)
    const plan = this.plan(target, routing, op)
    const source = await this.leaseSource(target, plan.uses)
    const lease = await source()
    for (const id of plan.uses) this.enforce(lease, AZURE_DEVOPS_BROKER_ENDPOINTS[id])
    return plan.run(async (call) => {
      if (!plan.uses.includes(call.endpoint)) throw new Error(`broker plan used undeclared endpoint ${call.endpoint}`)
      return this.call(target, call, lease, source)
    })
  }

  /** The agent's own lease, or in a hook turn the hook's for a plan its own tier does not cover and `comment` does; a write always needs the agent's own. */
  private async leaseSource(
    target: CodeHostEffectTarget,
    uses: AzureDevOpsBrokerEndpointId[]
  ): Promise<() => Promise<AzureDevOpsLease>> {
    const own = () => this.deps.lease(target)
    const hookId = target.hookId
    const hookLease = this.deps.hookLease
    const writes = uses.some((id) => AZURE_DEVOPS_BROKER_ENDPOINTS[id].capability === 'write')
    if (hookId === undefined || !hookLease || writes) return own
    const held = await own().catch(() => undefined)
    if (held && uses.every((id) => covers(held, AZURE_DEVOPS_BROKER_ENDPOINTS[id]))) return own
    return () => hookLease({ ...target, hookId })
  }

  private enforce(lease: BrokerLease, endpoint: BrokerEndpoint): void {
    enforceCapability(lease, endpoint, 'Azure DevOps repository')
  }

  private plan(target: CodeHostEffectTarget, routing: AzureDevOpsRepoRouting, op: CodeHostBrokerOperation): BrokerPlan {
    const at = { ...routing }
    const scope = { sessionKey: target.sessionKey, repo: target.repoId }
    switch (op.kind) {
      case 'readMergeRequestDescription':
        return {
          uses: ['pull.get'],
          run: async (call) =>
            record(await call({ endpoint: 'pull.get', params: { ...at, id: String(op.iid) } })).description ?? ''
        }
      case 'createComment': {
        pullRequestOnly(op.subject)
        const params = { ...at, id: String(op.iid) }
        return {
          uses: ['thread.create'],
          run: async (call) => {
            const created = record(
              await call({
                endpoint: 'thread.create',
                params,
                body: { comments: [{ parentCommentId: 0, content: op.body, commentType: TEXT }], status: ACTIVE }
              })
            )
            const first = Array.isArray(created.comments) ? created.comments[0] : undefined
            const threadId = int(created.id)
            if (threadId === undefined) return { comment: commentResult(first) }
            // The single-writer ledger: `updateComment` may touch only a thread this session opened.
            this.authored.remember(scope, String(threadId))
            return postedComment(String(threadId), first)
          }
        }
      }
      case 'updateComment': {
        pullRequestOnly(op.subject)
        const threadId = requireDecimal(op.noteId, 'commentId')
        if (!this.authored.has(scope, threadId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        const params = { ...at, id: String(op.iid), threadId, commentId: FIRST_COMMENT }
        return {
          uses: ['comment.update'],
          run: async (call) =>
            postedComment(threadId, await call({ endpoint: 'comment.update', params, body: { content: op.body } }))
        }
      }
      case 'replyDiscussion': {
        pullRequestOnly(op.subject)
        const threadId = requireDecimal(op.discussionId, 'discussionId')
        const params = { ...at, id: String(op.iid), threadId }
        const body = { parentCommentId: Number(FIRST_COMMENT), content: op.body, commentType: TEXT }
        return {
          uses: ['comment.create'],
          run: async (call) => postedComment(threadId, await call({ endpoint: 'comment.create', params, body }))
        }
      }
      case 'readDiscussions': {
        pullRequestOnly(op.subject)
        const params = { ...at, id: String(op.iid) }
        if (op.discussionId !== undefined) {
          const threadId = requireDecimal(op.discussionId, 'discussionId')
          return {
            uses: ['thread.get'],
            run: async (call) => ({
              thread: threadResult(await call({ endpoint: 'thread.get', params: { ...params, threadId } }), op.limit)
            })
          }
        }
        return {
          uses: ['pull.get', 'thread.list'],
          run: async (call) => {
            const pull = await call({ endpoint: 'pull.get', params })
            const threads = await call({ endpoint: 'thread.list', params })
            return { pullRequest: pullResult(pull), threads: threadList(threads, op.limit) }
          }
        }
      }
      case 'createMergeRequest': {
        refusePeople(op)
        const labels = op.labels === undefined ? undefined : labelNames(op.labels)
        const body = compact({
          sourceRefName: headRef(op.sourceBranch, 'sourceBranch'),
          targetRefName: headRef(op.targetBranch, 'targetBranch'),
          title: op.title,
          description: op.description,
          isDraft: op.draft,
          labels: labels?.map((name) => ({ name }))
        })
        return {
          uses: ['pull.create'],
          run: async (call) => ({
            pullRequest: pullResult(await call({ endpoint: 'pull.create', params: { ...at }, body }))
          })
        }
      }
      case 'updateMergeRequest': {
        refusePeople(op)
        const changes = changeLists(op)
        if (changes.addAssignees.length > 0 || changes.removeAssignees.length > 0)
          throw new Error('Azure DevOps pull requests have no assignees')
        const params = { ...at, id: String(op.iid) }
        const fields = compact({
          title: op.title,
          description: op.description,
          targetRefName: op.targetBranch === undefined ? undefined : headRef(op.targetBranch, 'targetBranch'),
          isDraft: op.draft
        })
        const edits = Object.keys(fields).length > 0
        if (!edits && changes.addLabels.length === 0 && changes.removeLabels.length === 0)
          throw new Error('nothing to update')
        return {
          uses: using(
            changes.addLabels.length > 0 && 'label.add',
            changes.removeLabels.length > 0 && 'label.remove',
            edits && 'pull.update',
            !edits && 'pull.get'
          ),
          run: async (call) => {
            for (const name of changes.addLabels) await call({ endpoint: 'label.add', params, body: { name } })
            for (const label of changes.removeLabels)
              await call({ endpoint: 'label.remove', params: { ...params, label }, missingOk: true })
            const pull = edits
              ? await call({ endpoint: 'pull.update', params, body: fields })
              : await call({ endpoint: 'pull.get', params })
            return { pullRequest: pullResult(pull) }
          }
        }
      }
      case 'mergeMergeRequest': {
        if (op.method !== undefined && !BROKER_MERGE_METHODS.includes(op.method)) {
          throw new Error(`method must be one of ${BROKER_MERGE_METHODS.join(', ')}`)
        }
        const params = { ...at, id: String(op.iid) }
        const fenced = op.sha === undefined ? undefined : headSha(op.sha)
        const completionOptions = { mergeStrategy: MERGE_STRATEGY[op.method ?? 'merge'] }
        return {
          uses: ['pull.get', 'pull.update'],
          run: async (call) => {
            // Azure DevOps accepts a completion at another commit and silently never runs it, so the source is read and checked first.
            const current = record(await call({ endpoint: 'pull.get', params }))
            const commitId = str(record(current.lastMergeSourceCommit).commitId, 64)?.toLowerCase()
            if (current.status !== 'active')
              throw new Error(`the pull request is ${str(current.status, 40) ?? 'not active'}`)
            if (!commitId) throw new Error('Azure DevOps returned no source commit to complete the pull request at')
            if (fenced !== undefined && fenced !== commitId)
              throw new Error(`the pull request's source is now at ${commitId}, not ${fenced}`)
            const body = { status: 'completed', lastMergeSourceCommit: { commitId }, completionOptions }
            return { pullRequest: pullResult(await call({ endpoint: 'pull.update', params, body })) }
          }
        }
      }
      case 'setState': {
        pullRequestOnly(op.subject)
        if (op.state !== 'open' && op.state !== 'closed') throw new Error('state must be open or closed')
        const params = { ...at, id: String(op.iid) }
        const body = { status: op.state === 'closed' ? 'abandoned' : 'active' }
        return {
          uses: ['pull.update'],
          run: async (call) => ({ pullRequest: pullResult(await call({ endpoint: 'pull.update', params, body })) })
        }
      }
      case 'createIssue':
      case 'updateIssue':
        throw new Error('Azure DevOps work items are not repository issues and are not available through this broker')
      case 'inspectPipelines':
      case 'controlPipeline':
        throw new Error('Azure Pipelines are not available through this broker')
    }
  }

  /** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
  private call(
    target: CodeHostEffectTarget,
    call: PlannedCall,
    lease: AzureDevOpsLease,
    source: () => Promise<AzureDevOpsLease>
  ): Promise<unknown> {
    const endpoint = AZURE_DEVOPS_BROKER_ENDPOINTS[call.endpoint]
    const path = renderPath(endpoint.path, call.params)
    return brokerCall(
      {
        // A rejected token answers 401 rather than a sign-in page.
        headers: (token) => ({
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-tfs-fedauthredirect': 'Suppress'
        }),
        lease: source,
        invalidateLease: (token: string) => {
          if (token === lease.token) lease.invalidate?.()
        },
        enforce: (fresh) => this.enforce(fresh, endpoint),
        host: 'Azure DevOps',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      lease,
      {
        method: endpoint.method,
        url: `https://${AZURE_DEVOPS_HOST}${path}?api-version=${API_VERSION}`,
        ...(call.body !== undefined ? { body: call.body } : {}),
        ...(call.missingOk ? { missingOk: true } : {})
      }
    )
  }
}
