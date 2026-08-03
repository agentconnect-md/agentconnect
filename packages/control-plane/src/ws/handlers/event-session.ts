/**
 * `event/session` handler — session metadata sync (dashboard + deep links).
 *
 * A fire-and-forget EVT (no reply). Sessions are created on the Slack/Discord→
 * daemon path; the daemon reports each one's converged milestone here (start /
 * plan / problem / end + the sessionKey echo) and the CP upserts one `SessionMeta`
 * row per `sessionId` (latest-wins, idempotent). This is what makes a session
 * deep-link (`…/sessions/:id`) resolvable from CP-stored metadata, even when the
 * daemon is offline. Metadata only — list/detail fields and sessionKey echo —
 * never the message stream (that stays daemon-local, §1/§12).
 *
 * Trust boundary: the reported agent must still be placed on the authenticated
 * daemon, and an existing sessionId remains bound to its first agent.
 */
import { isFrame, type EventSession } from '@agentconnect.md/protocol'
import { AgentId, BotId, DaemonId, HookId, IntegrationId, LaunchId, SessionId } from '../../domain/ids.js'
import { classifySession } from '../../domain/session-visibility.js'
import type { DaemonWsDeps } from '../deps.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

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
    p.platform === 'webchat' && p.channel
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
    ...(p.launchCorrelationId !== undefined ? { launchCorrelationId: p.launchCorrelationId } : {}),
    webchatOwnerUserId,
    launchOwnerUserId
  })
}

async function externalCandidate(p: EventSession, agentId: AgentId, deps: DaemonWsDeps) {
  const origin = p.externalOrigin
  if (!origin) {
    const triggerId = p.triggeredBy?.startsWith('hook:')
      ? p.triggeredBy.slice('hook:'.length)
      : p.platform === 'hook'
        ? p.channel
        : undefined
    const hook = triggerId ? await deps.hook.get(HookId(triggerId)) : null
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
  const integration = await deps.integration.get(IntegrationId(origin.integrationId))
  if (
    !integration ||
    integration.agentId !== agentId ||
    integration.platform !== origin.provider ||
    integration.status !== 'active'
  ) {
    return { provider: origin.provider, resolution: 'invalid' as const }
  }
  const bot = await deps.bot?.get(BotId(integration.botId))
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

export const handleEventSession: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session')(frame)) return
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  const daemonId = DaemonId(conn.daemonId)
  await runForReportingAgent(agentId, daemonId, deps, async () => {
    const [classification, candidate] = await Promise.all([
      classifyMilestone(p, agentId, deps),
      externalCandidate(p, agentId, deps)
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
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.fastMode !== undefined ? { fastMode: p.fastMode } : {}),
      ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}),
      ...(p.outputMode !== undefined ? { outputMode: p.outputMode } : {}),
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
    // Publish only after the metadata commit. Browser subscribers use this as an
    // invalidation signal and immediately re-read `/sessions`; publishing first
    // would race that GET against the upsert and leave the new row invisible.
    deps.events.publish(daemonId, p)
  })
}
