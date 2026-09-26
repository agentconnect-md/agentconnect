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
import { WireError } from '@agentconnect.md/connection'
import {
  HOOK_REPORT_REASON_NOTICE_ALREADY_POSTED,
  HOOK_REPORT_REASON_NOTICE_POSTED,
  gitRepoLabel,
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  pickCodeHostHookMembers,
  type CodeHostProvider,
  type DecisionRuntimeTarget,
  type GithubHookMetadata,
  type HookReviewResult,
  type RdAck,
  type RdHookNotice,
  type RdHookRouting,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { AcpHost } from '../acp/acp-host.js'
import type { CpClient } from '../cp/client.js'
import type { Logger } from '../log.js'
import { buildHookMessage, githubOpensReviewGeneration, hookAnchorText } from '../messages/hook-message.js'
import { appendTurnPrompt, type NormalizedMessage } from '../messages/normalized.js'
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
  hookSnapshot,
  isGithubReviewCommentHook,
  reviewPolicyAllows,
  reviewResultForWire,
  type ActiveGithubReplyBatchMeta,
  type ActiveGithubTurnMeta,
  type HookCompletionOwner,
  type HookDispatchContext,
  type SessionWorktreeCleanupResult
} from './hook-coords.js'
import type { CallMeta, QueueEntry } from '../daemon/turn-types.js'
import type { WebchatTurnContext } from '../webchat/types.js'
import { initiatorLabel } from '../workspace/session-branch.js'
import { effectiveSessionIsolation, type PrepareSessionWorkspaceRequest } from '../workspace/workspace-manager.js'
import { GithubReplyCollector, type GithubCommentAttribution } from './poster.js'
import { acknowledgeCodeHostTrigger } from '../codehost/ack.js'
import { HOOK_NOTICE_TEXT } from '../codehost/notice.js'
import { codeHostLinkSource } from '../platforms/link-source.js'
import { replyTargetProvider, type CodeHostReplyTarget } from '../codehost/reply-target.js'
import {
  codeHostHostFence,
  codeHostPromptSupplement,
  codeHostReplyTarget,
  codeHostThreadWorktreeCleanup,
  turnFinalFor,
  type CodeHostFinalPoster,
  type CodeHostThreadWorktreeCleanup,
  type CodeHostTurnFinalHost
} from '../codehost/turn-final.js'
import { GithubReviewClient, type GithubReviewEffect } from './review.js'

/** Dispatch options this seam needs; a subset of the daemon's own. */
export interface GithubHookDispatchOptions {
  /** A hook delivery must own a durable row before the relay is ACKed. */
  requireDurable?: boolean
  /** Synchronous admission barrier, settled before any turn can start. */
  onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
}

/** The relay's suffix on a host copy's msgId, so its ack never collides with the host agent's own fire. */
export const HOOK_ROUTE_MSG_SUFFIX = ':route'

export interface AnchorTriggerResult {
  message: NormalizedMessage | null
  postAttempted: boolean
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
  turnFinal: CodeHostTurnFinalHost
  paused(agentId: string): boolean
  draining(agentId: string): boolean
  safetyDraining(agentId: string): boolean
  safetyDrainAllows(agentId: string, key: string, reviewLane?: string): boolean
  /** Generic hook-report plumbing stays on the Daemon; this seam only calls it. */
  persistInbox(
    entry: QueueEntry,
    key: string,
    options?: { required?: boolean; adoptExisting?: boolean; existingId?: string; receiptId?: string }
  ): Promise<'inserted' | 'adopted' | 'existing' | 'skipped' | 'failed'>
  persistHookState(
    entry: QueueEntry,
    posterPublishState?: QueueEntry['posterPublishState'],
    required?: boolean
  ): Promise<void>
  /** Record a routed event's host copy and choose its hooks (code-host-decisions.md §5); never a turn. */
  routeHookHostCopy(msg: RdMsgHook & { routing: RdHookRouting }, recorded: NormalizedMessage): Promise<RdAck>
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
  ): Promise<AnchorTriggerResult>
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: GithubHookDispatchOptions,
    githubReply?: CodeHostReplyTarget,
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
  storedSessionExecution(
    agentId: string,
    acpSessionId: string
  ): Promise<{ host?: AcpHost; target?: DecisionRuntimeTarget }>
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

  private get turnFinalHost(): CodeHostTurnFinalHost {
    return this.host.turnFinal
  }

  constructor(private readonly host: GithubReviewHost) {}

  private get log(): Logger {
    return this.host.log()
  }

  private get agents(): Map<string, LoadedAgent> {
    return this.host.agents()
  }

  /** A prior durable admission owns this GUID even when current lifecycle gates would refuse new work. */
  async replayDurableAdmission(msg: RdMsgHook): Promise<RdAck | undefined> {
    if (!(await this.host.hasInbox(msg.msgId))) return undefined
    this.log.debug(`hook: durable duplicate ${msg.msgId} — replaying accepted admission`)
    return { msgId: msg.msgId, accepted: true }
  }

  /**
   * Ack-verdict gate for one hook fire (`rd/msg` hook member) — the mirror of
   * {@link dispatchWebchatTurn}'s synchronous gates: the relay's rc/run-report
   * needs a REASONED rejection now, not a silently dropped fire-and-forget
   * dispatch. Accepted is returned only after {@link onHookFire} has crossed
   * the durable-inbox admission barrier; the model turn itself remains async.
   */
  async dispatchRelayHook(msg: RdMsgHook): Promise<RdAck> {
    if (msg.routing) return await this.routeHostCopy({ ...msg, routing: msg.routing })
    const durable = await this.replayDurableAdmission(msg)
    if (durable) return durable
    const cleanup = codeHostThreadWorktreeCleanup(msg)
    const maintenance = cleanup !== undefined || githubDeletedHookEvent(msg)
    const agent = this.agents.get(msg.agentId)
    if (!agent) {
      this.log.warn(`hook: no agent "${msg.agentId}" on this daemon — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    // §24.4: a delivery naming another instance than the spec is REFUSED, never re-targeted.
    const hostMismatch = codeHostHostFence(msg, this.turnFinalHost)
    if (hostMismatch) return { msgId: msg.msgId, accepted: false, reason: hostMismatch }
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
      const durableAfterGate = await this.replayDurableAdmission(msg)
      if (durableAfterGate) return durableAfterGate
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

  // Recording and choosing are not agent work, so a paused or draining host still keeps the thread whole and answers the relay.
  private async routeHostCopy(msg: RdMsgHook & { routing: RdHookRouting }): Promise<RdAck> {
    if (!this.agents.get(msg.agentId)) {
      this.log.warn(`hook: no agent "${msg.agentId}" on this daemon — rejecting host copy ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    const hostMismatch = codeHostHostFence(msg, this.turnFinalHost)
    if (hostMismatch) return { msgId: msg.msgId, accepted: false, reason: hostMismatch }
    // The copy's msgId is `<hookId>:<deliveryKey>:route`; its row uses the base identity, the one the host's own fire writes.
    const base = msg.msgId.endsWith(HOOK_ROUTE_MSG_SUFFIX)
      ? msg.msgId.slice(0, -HOOK_ROUTE_MSG_SUFFIX.length)
      : msg.msgId
    const recorded = buildHookMessage({ ...msg, msgId: base, target: undefined }, randomUUID())
    return await this.host.routeHookHostCopy(msg, recorded)
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
    if (msg.notice !== undefined) return this.postHookNotice(msg, msg.notice)
    const cleanup = codeHostThreadWorktreeCleanup(msg)
    const deleted = githubDeletedHookEvent(msg)
    // A lifecycle cleanup always addresses the stable GitHub thread session,
    // never an optional IM anchor configured for ordinary hook output.
    const supplement = cleanup || deleted ? undefined : await codeHostPromptSupplement(msg, this.turnFinalHost)
    const nmsg = buildHookMessage(cleanup || deleted ? { ...msg, target: undefined } : msg, randomUUID(), supplement)
    // A routed fire renders why it was chosen beside the event; it has no background rows to pick.
    if (msg.routeSelection && !cleanup && !deleted)
      nmsg.channelIntake = { seq: 0, backgroundSeqs: [], hookRoute: msg.routeSelection }
    const snapshot = hookSnapshot(msg)
    const hookContext: HookDispatchContext = {
      hookId: msg.hookId,
      agentId: msg.agentId,
      deliveryKey: msg.deliveryKey,
      firedAt: msg.firedAt,
      ...(msg.event ? { event: msg.event } : {}),
      ...(msg.context ? { context: msg.context } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...pickCodeHostHookMembers(msg)
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
    // P3 outbound: a code-host fire on a NUMBERED subject publishes its completed reply as one
    // comment (always on — design; a push has no thread and stays silent). Which coordinates
    // that is belongs to the delivery's own turn-final member.
    const githubReply = codeHostReplyTarget(msg)
    if (githubReply) hookContext.githubReply = githubReply
    const reviewLane = reviewSubjectLane(hookContext, hookCoordinates(msg.agentId, nmsg, msg.target?.integrationId))
    const anchor = await this.host.anchorTrigger(
      msg.agentId,
      nmsg,
      msg.target,
      hookAnchorText(msg),
      `hook "${msg.hookId}"`,
      reviewLane
    )
    const anchored = anchor.message
    if (!anchored) return { accepted: false, reason: anchor.postAttempted ? 'anchor_side_effect' : 'dropped' }
    // The assembled prompt rides beside the short form: a host whose delivery was supplemented (§8) batches that, not the summary.
    const batch = openReviewBatch(
      hookContext,
      hookCoordinates(msg.agentId, anchored, msg.target?.integrationId),
      anchored.text,
      this.host.now(),
      anchored.turnBody?.prompt
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
      const reason = admission.reason ?? 'durability'
      return { accepted: false, reason: reason === 'draining' && anchor.postAttempted ? 'anchor_side_effect' : reason }
    }
    return { accepted: true }
  }

  /**
   * A relay-authored `notice` delivery: one fixed-text post on the thread, no model turn. The
   * durable inbox key is the THREAD's, not the delivery's, so a thread is told once — a second
   * refused mention finds the first receipt and only closes its own run row.
   */
  private async postHookNotice(msg: RdMsgHook, notice: RdHookNotice): Promise<{ accepted: boolean; reason?: string }> {
    const nmsg = buildHookMessage({ ...msg, target: undefined }, randomUUID())
    // No snapshot and no subject on the completion: the run row must stay inert to every Check,
    // note and status projection, so it can never displace what the refused revision left behind.
    const hookContext: HookDispatchContext = {
      hookId: msg.hookId,
      agentId: msg.agentId,
      deliveryKey: msg.deliveryKey,
      firedAt: msg.firedAt,
      ...(msg.event ? { event: msg.event } : {})
    }
    const key = sessionKey(nmsg.platform, nmsg.channel, nmsg.thread ?? nmsg.msgId, msg.agentId, nmsg.transportScope)
    const entry: QueueEntry = {
      agentId: msg.agentId,
      msg: nmsg,
      initAbort: new AbortController(),
      hookContext,
      resolve: () => {},
      reject: () => {}
    }
    // The admission row is per delivery and is retired with the run; the RECEIPT is per thread and
    // outlives it, so the second refused mention loses this CAS and posts nothing. The row's own key
    // stays off the session's inbox key so retention never reads a notice as a pending model turn.
    const persistence = await this.host.persistInbox(entry, `notice:${key}`, {
      required: true,
      receiptId: `notice:${notice}:${key}`
    })
    if (persistence === 'existing') {
      await this.host.emitHookCompletion(
        hookContext,
        'success',
        { reason: HOOK_REPORT_REASON_NOTICE_ALREADY_POSTED },
        entry
      )
      return { accepted: true }
    }
    if (persistence !== 'inserted' && persistence !== 'adopted') return { accepted: false, reason: 'durability' }
    void this.completeHookNotice(msg, notice, hookContext, entry)
    return { accepted: true }
  }

  private async completeHookNotice(
    msg: RdMsgHook,
    notice: RdHookNotice,
    hook: HookDispatchContext,
    owner: HookCompletionOwner
  ): Promise<void> {
    try {
      const target = codeHostReplyTarget(msg)
      if (!target) {
        await this.host.emitHookCompletion(hook, 'success', { reason: 'notice_no_reply_target' }, owner)
        return
      }
      const published = await this.makeNoticePoster(msg.agentId, target).publish(HOOK_NOTICE_TEXT[notice])
      await this.host.emitHookCompletion(
        hook,
        published ? 'success' : 'failed',
        { reason: published ? HOOK_REPORT_REASON_NOTICE_POSTED : 'notice_post_failed' },
        owner
      )
    } catch (err) {
      this.log.warn(`hook notice: ${notice} on ${msg.sessionKey} failed: ${formatErr(err)}`)
      await this.host.emitHookCompletion(hook, 'failed', { reason: 'notice_post_failed' }, owner).catch(() => undefined)
    }
  }

  async completeGithubThreadWorktreeCleanup(
    hook: HookDispatchContext,
    key: string,
    cleanup: CodeHostThreadWorktreeCleanup,
    owner: HookCompletionOwner
  ): Promise<void> {
    let session: { sessionId?: string } = {}
    try {
      // Let the last turn settle before cleaning up its worktree.
      await this.host.activeDispatchDone(key)?.catch(() => undefined)
      const rec = await this.host.getSession(key)
      if (!rec) {
        this.log.info(`github lifecycle: ${cleanup} has no session worktree for ${key}`)
        await this.host.emitHookCompletion(hook, 'success', { reason: 'worktree_cleanup_no_session' }, owner)
        return
      }
      session = rec.acpSessionId ? { sessionId: rec.acpSessionId } : {}
      const result = await this.host.cleanupSessionWorktree(rec)
      if (result.outcome === 'failed') {
        this.log.warn(`github lifecycle: ${cleanup} worktree cleanup failed for ${key} (${result.error})`)
        await this.host.emitHookCompletion(hook, 'failed', { ...session, reason: 'worktree_cleanup_failed' }, owner)
        return
      }
      if (result.outcome === 'retained') {
        this.log.info(`github lifecycle: ${cleanup} retained worktree for ${key} (${result.reason})`)
        await this.host.emitHookCompletion(
          hook,
          'success',
          { ...session, reason: `worktree_cleanup_retained_${result.reason}` },
          owner
        )
        return
      }
      if (result.outcome === 'active') {
        this.log.info(`github lifecycle: ${cleanup} deferred worktree cleanup for active session ${key}`)
        await this.host.emitHookCompletion(
          hook,
          'success',
          { ...session, reason: 'worktree_cleanup_deferred_active' },
          owner
        )
        return
      }
      this.log.info(`github lifecycle: ${cleanup} worktree cleanup ${result.outcome} for ${key}`)
      await this.host.emitHookCompletion(hook, 'success', session, owner)
    } catch (err) {
      this.log.warn(`github lifecycle: ${cleanup} worktree cleanup failed for ${key} (${formatErr(err)})`)
      await this.host.emitHookCompletion(hook, 'failed', { ...session, reason: 'worktree_cleanup_failed' }, owner)
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
      const postToken = await this.turnFinalHost.getPostToken(hook.agentId, github.repoFullName, hook.hookId)
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

  /** The root a hook's repository reviews in (multi-repository-workspaces.md decision 6): the primary, a row's, the root a GitHub installation grant covers (named by the hook's id), else none and revision-only. */
  reviewRootFor(
    agent: Agent,
    github: GithubHookMetadata
  ): 'primary' | { repoFullName: string; repoId?: string } | undefined {
    if (this.githubWorkspaceMatches(agent, github)) return 'primary'
    const hookRepo = githubRepoKey(github.repoFullName)
    if (hookRepo === undefined) return undefined
    // A GitLab project of the same path is not this hook's repository, so only GitHub rows may answer.
    const row = (agent.workspace.additionalRepos ?? []).find(
      (entry) => (entry.provider ?? 'github') === 'github' && githubRepoKey(entry.repoFullName) === hookRepo
    )
    if (row) return { repoFullName: row.repoFullName }
    const owner = gitRepoLabel(hookRepo).split('/')[0]
    const granted = (agent.workspace.additionalInstallations ?? []).some(
      (grant) => (grant.provider ?? 'github') === 'github' && grant.accountLogin.toLowerCase() === owner
    )
    return granted ? { repoFullName: gitRepoLabel(github.repoFullName), repoId: github.repoId } : undefined
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

  /** Display label of the user a session is opened by, which names its branch (`a10t/<user>/<words>`); presentation only. */
  async sessionInitiatorLabel(msg: NormalizedMessage): Promise<string> {
    // The routing identity a session is keyed by, which for a GitHub hook is the hook —
    // `initiatorLabel` then falls through to the actor who fired it.
    const initiator = msg.sessionTriggerId ?? msg.sender?.id ?? ''
    return initiatorLabel(initiator, (await this.host.displayNames([initiator])).get(initiator), msg.sender)
  }

  /** The isolation this session ALREADY has, or the one it will be created with — never one a review picks for it. A formal review may ASK for isolation (an exact checkout has to be its own); a degraded one may not take it away. */
  private async sessionIsolationFor(key: string, agent: Agent): Promise<'shared' | 'session'> {
    const recorded = (await this.host.getSession(key))?.workspaceIsolation
    if (recorded) return recorded
    return effectiveSessionIsolation(agent)
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

    const hook = entry.hookContext
    const client = this.host.cpClient()
    if (client && hook?.snapshot) {
      const payload = {
        hookId: hook.hookId,
        agentId: hook.agentId,
        deliveryKey: hook.deliveryKey,
        ...hook.snapshot
      }
      // Relay accepted can arrive after daemon dispatch; retry without holding up workspace preparation.
      void (async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await client.prepareHook(payload)
            return
          } catch {
            if (attempt === 4) return
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
          }
        }
      })()
    }

    const github = await this.ensureGithubPullRevision(entry, true)
    if (!github?.headSha || !github.baseSha || github.pullNumber === undefined) {
      throw new Error('github review blocked: authoritative PR base and head are unavailable')
    }

    const revisionLine = `Base SHA: ${github.baseSha}\nHead SHA: ${github.headSha}`
    const warmHost = this.host.warmHostFor(agent.id)
    // Degrading is a statement about WHAT this review checks out, never about which tier the session
    // lives in (git-workspace-model §11): moving the tier under a live session leaves preparation and
    // the launch addressing different directories, and every later turn failing its cwd containment.
    const useRevisionOnlyWorkspace = async () => {
      appendTurnPrompt(
        entry.msg,
        `\n\nTrusted review revision:\n${revisionLine}\n` +
          'No trusted local pull-request checkout is available for this review. Do not trust local files or repository traces; inspect the exact base and head through GitHub read-only tools. Local execution may be skipped.'
      )
      // A session with no per-session directory has nowhere to stage the empty stand-in; the prompt
      // above already removes the ordinary cwd's evidentiary authority, which is the same degradation.
      if ((await this.sessionIsolationFor(key, agent)) === 'shared') return {}
      try {
        const preparedWorkspaceCwd = await this.host.prepareAgentWorkspace(agent, warmHost, {
          sessionKey: key,
          isolation: 'session',
          initiatedBy: await this.sessionInitiatorLabel(entry.msg),
          githubReviewRevisionOnly: true
        })
        return { preparedWorkspaceCwd }
      } catch (fallbackErr) {
        // A filesystem-level failure can still leave the ordinary workspace as
        // the runtime cwd. The prompt above explicitly removes its evidentiary
        // authority, so the review remains revision-addressed instead of dying
        // solely because a clean local directory could not be materialized.
        this.log.warn(
          `github review: revision-only workspace unavailable; using the ordinary cwd as untrusted context (${formatErrWithCauses(fallbackErr)})`
        )
        return {}
      }
    }
    // A secondary root reviews like the primary with the root swapped (decision 6); no root at all is the revision-only fallback's case.
    const reviewRoot = this.reviewRootFor(agent, github)
    if (reviewRoot === undefined) {
      return useRevisionOnlyWorkspace()
    }

    try {
      const request: PrepareSessionWorkspaceRequest = {
        sessionKey: key,
        isolation: 'session',
        initiatedBy: await this.sessionInitiatorLabel(entry.msg),
        ...(reviewRoot === 'primary'
          ? {}
          : {
              reviewRepoFullName: reviewRoot.repoFullName,
              ...(reviewRoot.repoId === undefined ? {} : { reviewRepoId: reviewRoot.repoId })
            }),
        review: {
          pullNumber: github.pullNumber,
          baseSha: github.baseSha,
          headSha: github.headSha,
          ...(github.mergeCommitSha ? { mergeCommitSha: github.mergeCommitSha } : {})
        }
      }
      const preparedWorkspaceCwd = await this.host.prepareAgentWorkspace(agent, warmHost, request)
      appendTurnPrompt(
        entry.msg,
        `\n\nTrusted review workspace:\n${revisionLine}\n` +
          'The daemon fetched and verified this isolated checkout at the exact head or a merge whose parents are exactly the base and head above. Before trusting local traces, verify `git rev-parse HEAD`; do not switch to or inspect another checkout.' +
          // Decision 10: the other roots stand at their default branches, so only the cwd is the revision.
          ((await this.host.sessionHasReferenceDirectories(agent, request))
            ? ' Additional repositories are available as separate directories at their default branches for reference only; the reviewed revision is the working directory.'
            : '')
      )
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
    let started: Awaited<ReturnType<CpClient['startHook']>> | undefined
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      try {
        started = await client.startHook(payload)
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
    if (snapshot.reviewPolicy === 'off') return undefined
    const opensGeneration =
      !isGithubReviewCommentHook(hook) && githubOpensReviewGeneration(hook.event, trusted, snapshot.reviewPolicy)
    // A conversation turn holds review authority only as the amendment the CP named at the barrier, on its own head.
    const amendment = opensGeneration ? undefined : started?.amendment
    if (!opensGeneration && amendment?.reportSha !== (trusted.reportSha ?? trusted.headSha)) return undefined
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
      ...(amendment ? { amendment } : {}),
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
    if (isGithubReviewCommentHook(active.hook) && !active.amendment) {
      throw new Error('formal GitHub review is unavailable for an inline review-comment reply turn')
    }
    if (!reviewPolicyAllows(active.snapshot.reviewPolicy, req.event)) {
      throw new Error(`${req.event} exceeds this hook's ${active.snapshot.reviewPolicy} review policy`)
    }
    // The CP enforces this too; refusing here keeps the turn's one attempt for a corrected call.
    if (active.amendment && (req.verdict === 'neutral' || req.verdict === active.amendment.verdict)) {
      throw new Error(
        `a verdict amendment must change the current ${active.amendment.verdict} verdict on this revision to ${
          active.amendment.verdict === 'pass' ? 'fail' : active.amendment.verdict === 'fail' ? 'pass' : 'pass or fail'
        }`
      )
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
      // A retryable wire failure wrote nothing at GitHub and the same attempt re-authorizes idempotently: keep the retry.
      if (!(err instanceof WireError && err.retryable)) {
        active.reviewState = 'done'
        throw err
      }
      active.reviewState = 'idle'
      throw new Error(`formal review not submitted: control plane unreachable (${err.message}); call the tool again`)
    }
    if (!authorizedReviewTargetMatches(active, attemptId, authorized)) {
      active.reviewState = 'done'
      throw new Error('control plane returned a mismatched formal-review target')
    }

    const effect = await this.githubReviewClient.submit(
      authorizedReviewTarget(active, attemptId, authorized, recovering),
      req,
      this.agents.get(req.agentId)?.output.showFooter
        ? await this.githubCommentAttribution(req.agentId, active.sessionId, 'github')
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
      const published = await this.makeCodeHostReply(req.agentId, reply, active.sessionId).poster.publish(
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

  /** Light the code host's "seen it" reaction on whatever fired this turn, through the same
   *  repo-targeted mint the turn's poster will use — reactions need no wider grant. Returns a
   *  promise only so tests can settle it; dispatch never awaits one. */
  acknowledgeTrigger(agentId: string, ref: CodeHostReplyTarget): Promise<void> {
    const lease = turnFinalFor(ref).effectLease(agentId, ref, this.turnFinalHost)
    return acknowledgeCodeHostTrigger(ref, {
      token: lease.token,
      apiBaseUrl: lease.apiBaseUrl,
      log: { warn: (message: string) => this.log.warn(message) }
    })
  }

  /** Build the per-turn final-answer selector and the owning host's poster, tokened via that
   *  host's effect lease. Attribution is resolved at publish time so the completed comment
   *  carries the session's final runtime/model selection. */
  /** The notice's poster: the same provider member as a turn's, minus the footer — a notice has no session to link. */
  makeNoticePoster(agentId: string, ref: CodeHostReplyTarget): CodeHostFinalPoster {
    const turnFinal = turnFinalFor(ref)
    return turnFinal.finalPoster(ref, {
      ...turnFinal.effectLease(agentId, ref, this.turnFinalHost),
      log: { warn: (m: string) => this.log.warn(m) }
    })
  }

  makeCodeHostReply(
    agentId: string,
    ref: CodeHostReplyTarget,
    sessionId: string
  ): { poster: CodeHostFinalPoster; collector: GithubReplyCollector } {
    const turnFinal = turnFinalFor(ref)
    return {
      collector: new GithubReplyCollector(),
      poster: turnFinal.finalPoster(ref, {
        ...turnFinal.effectLease(agentId, ref, this.turnFinalHost),
        attribution: () =>
          this.agents.get(agentId)?.output.showFooter
            ? this.githubCommentAttribution(agentId, sessionId, replyTargetProvider(ref))
            : undefined,
        log: { warn: (m: string) => this.log.warn(m) }
      })
    }
  }

  /** `provider` is the host that will publish this footer — it brands the session link (§7.4). */
  async githubCommentAttribution(
    agentId: string,
    sessionId: string,
    provider: CodeHostProvider
  ): Promise<GithubCommentAttribution> {
    const agent = this.agents.get(agentId)
    const execution = await this.host.storedSessionExecution(agentId, sessionId)
    const runtime = execution.target?.runtime ?? agent?.runtime
    // The footer links the console, which knows this session by its outward id (§1.1).
    const outward = await this.host.outwardSessionId(agentId, sessionId)
    return {
      agentName: agent?.displayName?.trim() || agent?.name || agentId,
      agentUrl: this.host.agentLink(agentId),
      runtime: runtime ? (this.host.runtimeNames()[runtime] ?? runtime) : 'unknown',
      model:
        execution.host?.modelOptions?.(sessionId)?.current ??
        (execution.target ? execution.target.model || 'default' : (agent?.runtimeOverrides?.model ?? 'default')),
      sessionUrl: this.host.sessionLink(outward ?? sessionId, codeHostLinkSource(provider)),
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
