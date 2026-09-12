// Console "Run again" for gitea hooks (gitea-integration.md §10.4): fences revalidated live, head read now, dispatched via the relay.
import { randomUUID } from 'node:crypto'
import type { GiteaHookMetadata, RcHookRerun, RcHookRerunRefusal } from '@agentconnect.md/protocol'
import type { HookService } from '../hooks/hook.service.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import { AgentId, HookId } from '../domain/ids.js'
import type {
  AgentRecord,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRepo,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import {
  GiteaApiError,
  giteaIssue,
  giteaPullRequest,
  isGiteaAuthRejection,
  splitGiteaRepoPath,
  type GiteaApiClient
} from './api.js'
import { servesRuntime } from './binding-state.js'
import type { GiteaTokenSource } from './provisioner.js'

/** One rerun subject the Console can name, in the product's subject vocabulary. */
export interface GiteaRerunSubject {
  kind: 'merge_request' | 'issue'
  index: number
}

/** What a compiled rule pins for one rerun: its revision pair, plus the §3 host the daemon fences the turn on. */
interface DispatchFence {
  configRevision: string
  dispatchRevision: string
  host?: string
}

/** Machine-readable refusal reasons; the console branches on these, not on prose. */
export type GiteaRerunCode =
  /** Emitted by the route, not this service: no Gitea connection surface is configured. */
  | 'GITEA_NOT_CONFIGURED'
  | 'HOOK_NOT_GITEA'
  | 'HOOK_DISABLED'
  | 'AGENT_UNAVAILABLE'
  | 'BINDING_INACTIVE'
  | 'DISPATCH_UNAVAILABLE'
  | 'SUBJECT_NOT_FOUND'
  | 'SUBJECT_CLOSED'
  | 'HEAD_UNAVAILABLE'
  | 'GITEA_UNAVAILABLE'
  | 'RELAY_UNAVAILABLE'
  /** Every eligible relay declined; nothing ran (the relay's reason rides `relayCode`). */
  | 'RELAY_REJECTED'
  /** A relay went quiet mid-request — the turn may or may not have started. */
  | 'RELAY_AMBIGUOUS'

export type GiteaRerunResult =
  | { ok: true; deliveryKey: string; event: string; headSha: string | null }
  | {
      ok: false
      status: 409 | 429 | 502 | 503
      code: GiteaRerunCode
      message: string
      /** The relay's own refusal category, when one answered. */
      relayCode?: RcHookRerunRefusal
    }

export interface GiteaHookRerunDeps {
  hooks: Pick<HookRepo, 'getUnscoped'>
  agents: { getUnscoped(agentId: AgentId): Promise<AgentRecord | null> }
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
  connections: Pick<GiteaConnectionRepo, 'get'>
  tokens: GiteaTokenSource
  hookService: Pick<HookService, 'compile'>
  relayControl: Pick<RelayControlSender, 'hookRerun'>
  api: GiteaApiClient
}

function refuse(status: 409 | 429 | 502 | 503, code: GiteaRerunCode, message: string): GiteaRerunResult {
  return { ok: false, status, code, message }
}

/** How a definitive relay refusal reads to the caller; `replay_pending` is the only retryable one. */
const RELAY_REFUSAL: Record<RcHookRerunRefusal, { status: 409 | 429 | 503; message: string }> = {
  replay_pending: { status: 503, message: 'the relay pool has not loaded this trigger yet — try again shortly' },
  rule_mismatch: { status: 409, message: 'this trigger changed while the rerun was being authorized' },
  limiter_exhausted: { status: 429, message: 'this trigger has run too many times just now — try again shortly' }
}

export class GiteaHookRerunService {
  constructor(private readonly deps: GiteaHookRerunDeps) {}

  async rerun(hook: HookRecord, subject: GiteaRerunSubject): Promise<GiteaRerunResult> {
    if (hook.kind !== 'gitea') {
      return refuse(409, 'HOOK_NOT_GITEA', 'only a Gitea trigger can be run again through this path')
    }
    if (!hook.enabled) return refuse(409, 'HOOK_DISABLED', 'this trigger is disabled')
    if (hook.repoId === null || !hook.agentId) {
      return refuse(409, 'BINDING_INACTIVE', 'this trigger names no Gitea repository')
    }
    const repoId = hook.repoId

    const agent = await this.deps.agents.getUnscoped(hook.agentId)
    if (!agent) return refuse(409, 'AGENT_UNAVAILABLE', 'the agent this trigger fires no longer exists')
    if (agent.pause === true) return refuse(409, 'AGENT_UNAVAILABLE', 'the agent this trigger fires is paused')

    // "Active binding": past provisioning, serving runtime, and not being torn down (§5).
    const binding = await this.deps.bindings.byRepo(hook.orgId, repoId)
    if (!binding || binding.state === 'provisioning' || !servesRuntime(binding.state)) {
      return refuse(409, 'BINDING_INACTIVE', 'this repository has no active Gitea binding')
    }
    const connection = await this.deps.connections.get(hook.orgId, binding.connectionId)
    if (!connection || connection.state !== 'connected') {
      return refuse(409, 'BINDING_INACTIVE', 'this repository has no usable Gitea connection')
    }
    const path = splitGiteaRepoPath(binding.repoPath)
    if (!path) return refuse(409, 'BINDING_INACTIVE', 'this repository binding has no owner/repo path')

    const fence = await this.dispatchFence(hook)
    if (!fence) {
      return refuse(409, 'DISPATCH_UNAVAILABLE', 'this trigger cannot dispatch right now — check the agent placement')
    }

    // The subject read runs as the connection's bot (§4.2).
    let token: string
    try {
      token = await this.deps.tokens.withToken(hook.orgId, connection.id)
    } catch {
      return refuse(409, 'BINDING_INACTIVE', 'this repository has no usable Gitea token')
    }

    let target: GiteaHookMetadata['target']
    let headSha: string | null = null
    try {
      if (subject.kind === 'merge_request') {
        const pull = await giteaPullRequest(token, path.owner, path.repo, subject.index, this.deps.api)
        if (!pull) return refuse(409, 'SUBJECT_NOT_FOUND', 'this pull request no longer exists')
        if (pull.state !== 'open' || pull.merged === true) {
          return refuse(409, 'SUBJECT_CLOSED', `this pull request is ${pull.merged ? 'merged' : pull.state}`)
        }
        // The CURRENT head, read now — a stored one could re-run a stale revision.
        headSha = pull.head?.sha ?? null
        if (!headSha) return refuse(409, 'HEAD_UNAVAILABLE', 'Gitea reported no current head for this pull request')
        target = {
          kind: 'pull',
          index: subject.index,
          ...(pull.head?.repo_id !== undefined ? { sourceRepoId: String(pull.head.repo_id) } : {}),
          headSha,
          ...(pull.base?.sha ? { baseSha: pull.base.sha } : {}),
          ...(pull.draft !== undefined ? { isDraft: pull.draft } : {}),
          // The console action is an explicit authorized request, like a reviewer re-request.
          explicitReviewRequest: true
        }
      } else {
        const issue = await giteaIssue(token, path.owner, path.repo, subject.index, this.deps.api)
        // Issues and pull requests share one index space; an index that is a pull request is not this subject.
        if (!issue || issue.pull_request) return refuse(409, 'SUBJECT_NOT_FOUND', 'this issue no longer exists')
        if (issue.state !== 'open') return refuse(409, 'SUBJECT_CLOSED', `this issue is ${issue.state}`)
        target = { kind: 'issue', index: subject.index }
      }
    } catch (e) {
      if (isGiteaAuthRejection(e)) {
        // A definite rejection is the connection's verdict (§4.3), not this click's.
        await this.deps.tokens.onAuthRejected(hook.orgId, connection.id).catch(() => undefined)
        return refuse(409, 'BINDING_INACTIVE', 'the Gitea token was rejected — replace it')
      }
      if (e instanceof GiteaApiError) {
        return refuse(502, 'GITEA_UNAVAILABLE', 'Gitea could not be reached to confirm the current subject')
      }
      throw e
    }

    // Re-read the hook and recompile after the Gitea round trip so a disable or retarget meanwhile cannot authorize this turn.
    const refreshed = await this.deps.hooks.getUnscoped(HookId(hook.id))
    if (!refreshed || refreshed.orgId !== hook.orgId || refreshed.agentId !== hook.agentId) {
      return refuse(409, 'DISPATCH_UNAVAILABLE', 'this trigger changed while the rerun was being authorized')
    }
    const refreshedFence = await this.dispatchFence(refreshed)
    if (
      !refreshedFence ||
      refreshedFence.configRevision !== fence.configRevision ||
      refreshedFence.dispatchRevision !== fence.dispatchRevision
    ) {
      return refuse(409, 'DISPATCH_UNAVAILABLE', 'this trigger changed while the rerun was being authorized')
    }

    const frame: RcHookRerun = {
      hookId: hook.id,
      agentId: hook.agentId,
      deliveryKey: `rerun_${randomUUID()}`,
      configRevision: refreshedFence.configRevision,
      dispatchRevision: refreshedFence.dispatchRevision,
      event: subject.kind === 'issue' ? 'issues:rerun' : 'merge_request:rerun',
      gitea: {
        repoId: repoId.toString(),
        repoPath: binding.repoPath,
        // §3: the same fence a webhook delivery carries; the daemon refuses a host its spec is not bound to.
        ...(refreshedFence.host !== undefined ? { host: refreshedFence.host } : {}),
        target
      }
    }
    // Only a relay's own admission proves a turn was queued and a run row opened.
    const outcome = await this.deps.relayControl.hookRerun(frame)
    if (outcome.kind === 'unreachable') {
      return refuse(503, 'RELAY_UNAVAILABLE', 'no relay is connected to run this trigger')
    }
    if (outcome.kind === 'ambiguous') {
      return refuse(503, 'RELAY_AMBIGUOUS', 'the relay stopped answering — check the runs before running again')
    }
    if (outcome.kind === 'refused') {
      const mapped = RELAY_REFUSAL[outcome.code]
      return {
        ok: false,
        status: mapped.status,
        code: 'RELAY_REJECTED',
        message: mapped.message,
        relayCode: outcome.code
      }
    }
    return { ok: true, deliveryKey: frame.deliveryKey, event: frame.event, headSha }
  }

  /** The compiled rule's revisions and host, or null when undispatchable; the rule holds signing keys — never log or return it. */
  private async dispatchFence(hook: HookRecord): Promise<DispatchFence | null> {
    const rule = await this.deps.hookService.compile(hook)
    if (!rule || rule.kind !== 'gitea') return null
    if (rule.configRevision === undefined || rule.dispatchRevision === undefined) return null
    return {
      configRevision: rule.configRevision,
      dispatchRevision: rule.dispatchRevision,
      ...(rule.gitea?.host !== undefined ? { host: rule.gitea.host } : {})
    }
  }
}
