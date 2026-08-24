/**
 * The Console "Run again" action for gitlab hooks (gitlab-com-integration.md
 * §16.1, §18.2). GitLab has no native Check button, so this route is the
 * replacement start path — and, being Control-Plane-initiated, it must prove
 * for itself everything a signed webhook delivery proves on the way in.
 *
 * Every fence is revalidated live: the hook is still enabled and still gitlab,
 * its agent still exists and is not paused, the project binding is still live,
 * the hook still compiles to a dispatchable rule, and the subject still exists
 * and is open — with the merge request's CURRENT head read from GitLab, never a
 * stored one. The hook fence is re-read AFTER the GitLab round trip so a
 * concurrent disable or retarget cannot authorize a turn.
 *
 * The turn itself is NOT dispatched here: the relay owns hook dispatch, so an
 * authorized rerun leaves as one `rc/hook-rerun` frame and re-enters the same
 * path an ordinary delivery takes.
 */
import { randomUUID } from 'node:crypto'
import type { GitlabHookMetadata, RcHookRerun, RcHookRerunRefusal } from '@agentconnect.md/protocol'
import type { HookService } from '../hooks/hook.service.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import { AgentId, HookId } from '../domain/ids.js'
import type {
  AgentRecord,
  GitlabAgentAccountRepo,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import { GitlabApiError, gitlabIssue, gitlabMergeRequest, type GitlabApiClient } from './api.js'

/** One rerun subject the Console can name — §12.3's two thread-bearing kinds. */
export interface GitlabRerunSubject {
  kind: 'merge_request' | 'issue'
  iid: number
}

/** What a compiled rule pins for one rerun: its revision pair, plus the §24.4 host the
 *  daemon fences the turn on. Absent host ⇒ GitLab.com, as everywhere else. */
interface DispatchFence {
  configRevision: string
  dispatchRevision: string
  host?: string
}

/** Machine-readable refusal reasons; the console branches on these, not on prose. */
export type GitlabRerunCode =
  /** Emitted by the route, not this service: no GitLab application is configured. */
  | 'GITLAB_NOT_CONFIGURED'
  | 'HOOK_NOT_GITLAB'
  | 'HOOK_DISABLED'
  | 'AGENT_UNAVAILABLE'
  | 'BINDING_INACTIVE'
  | 'DISPATCH_UNAVAILABLE'
  | 'SUBJECT_NOT_FOUND'
  | 'SUBJECT_CLOSED'
  | 'HEAD_UNAVAILABLE'
  | 'GITLAB_UNAVAILABLE'
  | 'RELAY_UNAVAILABLE'
  /** Every eligible relay declined; nothing ran (the relay's reason rides `relayCode`). */
  | 'RELAY_REJECTED'
  /** A relay went quiet mid-request — the turn may or may not have started. */
  | 'RELAY_AMBIGUOUS'

export type GitlabRerunResult =
  | { ok: true; deliveryKey: string; event: string; headSha: string | null }
  | {
      ok: false
      status: 409 | 429 | 502 | 503
      code: GitlabRerunCode
      message: string
      /** The relay's own refusal category, when one answered. */
      relayCode?: RcHookRerunRefusal
    }

export interface GitlabHookRerunDeps {
  hooks: Pick<HookRepo, 'getUnscoped'>
  agents: { getUnscoped(agentId: AgentId): Promise<AgentRecord | null> }
  bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
  accounts: Pick<GitlabAgentAccountRepo, 'forAgentBinding'>
  credentials: Pick<GitlabProjectCredentialRepo, 'get'>
  credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
  hookService: Pick<HookService, 'compile'>
  relayControl: Pick<RelayControlSender, 'hookRerun'>
  api: GitlabApiClient
}

function refuse(status: 409 | 429 | 502 | 503, code: GitlabRerunCode, message: string): GitlabRerunResult {
  return { ok: false, status, code, message }
}

/** How a definitive relay refusal reads to the caller. `replay_pending` is the
 *  only retryable one: the pool simply has not converged on the rule yet. */
const RELAY_REFUSAL: Record<RcHookRerunRefusal, { status: 409 | 429 | 503; message: string }> = {
  replay_pending: { status: 503, message: 'the relay pool has not loaded this trigger yet — try again shortly' },
  rule_mismatch: { status: 409, message: 'this trigger changed while the rerun was being authorized' },
  limiter_exhausted: { status: 429, message: 'this trigger has run too many times just now — try again shortly' }
}

export class GitlabHookRerunService {
  constructor(private readonly deps: GitlabHookRerunDeps) {}

  async rerun(hook: HookRecord, subject: GitlabRerunSubject): Promise<GitlabRerunResult> {
    if (hook.kind !== 'gitlab') {
      return refuse(409, 'HOOK_NOT_GITLAB', 'only a GitLab trigger can be run again from the console')
    }
    if (!hook.enabled) return refuse(409, 'HOOK_DISABLED', 'this trigger is disabled')
    if (hook.repoId === null || !hook.agentId) {
      return refuse(409, 'BINDING_INACTIVE', 'this trigger names no GitLab project')
    }
    const projectId = hook.repoId

    const agent = await this.deps.agents.getUnscoped(hook.agentId)
    if (!agent) return refuse(409, 'AGENT_UNAVAILABLE', 'the agent this trigger fires no longer exists')
    if (agent.pause === true) return refuse(409, 'AGENT_UNAVAILABLE', 'the agent this trigger fires is paused')

    // "Active binding": still owned by this org, past provisioning, and not
    // being torn down — the same bar the §12.2 live membership gate applies.
    const binding = await this.deps.bindings.byProject(hook.orgId, projectId)
    if (!binding || binding.state === 'provisioning' || binding.state === 'cleanup_pending') {
      return refuse(409, 'BINDING_INACTIVE', 'this project has no active GitLab binding')
    }

    const fence = await this.dispatchFence(hook)
    if (!fence) {
      return refuse(409, 'DISPATCH_UNAVAILABLE', 'this trigger cannot dispatch right now — check the agent placement')
    }

    // The subject read runs as the HOOK AGENT's own account (§7.2).
    const token = await this.readToken(binding.orgId, hook.agentId, binding.id)
    if (!token) return refuse(409, 'BINDING_INACTIVE', 'this project has no usable GitLab read credential')

    let target: GitlabHookMetadata['target']
    let headSha: string | null = null
    try {
      if (subject.kind === 'merge_request') {
        const mr = await gitlabMergeRequest(token, projectId, subject.iid, this.deps.api)
        if (!mr) return refuse(409, 'SUBJECT_NOT_FOUND', 'this merge request no longer exists')
        if (mr.state !== 'opened') return refuse(409, 'SUBJECT_CLOSED', `this merge request is ${mr.state}`)
        // The CURRENT head, read now — a stored one could re-run a stale revision.
        headSha = mr.diff_refs?.head_sha ?? mr.sha ?? null
        if (!headSha) return refuse(409, 'HEAD_UNAVAILABLE', 'GitLab reported no current head for this merge request')
        const draft = mr.draft ?? mr.work_in_progress
        target = {
          kind: 'merge_request',
          iid: subject.iid,
          ...(mr.source_project_id !== undefined ? { sourceProjectId: String(mr.source_project_id) } : {}),
          headSha,
          ...(mr.diff_refs?.base_sha ? { baseSha: mr.diff_refs.base_sha } : {}),
          ...(draft !== undefined ? { isDraft: draft } : {}),
          // The console action is an explicit authorized request, like a reviewer re-request.
          explicitReviewRequest: true
        }
      } else {
        const issue = await gitlabIssue(token, projectId, subject.iid, this.deps.api)
        if (!issue) return refuse(409, 'SUBJECT_NOT_FOUND', 'this issue no longer exists')
        if (issue.state !== 'opened') return refuse(409, 'SUBJECT_CLOSED', `this issue is ${issue.state}`)
        target = { kind: 'issue', iid: subject.iid }
      }
    } catch (e) {
      if (e instanceof GitlabApiError) {
        return refuse(502, 'GITLAB_UNAVAILABLE', 'GitLab could not be reached to confirm the current subject')
      }
      throw e
    }

    // The GitLab reads crossed a remote boundary. Re-read the hook and re-run
    // the compile so a disable, retarget, or reassignment in that window cannot
    // authorize this turn (the relay re-fences the frame again on arrival).
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
      gitlab: {
        projectId: projectId.toString(),
        projectPath: binding.projectPath,
        // §24.4: the same fence a webhook delivery carries. Absent means GitLab.com, so the
        // N3 daemon refuses a rerun whose host disagrees with its spec instead of retargeting.
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

  /** The compiled rule's revision pair and host, or null when the hook is undispatchable.
   *  The host is the §24.4 fence the daemon checks against its spec, so it must come from the
   *  RULE rather than be recomposed here. The rule itself carries the project signing token —
   *  NEVER log or return it. */
  private async dispatchFence(hook: HookRecord): Promise<DispatchFence | null> {
    const rule = await this.deps.hookService.compile(hook)
    if (!rule || rule.kind !== 'gitlab') return null
    if (rule.configRevision === undefined || rule.dispatchRevision === undefined) return null
    return {
      configRevision: rule.configRevision,
      dispatchRevision: rule.dispatchRevision,
      ...(rule.gitlab?.host !== undefined ? { host: rule.gitlab.host } : {})
    }
  }

  private async readToken(orgId: string, agentId: string, bindingId: string): Promise<string | null> {
    const account = await this.deps.accounts.forAgentBinding(orgId, agentId, bindingId)
    if (!account) return null
    const credential = await this.deps.credentials.get(account.id, 'read')
    if (!credential) return null
    return this.deps.credentialSecrets.get(orgId, credential.id)
  }
}
