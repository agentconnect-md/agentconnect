/**
 * `event/session` handler — session metadata sync (dashboard + deep links).
 *
 * `event/session` remains the rolling-compatible fire-and-forget EVT;
 * `event/session-sync` is the same latest-wins payload as a correlated request
 * whose ACK means the metadata transaction committed. Sessions are created on
 * the Slack/Discord→daemon path; the daemon reports each one's converged
 * milestone here and the CP upserts one `SessionMeta` row per `sessionId`.
 * This is what makes a session
 * deep-link (`…/sessions/:id`) resolvable from CP-stored metadata, even when the
 * daemon is offline. Metadata only — list/detail fields and sessionKey echo —
 * never the message stream (that stays daemon-local, §1/§12).
 *
 * Trust boundary: the reported agent must still be placed on the authenticated
 * daemon, and an existing sessionId remains bound to its first agent.
 */
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { isFrame, type EventSession } from '@agentconnect.md/protocol'
import { AgentId, BotId, DaemonId, HookId, IntegrationId, LaunchId, OrgId, SessionId } from '../../domain/ids.js'
import { classifySession } from '../../domain/session-visibility.js'
import type { DaemonWsDeps } from '../deps.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the ownership lookups the §4.2 classification needs, then classify.
 *
 * Both lookups fail closed by construction: they return `null` on a miss and
 * `classifySession` keeps the row `private` with no owner rather than widening
 * it (session-visibility.md §4.2). The webchat lookup is additionally scoped to
 * the reporting agent — a conversation id is only an owner claim for the agent
 * it was minted against.
 */
async function classifyMilestone(p: EventSession, agentId: AgentId, deps: DaemonWsDeps) {
  const webchatOwnerUserId =
    // An A2A child uses a daemon-minted `a2a:<caller>` channel even when the
    // parent transport is webchat. Its audience comes exclusively from the
    // parent lineage, so treating that synthetic coordinate as a CP-minted
    // webchat UUID both adds no authority and can make the UUID-backed lookup
    // reject the whole durable metadata snapshot.
    !p.parentSessionId && p.platform === 'webchat' && p.channel
      ? ((await deps.webchatConversation?.findOwner(p.channel, agentId)) ?? null)
      : null
  const launchOwnerUserId = p.launchCorrelationId
    ? ((await deps.launch?.ownerByCorrelationId(p.launchCorrelationId)) ?? null)
    : null
  return classifySession({
    ...(p.platform !== undefined ? { platform: p.platform } : {}),
    ...(p.conversationKind !== undefined ? { conversationKind: p.conversationKind } : {}),
    ...(p.transportScope !== undefined ? { transportScope: p.transportScope } : {}),
    ...(p.triggeredBy !== undefined ? { triggeredBy: p.triggeredBy } : {}),
    ...(p.parentSessionId !== undefined ? { parentSessionId: p.parentSessionId } : {}),
    ...(p.directDestination !== undefined ? { directDestination: p.directDestination } : {}),
    ...(p.launchCorrelationId !== undefined ? { launchCorrelationId: p.launchCorrelationId } : {}),
    webchatOwnerUserId,
    launchOwnerUserId
  })
}

async function externalCandidate(p: EventSession, orgId: OrgId, agentId: AgentId, deps: DaemonWsDeps) {
  const origin = p.externalOrigin
  // An explicit local source binding is authoritative; absent provenance uses the mixed-version fallback below.
  if (p.sourceBindingKind === 'local' && !origin) return undefined
  if (!origin) {
    // A2A children inherit their audience from the parent and never claim a legacy hook scope.
    if (p.parentSessionId) return undefined
    const triggerId = p.triggeredBy?.startsWith('hook:')
      ? p.triggeredBy.slice('hook:'.length)
      : p.platform === 'hook'
        ? p.channel
        : undefined
    // The reporting daemon names the hook; the frame's org fences it and the agent check below
    // binds that trust (§4).
    const hook = triggerId && UUID_RE.test(triggerId) ? await deps.hook.get(orgId, HookId(triggerId)) : null
    const legacyGithub = hook?.kind === 'github' && hook.agentId === agentId
    if (legacyGithub) return { provider: 'github', resolution: 'pending' as const }

    // During a homogeneous upgrade every new daemon reports the trusted source
    // tuple. Keep mixed-version ingest fail-closed too: an older root Slack
    // channel/group-DM milestone is a durable unresolved candidate, never an
    // ordinary org row once the owner enables the read fence. A2A children are
    // excluded here because their audience is inherited from the parent.
    const legacySharedSlack =
      !p.parentSessionId &&
      (p.platform === 'slack' || p.platform === undefined) &&
      p.channel !== undefined &&
      (p.conversationKind === 'channel' ||
        p.conversationKind === 'group_dm' ||
        (p.conversationKind === undefined && !p.channel.startsWith('D')))
    return legacySharedSlack ? { provider: 'slack', resolution: 'pending' as const } : undefined
  }
  const pending = { provider: origin.provider, resolution: 'pending' as const }
  if (origin.provider === 'github') {
    const run = await deps.hook.getRun(HookId(origin.hookId), origin.deliveryKey)
    if (!run || !deps.githubInstallation) return pending
    if (
      run.agentId !== agentId ||
      run.repoId?.toString() !== origin.resourceKey ||
      run.repoFullName !== origin.repoFullName ||
      run.sourceInstallationId?.toString() !== origin.sourceInstallationId
    ) {
      return { provider: 'github', resolution: 'invalid' as const }
    }
    const installation = await deps.githubInstallation.getByInstallationId(BigInt(origin.sourceInstallationId))
    if (!installation) return pending
    if (installation.orgId !== run.orgId) {
      return { provider: 'github', resolution: 'invalid' as const }
    }
    return {
      provider: 'github',
      resolution: 'settled' as const,
      scope: {
        realmKey: 'github.com',
        resourceKind: 'repository',
        resourceKey: origin.resourceKey,
        credentialKind: 'github_installation',
        credentialId: installation.id
      }
    }
  }
  if (!origin.integrationId || !origin.realmKey) return pending
  // The integration a reporting daemon named as the origin of a session it already proved it
  // owns, fenced on the frame's org; the ownership checks below still bind it to the agent.
  const integration = await deps.integration.get(orgId, IntegrationId(origin.integrationId))
  if (
    !integration ||
    integration.agentId !== agentId ||
    integration.platform !== origin.provider ||
    integration.status !== 'active'
  ) {
    return { provider: origin.provider, resolution: 'invalid' as const }
  }
  // The bot behind an integration row this resolver already matched against the reporting agent.
  const bot = await deps.bot?.get(orgId, BotId(integration.botId))
  const feishuRegion = bot?.platform === 'feishu' ? (bot.feishuRegion ?? 'feishu') : undefined
  const feishuAppId = bot?.feishuAppId ?? undefined
  const realmKey =
    origin.provider === 'feishu' && feishuRegion && feishuAppId
      ? `${feishuRegion}:${feishuAppId}`
      : (bot?.workspaceId ?? bot?.teamId)
  if (
    !bot ||
    bot.orgId !== integration.orgId ||
    bot.platform !== origin.provider ||
    bot.revokedAt !== null ||
    !realmKey ||
    realmKey !== origin.realmKey ||
    origin.resourceKey !== p.channel
  ) {
    return { provider: origin.provider, resolution: 'invalid' as const }
  }
  return {
    provider: origin.provider,
    resolution: 'settled' as const,
    scope: {
      realmKey,
      resourceKind: origin.resourceKind,
      resourceKey: origin.resourceKey,
      credentialKind: 'bot',
      credentialId: bot.id
    }
  }
}

async function recordEventSession(
  p: EventSession,
  orgId: OrgId,
  agentId: AgentId,
  daemonId: DaemonId,
  deps: DaemonWsDeps,
  /** Live events poke the access warmer; durable replays do not. */
  warmer?: DaemonWsDeps['sessionAccessWarmer'],
  /** Lifecycle snapshots may capture only their own session's PR. */
  pullRequestFeedback?: DaemonWsDeps['pullRequestFeedback']
): Promise<void> {
  const [classification, candidate] = await Promise.all([
    classifyMilestone(p, agentId, deps),
    externalCandidate(p, orgId, agentId, deps)
  ])
  const { recorded, session, settled } = await deps.session.recordMilestone({
    sessionId: SessionId(p.sessionId),
    ...(p.parentSessionId !== undefined ? { parentSessionId: SessionId(p.parentSessionId) } : {}),
    agentId,
    ...(p.launchId !== undefined ? { launchId: LaunchId(p.launchId) } : {}),
    phase: p.phase,
    ...(p.platform !== undefined ? { platform: p.platform } : {}),
    ...(p.channel !== undefined ? { channel: p.channel } : {}),
    ...(p.thread !== undefined ? { thread: p.thread } : {}),
    ...(p.link !== undefined ? { link: p.link } : {}),
    ...(p.summary !== undefined ? { summary: p.summary } : {}),
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.lastActivityAt !== undefined ? { lastActivityAt: new Date(p.lastActivityAt) } : {}),
    ...(p.triggeredBy !== undefined ? { triggeredBy: p.triggeredBy } : {}),
    ...(p.channelName !== undefined ? { channelName: p.channelName } : {}),
    ...(p.triggeredByName !== undefined ? { triggeredByName: p.triggeredByName } : {}),
    ...(p.threadUrl !== undefined ? { threadUrl: p.threadUrl } : {}),
    ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
    ...(p.observedModel !== undefined ? { model: p.observedModel } : p.model !== undefined ? { model: p.model } : {}),
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.fastMode !== undefined ? { fastMode: p.fastMode } : {}),
    ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}),
    ...(p.outputMode !== undefined ? { outputMode: p.outputMode } : {}),
    ...(p.workspaceIsolation !== undefined ? { workspaceIsolation: p.workspaceIsolation } : {}),
    ...(p.conversationKind !== undefined ? { conversationKind: p.conversationKind } : {}),
    ...(p.transportScope !== undefined ? { transportScope: p.transportScope } : {}),
    ...(p.launchCorrelationId !== undefined ? { launchCorrelationId: p.launchCorrelationId } : {}),
    ...(candidate ? { externalCandidate: candidate } : {}),
    classification,
    // The reporting daemon comes from the AUTHENTICATED connection, not the
    // frame payload.
    daemonId,
    at: new Date(p.ts)
  })
  if (!recorded) return
  // Confirm the capture gate for the rows whose privacy the daemon cannot
  // infer locally (§5.1): an A2A child always starts excluded and only a
  // CP-confirmed `org` state may open it, and a settled child's tier is by
  // definition news to the daemon that runs it. The ack watermark keeps this
  // to one push per revision — later milestones of the same session are silent.
  const confirm = [...settled, ...(session?.parentSessionId ? [session] : [])].filter(
    (s) => s.visibilityAckedRev < s.visibilityRev
  )
  if (confirm.length > 0) void deps.visibilityPush?.notifySessions(confirm)
  if (session) await pullRequestFeedback?.trackSession(session)
  // Publish only after the metadata commit. Browser subscribers use this as an
  // invalidation signal and immediately re-read `/sessions`; publishing first
  // would race that GET against the upsert and leave the new row invisible.
  deps.events.publish(daemonId, p)
  // A finished session waits on nobody: clear a wait its daemon never got to release (§7).
  if (p.phase === 'end' && session?.activityState === 'awaiting_permission') {
    if (await deps.session.setActivityState(SessionId(p.sessionId), agentId, 'idle')) {
      deps.events.publishState(daemonId, { agentId: p.agentId, sessionId: p.sessionId, state: 'idle', ts: p.ts })
    }
  }
  // Fire-and-forget §4.1 activity poke, after commit-then-publish: external
  // sessions only, carrying nothing but the committed scope coordinates.
  if (session?.visibility === 'external' && session.externalScopeId) {
    warmer?.poke(session.orgId, session.externalScopeId)
  }
}

export const handleEventSession: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) return
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  const daemonId = DaemonId(conn.daemonId)
  await runForReportingAgent(orgId, agentId, daemonId, deps, () =>
    recordEventSession(p, orgId, agentId, daemonId, deps, deps.sessionAccessWarmer, deps.pullRequestFeedback)
  )
}

/** Durable variant. Lease contention is retryable; a deleted/moved agent is a
 * permanent rejection and is ACKed so the old daemon can collect its outbox. */
export const handleEventSessionSync: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session-sync')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  const daemonId = DaemonId(conn.daemonId)
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) {
    conn.sendError(frame.id, 'INTERNAL', 'agent placement is mutating; retry the session snapshot', true)
    return
  }
  try {
    const agent = await deps.agent.get(orgId, agentId)
    if (agent && (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, daemonId)))
      await recordEventSession(p, orgId, agentId, daemonId, deps, undefined, deps.pullRequestFeedback)
    // ACK only after recordEventSession's transaction has committed. An agent
    // placed elsewhere (or deleted) can never accept this daemon's stale row, so
    // retaining it forever would be worse than collecting it.
    conn.replyTo(frame, 'ack', { ok: true })
  } catch (err) {
    deps.log.error(
      { err, daemonId, agentId, sessionId: p.sessionId },
      'event/session-sync: session snapshot durability failed'
    )
    conn.sendError(frame.id, 'INTERNAL', 'session snapshot failed to persist', true)
  } finally {
    release()
  }
}
