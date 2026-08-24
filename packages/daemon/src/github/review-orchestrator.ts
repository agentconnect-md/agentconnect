/**
 * The daemon's GitHub hook-dispatch and formal-review seam
 * (webhook-triggers-and-github-events.md): the `rd/msg` hook ack gate, the
 * durable-inbox admission barrier, PR revision resolution, review-workspace
 * preparation, the CP-authorized review submission, and the batched
 * review-thread replies. The Daemon keeps thin same-name delegates; everything
 * here reaches back through the narrow {@link GithubReviewHost} port, so the
 * generic hook-report plumbing (inbox rows, hook state, completion reports)
 * stays where it is.
 */
import { randomUUID } from 'node:crypto'
import {
  GITLAB_DEFAULT_BASE_URL,
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  type GithubHookMetadata,
  type HookReviewResult,
  type RdAck,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { gitlabApiBaseUrl } from '../gitlab/api-base.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { AcpHost } from '../acp/acp-host.js'
import type { CpClient } from '../cp/client.js'
import type { Logger } from '../log.js'
import { buildHookMessage, githubOpensReviewGeneration, hookAnchorText } from '../messages/hook-message.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { ReplyGithubReviewThreadsReq, ReplyGithubReviewThreadsResult, SubmitGithubReviewReq } from '../mcp/ops.js'
import type { CodeHostReviewAdapter } from '../codehost/review-adapter.js'
import { hookCoordinates, openReviewBatch, reviewSubjectLane } from '../codehost/hook-admission.js'
import { sessionKey, type SessionRecord } from '../store/local-store.js'
import { formatErr, formatErrWithCauses } from '../daemon/text.js'
import {
  authorizedReviewTarget,
  authorizedReviewTargetMatches,
  githubDeletedHookEvent,
  githubFallbackAllowed,
  githubThreadWorktreeCleanup,
  hookSnapshot,
  isGithubReviewCommentHook,
  reviewPolicyAllows,
  reviewResultForWire,
  type ActiveGithubReplyBatchMeta,
  type ActiveGithubTurnMeta,
  type GithubReplyTarget,
  type GithubThreadWorktreeCleanup,
  type HookCompletionOwner,
  type HookDispatchContext,
  type SessionWorktreeCleanupResult
} from './hook-coords.js'
import type { CallMeta, QueueEntry } from '../daemon/turn-types.js'
import type { WebchatTurnContext } from '../webchat/types.js'
import { initiatorLabel } from '../workspace/session-branch.js'
import type { PrepareSessionWorkspaceRequest } from '../workspace/workspace-manager.js'
import { GithubFinalPoster, GithubReplyCollector, type GithubCommentAttribution } from './poster.js'
import { GitlabFinalPoster } from '../gitlab/poster.js'
import { GITLAB_HOST_MISMATCH_REASON } from '../gitlab/host-fence.js'
import { GithubReviewClient, type GithubReviewEffect } from './review.js'

/** Dispatch options this seam needs; a subset of the daemon's own. */
export interface GithubHookDispatchOptions {
  /** A hook delivery must own a durable row before the relay is ACKed. */
  requireDurable?: boolean
  /** Synchronous admission barrier, settled before any turn can start. */
  onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
}

/** Exactly what the GitHub review orchestration touches on the Daemon — nothing wider. */
export interface GithubReviewHost {
  log(): Logger
  now(): number
  daemonId(): string | undefined
  agents(): Map<string, LoadedAgent>
  cpClient(): CpClient | undefined
  orgForAgent(agentId: string): string | undefined
  hasInbox(id: string): Promise<boolean>
  getSession(key: string): Promise<SessionRecord | undefined>
  displayNames(ids: string[]): Promise<Map<string, string>>
  getPostToken(agentId: string, repo: string, hookId: string): Promise<{ token: string }>
  /** §14.1 effect lease: the binding's effect PAT gated by the enabled gitlab hook. */
  getGitlabPostToken(agentId: string, projectId: string, hookId: string): Promise<{ token: string }>
  invalidateGitlabPost(agentId: string, projectId: string, presentedToken?: string): void
  invalidatePost(agentId: string, repo: string, presentedToken?: string): void
  paused(agentId: string): boolean
  draining(agentId: string): boolean
  safetyDraining(agentId: string): boolean
  safetyDrainAllows(agentId: string, key: string, reviewLane?: string): boolean
  /** Generic hook-report plumbing stays on the Daemon; this seam only calls it. */
  persistInbox(
    entry: QueueEntry,
    key: string,
    options?: { required?: boolean; adoptExisting?: boolean; existingId?: string }
  ): Promise<'inserted' | 'adopted' | 'existing' | 'skipped' | 'failed'>
  persistHookState(
    entry: QueueEntry,
    posterPublishState?: QueueEntry['posterPublishState'],
    required?: boolean
  ): Promise<void>
  emitHookCompletion(
    hook: HookDispatchContext,
    status: 'success' | 'failed',
    extra?: { sessionId?: string; reason?: string },
    owner?: HookCompletionOwner
  ): Promise<void>
  /** The exact in-flight dispatch for one session key, so a lifecycle cleanup can let it settle. */
  activeDispatchDone(key: string): Promise<void> | undefined
  cleanupSessionWorktree(rec: SessionRecord): Promise<SessionWorktreeCleanupResult>
  prepareAgentWorkspace(
    agent: Agent,
    expectedWarmHost?: AcpHost,
    request?: PrepareSessionWorkspaceRequest
  ): Promise<string>
  /** Whether a prepared session was handed reference directories beside its working directory. */
  sessionHasReferenceDirectories(agent: Agent, request: PrepareSessionWorkspaceRequest): Promise<boolean>
  /** The agent's warm ACP host, only once it is ready. */
  warmHostFor(agentId: string): AcpHost | undefined
  anchorTrigger(
    agentId: string,
    msg: NormalizedMessage,
    target: { channel?: string; integrationId?: string } | undefined,
    anchorText: string,
    label: string,
    safetyReviewLane?: string
  ): Promise<NormalizedMessage | null>
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: GithubHookDispatchOptions,
    githubReply?: GithubReplyTarget,
    hookContext?: HookDispatchContext
  ): Promise<string | null>
  /** Turn-finalization in dispatchOne reads these maps too, so they stay on the Daemon. */
  activeGithubTurn(key: string): ActiveGithubTurnMeta | undefined
  activeGithubReplyBatch(key: string): ActiveGithubReplyBatchMeta | undefined
  agentLink(agentId: string): string
  /** Takes the session's OUTWARD id (session-concept.md §1.1), which {@link outwardSessionId} resolves. */
  sessionLink(sessionId: string, source?: string): string
  outwardSessionId(agentId: string, acpSessionId: string): Promise<string | undefined>
  runtimeNames(): Record<string, string>
  hostForStoredSession(agentId: string, acpSessionId: string): Promise<AcpHost | undefined>
}

export class GithubReviewOrchestrator {
  readonly githubReviewClient = new GithubReviewClient()

  /** The §6.5 code-host review adapter, GitHub side — extracted so GitLab can implement
   *  the same member instead of core branching on a provider name. */
  readonly reviewAdapter: CodeHostReviewAdapter = {
    provider: 'github',
    owns: (key, agentId) => this.host.activeGithubTurn(key)?.hook.agentId === agentId,
    submit: (_key, req) => this.submitGithubReview(req)
  }

  constructor(private readonly host: GithubReviewHost) {}

  private get log(): Logger {
    return this.host.log()
  }

  private get agents(): Map<string, LoadedAgent> {
    return this.host.agents()
  }

  /**
   * Ack-verdict gate for one hook fire (`rd/msg` hook member) — the mirror of
   * {@link dispatchWebchatTurn}'s synchronous gates: the relay's rc/run-report
   * needs a REASONED rejection now, not a silently dropped fire-and-forget
   * dispatch. Accepted is returned only after {@link onHookFire} has crossed
   * the durable-inbox admission barrier; the model turn itself remains async.
   */
  async dispatchRelayHook(msg: RdMsgHook): Promise<RdAck> {
    const cleanup = githubThreadWorktreeCleanup(msg)
    const maintenance = cleanup !== undefined || githubDeletedHookEvent(msg)
    const agent = this.agents.get(msg.agentId)
    if (!agent) {
      this.log.warn(`hook: no agent "${msg.agentId}" on this daemon — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    // §24.4: a delivery naming another instance than the spec is REFUSED, never re-targeted.
    if (msg.gitlab !== undefined) {
      const expected = agent.gitlabHost ?? GITLAB_DEFAULT_BASE_URL
      const delivered = msg.gitlab.host ?? GITLAB_DEFAULT_BASE_URL
      if (delivered !== expected) {
        this.log.warn(
          `hook: fire ${msg.msgId} for agent "${msg.agentId}" names gitlab instance ${delivered} but its spec is bound to ${expected} — refusing`
        )
        return { msgId: msg.msgId, accepted: false, reason: GITLAB_HOST_MISMATCH_REASON }
      }
    }
    if (!maintenance && this.host.paused(msg.agentId)) {
      this.log.info(`hook: agent "${msg.agentId}" is paused — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'paused' }
    }
    const normalized = buildHookMessage(msg, 'safety-drain-probe')
    const normalizedKey = sessionKey(
      normalized.platform,
      normalized.channel,
      normalized.thread ?? normalized.msgId,
      msg.agentId,
      normalized.transportScope
    )
    const reviewLane = reviewSubjectLane(msg, hookCoordinates(msg.agentId, normalized, msg.target?.integrationId))
    if (
      !maintenance &&
      this.host.safetyDraining(msg.agentId) &&
      !this.host.safetyDrainAllows(msg.agentId, normalizedKey, reviewLane)
    ) {
      this.log.info(`hook: agent "${msg.agentId}" is stopping an interrupted turn — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'busy' }
    }
    if (this.host.draining(msg.agentId)) {
      this.log.info(`hook: agent "${msg.agentId}" is draining — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'draining' }
    }
    const admission = await this.onHookFire(msg)
    return {
      msgId: msg.msgId,
      accepted: admission.accepted,
      ...(admission.reason ? { reason: admission.reason } : {})
    }
  }

  /**
   * A hook fired for `agentId` (explicit target — no routing;
   * webhook-triggers-and-github-events.md). The relay already opened the HookRun
   * row (`rc/run-report accepted`); when the turn ends this closes it with a
   * completion `hook/report` EVT on the control WS (the cron/report pattern).
   * Anchoring rides the shared {@link fireTrigger} path: with a target the
   * trigger text lands in the channel and the session threads under it,
   * without one the fire runs headless.
   */
  async onHookFire(msg: RdMsgHook): Promise<{ accepted: boolean; reason?: string }> {
    const cleanup = githubThreadWorktreeCleanup(msg)
    const deleted = githubDeletedHookEvent(msg)
    // A lifecycle cleanup always addresses the stable GitHub thread session,
    // never an optional IM anchor configured for ordinary hook output.
    const nmsg = buildHookMessage(cleanup || deleted ? { ...msg, target: undefined } : msg, randomUUID())
    // The in-memory ACK cache closes same-process retransmits. This durable
    // probe closes the restart window *before* anchorTrigger posts externally:
    // a retained live row will replay, and a terminal row is already complete.
    // In either case the original accepted admission owns this delivery.
    if (await this.host.hasInbox(nmsg.msgId)) {
      this.log.debug(`hook: durable duplicate ${nmsg.msgId} — replaying accepted admission`)
      return { accepted: true }
    }
    const snapshot = hookSnapshot(msg)
    const hookContext: HookDispatchContext = {
      hookId: msg.hookId,
      agentId: msg.agentId,
      deliveryKey: msg.deliveryKey,
      firedAt: msg.firedAt,
      ...(msg.event ? { event: msg.event } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(msg.github ? { github: msg.github } : {}),
      ...(msg.gitlab ? { gitlab: msg.gitlab } : {})
    }
    if (cleanup || deleted) {
      const key = sessionKey(nmsg.platform, nmsg.channel, nmsg.thread ?? nmsg.msgId, msg.agentId, nmsg.transportScope)
      const entry: QueueEntry = {
        agentId: msg.agentId,
        msg: nmsg,
        initAbort: new AbortController(),
        hookContext,
        resolve: () => {},
        reject: () => {}
      }
      // Keep the maintenance receipt outside the session's own inbox key so
      // retention's active-session predicate does not mistake this cleanup
      // obligation for a pending model turn.
      const persistence = await this.host.persistInbox(entry, `maintenance:${key}`, { required: true })
      if (persistence !== 'existing') {
        if (cleanup) void this.completeGithubThreadWorktreeCleanup(hookContext, key, cleanup, entry)
        else await this.host.emitHookCompletion(hookContext, 'success', { reason: 'deleted_event_ignored' }, entry)
      }
      return { accepted: true }
    }
    // P3 outbound: github fires on a NUMBERED thread publish their completed reply as
    // one comment (always on — design; push fires have no thread and stay silent).
    const c = msg.context
    const trustedInlineTarget =
      c?.source === 'github' &&
      msg.github?.subjectKind === 'pull_request' &&
      msg.github.pullNumber !== undefined &&
      msg.github.reviewThreadRootCommentId !== undefined
        ? {
            hookId: msg.hookId,
            repo: msg.github.repoFullName,
            number: msg.github.pullNumber,
            ...(msg.github.reviewCommentId ? { reviewCommentId: msg.github.reviewCommentId } : {}),
            reviewThreadRootCommentId: msg.github.reviewThreadRootCommentId
          }
        : undefined
    // Inline coordinates and their PR target are one body-free trusted unit.
    // A mixed-version frame without that unit keeps the rolling-compatible
    // ordinary issue/PR comment path derived from HookContext.
    // GitLab (§14.1) rides the same pipe: repo = numeric project id, number = IID; pushes have no thread and stay silent.
    const gitlabReply =
      c?.source === 'gitlab' && msg.gitlab && msg.gitlab.target.kind !== 'push'
        ? {
            hookId: msg.hookId,
            provider: 'gitlab' as const,
            subjectKind: msg.gitlab.target.kind,
            repo: msg.gitlab.projectId,
            number: msg.gitlab.target.iid
          }
        : undefined
    const githubReply =
      trustedInlineTarget ??
      gitlabReply ??
      (c?.source === 'github' && c.repo && c.number !== undefined
        ? { hookId: msg.hookId, repo: c.repo, number: c.number }
        : undefined)
    if (githubReply) hookContext.githubReply = githubReply
    const reviewLane = reviewSubjectLane(hookContext, hookCoordinates(msg.agentId, nmsg, msg.target?.integrationId))
    const anchored = await this.host.anchorTrigger(
      msg.agentId,
      nmsg,
      msg.target,
      hookAnchorText(msg),
      `hook "${msg.hookId}"`,
      reviewLane
    )
    if (!anchored) return { accepted: false, reason: 'dropped' }
    const batch = openReviewBatch(
      hookContext,
      hookCoordinates(msg.agentId, anchored, msg.target?.integrationId),
      anchored.text,
      this.host.now()
    )
    if (batch) hookContext.githubReviewBatch = batch
    let settleAdmission!: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string; duplicate?: boolean }>((resolve) => {
      settleAdmission = resolve
    })
    const turn = this.host.dispatch(
      msg.agentId,
      anchored,
      msg.target?.integrationId,
      undefined,
      undefined,
      { requireDurable: true, onAdmission: (result) => settleAdmission(result) },
      githubReply,
      hookContext
    )
    // Await the admission barrier, but never make rd/ack wait for the model.
    // Every accepted terminal path is owned by runLoop/dispatchOne and emits its
    // durable receipt there; observing a null here as well used to double-report
    // queued entries that were gate-dropped before their turn began.
    void turn.catch((err) => {
      this.log.error(`hook turn failed for agent "${msg.agentId}": ${formatErr(err)}`)
      // A dispatch that rejected before admission settled must still release this barrier.
      settleAdmission({ accepted: false, reason: 'error' })
    })
    const admission = await admitted
    if (!admission.accepted) {
      return { accepted: false, reason: admission.reason ?? 'durability' }
    }
    return { accepted: true }
  }

  async completeGithubThreadWorktreeCleanup(
    hook: HookDispatchContext,
    key: string,
    cleanup: GithubThreadWorktreeCleanup,
    owner: HookCompletionOwner
  ): Promise<void> {
    try {
      // A merge/close can race the last review turn. Let that exact dispatch
      // settle before applying the same safety checks used by retention.
      await this.host.activeDispatchDone(key)?.catch(() => undefined)
      const rec = await this.host.getSession(key)
      if (!rec) {
        this.log.info(`github lifecycle: ${cleanup} has no session worktree for ${key}`)
        await this.host.emitHookCompletion(hook, 'success', { reason: 'worktree_cleanup_no_session' }, owner)
        return
      }
      const result = await this.host.cleanupSessionWorktree(rec)
      if (result.outcome === 'failed') {
        this.log.warn(`github lifecycle: ${cleanup} worktree cleanup failed for ${key} (${result.error})`)
        await this.host.emitHookCompletion(hook, 'failed', { reason: 'worktree_cleanup_failed' }, owner)
        return
      }
      if (result.outcome === 'retained') {
        this.log.info(`github lifecycle: ${cleanup} retained worktree for ${key} (${result.reason})`)
        await this.host.emitHookCompletion(
          hook,
          'success',
          { reason: `worktree_cleanup_retained_${result.reason}` },
          owner
        )
        return
      }
      if (result.outcome === 'active') {
        this.log.info(`github lifecycle: ${cleanup} deferred worktree cleanup for active session ${key}`)
        await this.host.emitHookCompletion(hook, 'success', { reason: 'worktree_cleanup_deferred_active' }, owner)
        return
      }
      this.log.info(`github lifecycle: ${cleanup} worktree cleanup ${result.outcome} for ${key}`)
      await this.host.emitHookCompletion(hook, 'success', undefined, owner)
    } catch (err) {
      this.log.warn(`github lifecycle: ${cleanup} worktree cleanup failed for ${key} (${formatErr(err)})`)
      await this.host.emitHookCompletion(hook, 'failed', { reason: 'worktree_cleanup_failed' }, owner)
    }
  }

  githubFormalReviewEnabled(entry: QueueEntry): boolean {
    const hook = entry.hookContext
    const snapshot = hook?.snapshot
    const github = hook?.github
    return Boolean(
      hook &&
      snapshot &&
      github?.subjectKind === 'pull_request' &&
      github.pullNumber !== undefined &&
      snapshot.reviewPolicy !== 'off' &&
      snapshot.gateMode === 'informational' &&
      snapshot.reportingMode !== 'status' &&
      (!this.host.daemonId() || snapshot.dispatchDaemonId === this.host.daemonId()) &&
      githubOpensReviewGeneration(hook.event, github, snapshot.reviewPolicy) &&
      !isGithubReviewCommentHook(hook)
    )
  }

  /** Fill the trusted revision gap on issue_comment deliveries before either
   * workspace preparation or hook/start. Formal reviews fail closed when the
   * daemon cannot prove which base/head the model would review. */
  async ensureGithubPullRevision(entry: QueueEntry, required: boolean): Promise<GithubHookMetadata | undefined> {
    const hook = entry.hookContext
    const github = hook?.github
    if (!hook || !github || github.subjectKind !== 'pull_request' || github.pullNumber === undefined) {
      return github
    }
    if (github.headSha && github.baseSha) return github

    try {
      const postToken = await this.host.getPostToken(hook.agentId, github.repoFullName, hook.hookId)
      const revision = await this.githubReviewClient.getPull(postToken.token, github.repoFullName, github.pullNumber)
      hook.github = {
        ...github,
        headSha: revision.headSha,
        baseSha: revision.baseSha,
        reportSha: revision.headSha,
        ...(revision.mergeCommitSha ? { mergeCommitSha: revision.mergeCommitSha } : {}),
        isDraft: revision.draft
      }
      await this.host.persistHookState(entry, undefined, true)
      return hook.github
    } catch (err) {
      this.log.warn(`github review: unable to resolve PR revision (${formatErr(err)})`)
      if (required) {
        throw new Error('github review blocked: unable to resolve the authoritative PR base and head', {
          cause: err
        })
      }
      return undefined
    }
  }

  /**
   * The workspace root a hook's repository resolves to: the primary, one of the agent's authorized
   * additional repositories, or none at all — which is what keeps the revision-only fallback a
   * safety net rather than the ordinary path (multi-repository-workspaces.md decision 6).
   */
  reviewRootFor(agent: Agent, github: GithubHookMetadata): 'primary' | { repoFullName: string } | undefined {
    if (this.githubWorkspaceMatches(agent, github)) return 'primary'
    const hookRepo = githubRepoKey(github.repoFullName)
    if (hookRepo === undefined) return undefined
    const row = (agent.workspace.additionalRepos ?? []).find((entry) => githubRepoKey(entry.repoFullName) === hookRepo)
    return row ? { repoFullName: row.repoFullName } : undefined
  }

  private githubWorkspaceMatches(agent: Agent, github: GithubHookMetadata): boolean {
    if (agent.workspace.mode !== 'git-repo' || !agent.workspace.gitRepo) return false
    try {
      const clone = normalizeGitCloneUrl(agent.workspace.gitRepo)
      const cloneHost = new URL(clone).hostname.toLowerCase()
      // App-backed workspace URLs are canonicalized to GitHub by the daemon.
      // Anonymous repos must already name GitHub; never reinterpret another
      // host's owner/repo path as the trusted hook repository.
      if (agent.workspace.gitCredential !== 'github-app' && cloneHost !== 'github.com') return false
      const workspaceRepo = normalizeGithubRepoUrl(agent.workspace.gitRepo)
        .replace(/\.git$/i, '')
        .toLowerCase()
      const hookRepo = normalizeGithubRepoUrl(github.repoFullName)
        .replace(/\.git$/i, '')
        .toLowerCase()
      return workspaceRepo === hookRepo
    } catch {
      return false
    }
  }

  /** Display label of the user a session is opened by — it names the session
   * worktree's branch (`dev/<user>/<words>`). Presentation only. */
  async sessionInitiatorLabel(msg: NormalizedMessage): Promise<string> {
    // The routing identity a session is keyed by, which for a GitHub hook is the hook —
    // `initiatorLabel` then falls through to the actor who fired it.
    const initiator = msg.sessionTriggerId ?? msg.sender?.id ?? ''
    return initiatorLabel(initiator, (await this.host.displayNames([initiator])).get(initiator), msg.sender)
  }

  /** Prepare an exact, isolated checkout before a formal review generation. A
   * formal review may use GitHub read-only inspection when its configured local
   * repo differs, but it must never silently fall back to a stale checkout.
   * Ordinary PR conversations preserve their stable session worktree. */
  async prepareGithubReviewWorkspace(
    entry: QueueEntry,
    key: string,
    agent: Agent
  ): Promise<{
    workspaceIsolation?: 'shared' | 'session'
    forceWorkspaceIsolation?: true
    preparedWorkspaceCwd?: string
  }> {
    if (!this.githubFormalReviewEnabled(entry)) return {}

    const github = await this.ensureGithubPullRevision(entry, true)
    if (!github?.headSha || !github.baseSha || github.pullNumber === undefined) {
      throw new Error('github review blocked: authoritative PR base and head are unavailable')
    }

    const revisionLine = `Base SHA: ${github.baseSha}\nHead SHA: ${github.headSha}`
    const warmHost = this.host.warmHostFor(agent.id)
    const useRevisionOnlyWorkspace = async () => {
      entry.msg.text +=
        `\n\nTrusted review revision:\n${revisionLine}\n` +
        'No trusted local pull-request checkout is available for this review. Do not trust local files or repository traces; inspect the exact base and head through GitHub read-only tools. Local execution may be skipped.'
      try {
        const preparedWorkspaceCwd = await this.host.prepareAgentWorkspace(agent, warmHost, {
          sessionKey: key,
          isolation: 'session',
          initiatedBy: await this.sessionInitiatorLabel(entry.msg),
          githubReviewRevisionOnly: true
        })
        return { workspaceIsolation: 'session' as const, forceWorkspaceIsolation: true as const, preparedWorkspaceCwd }
      } catch (fallbackErr) {
        // A filesystem-level failure can still leave the ordinary workspace as
        // the runtime cwd. The prompt above explicitly removes its evidentiary
        // authority, so the review remains revision-addressed instead of dying
        // solely because a clean local directory could not be materialized.
        this.log.warn(
          `github review: revision-only workspace unavailable; using the ordinary cwd as untrusted context (${formatErrWithCauses(fallbackErr)})`
        )
        return { workspaceIsolation: 'shared' as const, forceWorkspaceIsolation: true as const }
      }
    }
    // A secondary root reviews exactly like the primary, with the root swapped (decision 6); no root
    // at all is what the revision-only fallback exists for.
    const reviewRoot = this.reviewRootFor(agent, github)
    if (reviewRoot === undefined) {
      return useRevisionOnlyWorkspace()
    }

    try {
      const request: PrepareSessionWorkspaceRequest = {
        sessionKey: key,
        isolation: 'session',
        initiatedBy: await this.sessionInitiatorLabel(entry.msg),
        ...(reviewRoot === 'primary' ? {} : { reviewRepoFullName: reviewRoot.repoFullName }),
        review: {
          pullNumber: github.pullNumber,
          baseSha: github.baseSha,
          headSha: github.headSha,
          ...(github.mergeCommitSha ? { mergeCommitSha: github.mergeCommitSha } : {})
        }
      }
      const preparedWorkspaceCwd = await this.host.prepareAgentWorkspace(agent, warmHost, request)
      entry.msg.text +=
        `\n\nTrusted review workspace:\n${revisionLine}\n` +
        'The daemon fetched and verified this isolated checkout at the exact head or a merge whose parents are exactly the base and head above. Before trusting local traces, verify `git rev-parse HEAD`; do not switch to or inspect another checkout.' +
        // Decision 10: the other roots stand at their default branches, so only the cwd is the revision.
        ((await this.host.sessionHasReferenceDirectories(agent, request))
          ? ' Additional repositories are available as separate directories at their default branches for reference only; the reviewed revision is the working directory.'
          : '')
      return { workspaceIsolation: 'session', forceWorkspaceIsolation: true, preparedWorkspaceCwd }
    } catch (err) {
      this.log.warn(
        `github review: exact checkout unavailable; continuing with trusted revision only (${formatErrWithCauses(err)})`
      )
      return useRevisionOnlyWorkspace()
    }
  }

  /** Resolve a PR revision if the webhook omitted it (notably
   * issue_comment), cross the CP hook/start barrier, then return the active
   * review authority. Failure only disables structured effects; the agent turn
   * continues, while ordinary fallback remains governed by durable formal-
   * attempt state. */
  async prepareGithubTurn(entry: QueueEntry, sessionId: string): Promise<ActiveGithubTurnMeta | undefined> {
    const hook = entry.hookContext
    const snapshot = hook?.snapshot
    const github = hook?.github
    if (
      !hook ||
      !snapshot ||
      !github ||
      github.subjectKind !== 'pull_request' ||
      github.pullNumber === undefined ||
      (snapshot.reviewPolicy === 'off' && snapshot.reportingMode === 'off') ||
      snapshot.gateMode !== 'informational' ||
      snapshot.reportingMode === 'status'
    )
      return undefined
    if (this.host.daemonId() && snapshot.dispatchDaemonId !== this.host.daemonId()) {
      this.log.warn(`github review: stale dispatch daemon for ${hook.hookId}:${hook.deliveryKey}`)
      return undefined
    }

    if (!github.headSha || !github.baseSha) await this.ensureGithubPullRevision(entry, false)

    const trusted = hook.github!
    if (!trusted.headSha || !trusted.baseSha || trusted.pullNumber === undefined) return undefined
    const client = this.host.cpClient()
    if (!client) return undefined
    const payload = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      // The CP files the run against `session_meta.id` and deep-links the console from it, so
      // this is the session's outward id (§1.1) — the caller holds the ACP hop's.
      sessionId: (await this.host.outwardSessionId(hook.agentId, sessionId)) ?? sessionId,
      ...(hook.event ? { event: hook.event } : {}),
      github: { ...trusted, reportSha: trusted.reportSha ?? trusted.headSha },
      ...snapshot
    }
    let started = false
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      try {
        await client.startHook(payload)
        started = true
      } catch (err) {
        if (attempt === 2) {
          this.log.warn(`github review: hook/start rejected (${formatErr(err)})`)
          return undefined
        }
        // The daemon ACK and relay rc/run-report travel on different sockets;
        // let the accepted row land before repeating this idempotent barrier.
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
    if (
      snapshot.reviewPolicy === 'off' ||
      isGithubReviewCommentHook(hook) ||
      !githubOpensReviewGeneration(hook.event, trusted, snapshot.reviewPolicy)
    )
      return undefined
    const recoverableAttempt =
      hook.reviewAttemptId !== undefined &&
      hook.reviewRequestedEvent !== undefined &&
      hook.reviewRequestedVerdict !== undefined &&
      (hook.reviewResult === undefined || hook.reviewResult.state === 'ambiguous')
    const active: ActiveGithubTurnMeta = {
      entry,
      hook,
      snapshot,
      repoId: trusted.repoId,
      repoFullName: trusted.repoFullName,
      pullNumber: trusted.pullNumber,
      expectedHeadSha: trusted.headSha,
      expectedBaseSha: trusted.baseSha,
      reportSha: trusted.reportSha ?? trusted.headSha,
      sessionId,
      reviewState: hook.reviewAttemptId === undefined || recoverableAttempt ? 'idle' : 'done'
    }
    if (recoverableAttempt) await this.reconcileGithubReviewAttempt(active)
    return active
  }

  /** Store the immediate and terminal-report copies together so they cannot
   * drift across submit and restart-recovery paths. */
  async persistGithubReviewEffect(
    active: ActiveGithubTurnMeta,
    attemptId: string,
    effect: GithubReviewEffect,
    required = false
  ): Promise<HookReviewResult> {
    const result = reviewResultForWire(effect)
    active.hook.reviewResult = result
    active.hook.reviewReportAttemptId = attemptId
    active.hook.reviewReportResult = result
    await this.host.persistHookState(active.entry, undefined, required)
    return result
  }

  /** A daemon restart may replay an attempt after an ambiguous POST/list race.
   * Before prompting the model, perform a GET-only marker reconciliation. A
   * still-missing marker remains blocked; only an explicit tool invocation can
   * cross the full reauthorization + revision fence and retry the mutation. */
  async reconcileGithubReviewAttempt(active: ActiveGithubTurnMeta): Promise<void> {
    const cp = this.host.cpClient()
    const attemptId = active.hook.reviewAttemptId
    const requestedEvent = active.hook.reviewRequestedEvent
    const requestedVerdict = active.hook.reviewRequestedVerdict
    if (!cp || !attemptId || !requestedEvent || !requestedVerdict) return
    try {
      const authorization: Parameters<CpClient['authorizeGithubReview']>[0] = {
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        requestedEvent,
        requestedVerdict,
        snapshot: active.snapshot
      }
      const orgId = this.host.orgForAgent(active.hook.agentId)
      const authorized = orgId
        ? await cp.authorizeGithubReview(authorization, orgId)
        : await cp.authorizeGithubReview(authorization)
      if (!authorizedReviewTargetMatches(active, attemptId, authorized)) {
        this.log.warn('github review: recovery authorization returned a mismatched target')
        return
      }
      const effect = await this.githubReviewClient.reconcile(
        authorizedReviewTarget(active, attemptId, authorized, true),
        requestedEvent,
        requestedVerdict
      )
      // Reconciliation never proves a no-effect result: a visible marker is
      // submitted; a missing/unreadable marker remains ambiguous. Persist and
      // report both so restart completion carries the current attempt outcome
      // and the CP reservation converges to submitted or blocked.
      if (effect.state === 'not_submitted') return
      const result = await this.persistGithubReviewEffect(active, attemptId, effect, true)
      const report: Parameters<CpClient['reportGithubReviewResult']>[0] = {
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        snapshot: active.snapshot,
        result
      }
      if (orgId) await cp.reportGithubReviewResult(report, orgId)
      else await cp.reportGithubReviewResult(report)
      // Ambiguous keeps the same durable attempt eligible for an explicit
      // marker-first retry; submitted is terminal for this turn.
      active.reviewState = effect.state === 'ambiguous' ? 'idle' : 'done'
    } catch (err) {
      this.log.warn(`github review: replay reconciliation deferred (${formatErr(err)})`)
    }
  }

  async submitGithubReview(req: SubmitGithubReviewReq): Promise<GithubReviewEffect> {
    const key = sessionKey(req.platform, req.channel, req.thread, req.agentId, req.transportScope)
    const active = this.host.activeGithubTurn(key)
    if (!active || active.hook.agentId !== req.agentId) {
      throw new Error('formal GitHub review is only available during the active PR hook turn')
    }
    if (isGithubReviewCommentHook(active.hook)) {
      throw new Error('formal GitHub review is unavailable for an inline review-comment reply turn')
    }
    if (!reviewPolicyAllows(active.snapshot.reviewPolicy, req.event)) {
      throw new Error(`${req.event} exceeds this hook's ${active.snapshot.reviewPolicy} review policy`)
    }
    if (active.reviewState !== 'idle') {
      throw new Error('this PR hook turn already has a formal review attempt')
    }
    // Synchronous turn-local CAS before the first await.
    active.reviewState = 'submitting'
    const previousReviewState = {
      reviewAttemptId: active.hook.reviewAttemptId,
      reviewRequestedEvent: active.hook.reviewRequestedEvent,
      reviewRequestedVerdict: active.hook.reviewRequestedVerdict,
      reviewResult: active.hook.reviewResult,
      reviewReportAttemptId: active.hook.reviewReportAttemptId,
      reviewReportResult: active.hook.reviewReportResult
    }
    const recovering = active.hook.reviewAttemptId !== undefined
    if (recovering) {
      if (
        active.hook.reviewRequestedEvent === undefined ||
        active.hook.reviewRequestedVerdict === undefined ||
        active.hook.reviewRequestedEvent !== req.event ||
        active.hook.reviewRequestedVerdict !== req.verdict
      ) {
        active.reviewState = 'idle'
        throw new Error('a recovered formal-review attempt must keep its original event and verdict')
      }
    } else {
      if (!githubFallbackAllowed(active.hook)) {
        active.reviewState = 'done'
        throw new Error('a fresh formal-review retry requires the prior attempt to be definitively not_submitted')
      }
      // A prior definite no-effect attempt may have been retained only for the
      // terminal HookReport. A fresh retry supersedes it: clear every unversioned
      // result before the record-first write so a crash cannot mistake the old
      // `not_submitted` outcome for proof that this new attempt had no effect.
      delete active.hook.reviewResult
      delete active.hook.reviewReportAttemptId
      delete active.hook.reviewReportResult
      active.hook.reviewRequestedEvent = req.event
      active.hook.reviewRequestedVerdict = req.verdict
    }
    const attemptId = active.hook.reviewAttemptId ?? randomUUID()
    active.hook.reviewAttemptId = attemptId
    const entry = active.entry
    try {
      // RECORD-FIRST: after this point a crash/replay knows it must reconcile
      // the marker before any possible second POST.
      await this.host.persistHookState(entry, undefined, true)
    } catch (err) {
      if (!recovering) {
        Object.assign(active.hook, previousReviewState)
      }
      active.reviewState = 'idle'
      throw new Error(`formal review durability barrier failed: ${formatErr(err)}`)
    }

    const cp = this.host.cpClient()
    if (!cp) {
      active.reviewState = 'done'
      throw new Error('control plane is not connected; formal review denied')
    }
    let authorized: Awaited<ReturnType<CpClient['authorizeGithubReview']>>
    try {
      const authorization: Parameters<CpClient['authorizeGithubReview']>[0] = {
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        requestedEvent: req.event,
        requestedVerdict: req.verdict,
        snapshot: active.snapshot
      }
      const orgId = this.host.orgForAgent(req.agentId)
      authorized = orgId
        ? await cp.authorizeGithubReview(authorization, orgId)
        : await cp.authorizeGithubReview(authorization)
    } catch (err) {
      active.reviewState = 'done'
      throw err
    }
    if (!authorizedReviewTargetMatches(active, attemptId, authorized)) {
      active.reviewState = 'done'
      throw new Error('control plane returned a mismatched formal-review target')
    }

    const effect = await this.githubReviewClient.submit(
      authorizedReviewTarget(active, attemptId, authorized, recovering),
      req,
      this.agents.get(req.agentId)?.output.showFooter
        ? await this.githubCommentAttribution(req.agentId, active.sessionId)
        : undefined
    )
    const result = await this.persistGithubReviewEffect(active, attemptId, effect)
    try {
      const report: Parameters<CpClient['reportGithubReviewResult']>[0] = {
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        snapshot: active.snapshot,
        result
      }
      const orgId = this.host.orgForAgent(req.agentId)
      if (orgId) await cp.reportGithubReviewResult(report, orgId)
      else await cp.reportGithubReviewResult(report)
      if (effect.state === 'not_submitted') {
        // CP proved/released the no-effect reservation; this turn may correct
        // its input and try again with a fresh attempt id.
        delete active.hook.reviewAttemptId
        delete active.hook.reviewRequestedEvent
        delete active.hook.reviewRequestedVerdict
        delete active.hook.reviewResult
        active.reviewState = 'idle'
        await this.host.persistHookState(entry)
      } else if (effect.state === 'ambiguous') {
        // The reservation and semantic input stay fixed. A later tool call may
        // only reconcile that same marker (and, after a complete no-marker
        // read plus fresh fences, retry the same logical attempt).
        active.reviewState = 'idle'
      } else {
        active.reviewState = 'done'
      }
    } catch (err) {
      // Completion repeats the body-free result. Submitted/definite failures
      // never retry; an ambiguous attempt remains eligible only for the
      // marker-first recovery path above.
      active.reviewState = effect.state === 'ambiguous' ? 'idle' : 'done'
      this.log.warn(`github review: immediate result report failed (${formatErr(err)})`)
    }
    return effect
  }

  async replyGithubReviewThreads(req: ReplyGithubReviewThreadsReq): Promise<ReplyGithubReviewThreadsResult> {
    const key = sessionKey(req.platform, req.channel, req.thread, req.agentId, req.transportScope)
    const active = this.host.activeGithubReplyBatch(key)
    const batch = active?.entry.hookContext?.githubReviewBatch
    if (!active || !batch?.sealed || batch.items.length < 2 || active.entry.agentId !== req.agentId) {
      throw new Error('batched GitHub replies are only available during the active submitted-review comment turn')
    }
    if (active.called) throw new Error('this GitHub review-comment batch already used its reply tool')
    // Every GitHub batch item is opened from a trusted inline-thread root, so each carries its own reply target.
    const items = batch.items.filter((item) => item.reply !== undefined)
    const expected = new Set(items.map((item) => item.reply!.reviewThreadRootCommentId))
    const supplied = new Map<string, string>()
    for (const reply of req.replies) {
      if (supplied.has(reply.threadRootCommentId)) {
        throw new Error(`duplicate GitHub review thread root ${reply.threadRootCommentId}`)
      }
      supplied.set(reply.threadRootCommentId, reply.body)
    }
    if (supplied.size !== expected.size || [...supplied].some(([root]) => !expected.has(root))) {
      throw new Error(`reply exactly once to every authorized GitHub review thread: ${[...expected].join(', ')}`)
    }
    active.called = true
    const results: ReplyGithubReviewThreadsResult['replies'] = []
    for (const item of items) {
      const reply = item.reply!
      const root = reply.reviewThreadRootCommentId
      if (item.publishState === 'in_flight') {
        results.push({ threadRootCommentId: root, state: 'ambiguous' })
        continue
      }
      if (item.publishState === 'settled') {
        results.push({
          threadRootCommentId: root,
          state: 'settled',
          ...(item.publishedComment ? { commentId: item.publishedComment.commentId } : {})
        })
        continue
      }
      item.publishState = 'in_flight'
      await this.host.persistHookState(active.entry, undefined, true)
      const published = await this.makeGithubReply(req.agentId, reply, active.sessionId).poster.publish(
        supplied.get(root)!
      )
      // Batch replies are a GitHub-only surface (inline review threads) — narrow away the gitlab arm of the shared poster union.
      const comment = published && !('provider' in published) ? published : undefined
      if (comment) item.publishedComment = comment
      item.publishState = 'settled'
      await this.host.persistHookState(active.entry, undefined, true)
      results.push({
        threadRootCommentId: root,
        state: comment ? 'published' : 'settled',
        ...(comment ? { commentId: comment.commentId } : {})
      })
    }
    return { replies: results }
  }
  /** Build the per-turn GitHub final-answer selector and poster, tokened
   *  via the repo-targeted gitcred mint (issues/PR write, no contents — never
   *  enters agent env). Attribution is resolved at publish time so the completed
   *  comment carries the session's final runtime/model selection. */
  makeGithubReply(
    agentId: string,
    ref: GithubReplyTarget,
    sessionId: string
  ): { poster: GithubFinalPoster | GitlabFinalPoster; collector: GithubReplyCollector } {
    if (ref.provider === 'gitlab') {
      return {
        collector: new GithubReplyCollector(),
        poster: new GitlabFinalPoster(
          {
            token: async () => (await this.host.getGitlabPostToken(agentId, ref.repo, ref.hookId)).token,
            invalidateToken: (token) => this.host.invalidateGitlabPost(agentId, ref.repo, token),
            // §24.4: the instance this agent's spec names, read when the note is actually posted.
            apiBaseUrl: () => gitlabApiBaseUrl(this.agents.get(agentId)?.gitlabHost),
            log: { warn: (m: string) => this.log.warn(m) }
          },
          ref.repo,
          ref.subjectKind ?? 'issue',
          ref.number,
          () =>
            this.agents.get(agentId)?.output.showFooter ? this.githubCommentAttribution(agentId, sessionId) : undefined
        )
      }
    }
    return {
      collector: new GithubReplyCollector(),
      poster: new GithubFinalPoster(
        {
          token: async () => (await this.host.getPostToken(agentId, ref.repo, ref.hookId)).token,
          invalidateToken: (token) => this.host.invalidatePost(agentId, ref.repo, token),
          log: { warn: (m: string) => this.log.warn(m) }
        },
        ref.repo,
        ref.number,
        () =>
          this.agents.get(agentId)?.output.showFooter ? this.githubCommentAttribution(agentId, sessionId) : undefined,
        ref.reviewThreadRootCommentId
      )
    }
  }

  async githubCommentAttribution(agentId: string, sessionId: string): Promise<GithubCommentAttribution> {
    const agent = this.agents.get(agentId)
    const runtime = agent?.runtime
    // The footer links the console, which knows this session by its outward id (§1.1).
    const outward = await this.host.outwardSessionId(agentId, sessionId)
    return {
      agentName: agent?.displayName?.trim() || agent?.name || agentId,
      agentUrl: this.host.agentLink(agentId),
      runtime: runtime ? (this.host.runtimeNames()[runtime] ?? runtime) : 'unknown',
      model:
        (await this.host.hostForStoredSession(agentId, sessionId))?.modelOptions?.(sessionId)?.current ??
        agent?.runtimeOverrides?.model ??
        'default',
      sessionUrl: this.host.sessionLink(outward ?? sessionId, 'github'),
      // Same CP-resolved public avatar Slack uses for icon_url; GitHub renders it
      // inline ahead of the footer sentence.
      ...(agent?.iconUrl ? { iconUrl: agent.iconUrl } : {})
    }
  }
}

/** A github.com `owner/repo` as roots are compared by it: case-insensitive, blind to `.git`. */
function githubRepoKey(repoFullName: string): string | undefined {
  try {
    return normalizeGithubRepoUrl(repoFullName)
      .replace(/\.git$/i, '')
      .toLowerCase()
  } catch {
    return undefined
  }
}
