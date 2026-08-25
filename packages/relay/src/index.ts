#!/usr/bin/env node
/**
 * Relay bootstrap — load config, dial the CP for the rc/* control wire, serve the
 * health surface, and accept daemon dial-ins on the rd/* wire. Local-first like the
 * daemon: the CP client's `start()` is non-blocking and reconnects on its own, so a
 * CP outage never stops the process (established rd/* connections keep serving).
 *
 * Data plane (webchat, PR 3): the browser dials the relay's `/webchat` WS with a
 * CP-minted token; the relay `rc/verify`s it, then bridges the conversation onto the
 * target daemon's rd/* socket (`rd/msg` in, `rd/chat` out) — content never touches the CP.
 */
import { randomUUID } from 'node:crypto'
import {
  RELAY_CP_SUBPROTOCOL,
  type RcCodeHostMembershipAuthz,
  type RcHookRerun,
  type RcHookRerunResult,
  type RcRunReport
} from '@agentconnect.md/protocol'
import { ClientTransport, systemClock } from '@agentconnect.md/connection'
import { loadConfig, resolveAuth, toWsOrigin } from './config.js'
import { RelayCpClient } from './relay-cp-client.js'
import { buildRelayServer } from './server.js'
import { createRelayDaemonServer, type RelayDaemonServer } from './relay-daemon-server.js'
import { createRelayBrowserServer } from './relay-browser-server.js'
import { WebchatRouter, bindWebchatPostAuthor } from './webchat-router.js'
import { RelayIngressManager } from './relay-ingress-manager.js'
import { relayIngressPlugins } from './platforms/registry.js'
import { CollaborationRouter } from './collaboration-router.js'
import { createAgentMsgRouter } from './agent-msg-router.js'
import { mapAgentDirectory, toBotAssignment } from './bot-arbitration.js'
import { HookTable } from './hooks/hook-table.js'
import { HookRateLimiter } from './hooks/rate-limit.js'
import { registerHookIngress } from './hooks/ingress.js'
import { registerGithubIngress } from './hooks/github-ingress.js'
import { dispatchGitlabRerun, registerGitlabIngress } from './hooks/gitlab-ingress.js'
import { McpBindingTable } from './mcp/binding-table.js'
import { registerMcpProxy, registerMemoryPluginProxy } from './mcp/proxy.js'
import { MemoryConnectionBindingTable } from './memory/binding-table.js'
import type { Logger } from './log.js'
import { startRelayOpenTelemetry } from './observability.js'

// Before `main()` so the SDK has patched http/undici by the time the server
// and the CP client build theirs. No-ops unless an OTLP endpoint is set.
const telemetry = startRelayOpenTelemetry()

const RELAY_WS_PATH = '/api/v1/relays/ws'

async function main(): Promise<void> {
  const config = loadConfig()
  // Env is a rolling-compatibility fallback for an older CP or a deployment
  // that has not adopted DB-backed settings. A new CP replaces it exactly once
  // through rc/auth/ok; later reconnects never hot-reload this process.
  const deploymentConfig: { githubWebhookSecret?: string } = {
    ...(config.GITHUB_APP_WEBHOOK_SECRET ? { githubWebhookSecret: config.GITHUB_APP_WEBHOOK_SECRET } : {})
  }

  // Build the server first so the CP client can log through its pino instance. The
  // health probes and the CP-revoke callback read the client / rd server through a
  // holder (both are constructed below, once the logger exists).
  const held: {
    client?: RelayCpClient
    rdServer?: RelayDaemonServer
    relayIngress?: RelayIngressManager
    gitlabRerun?: (rerun: RcHookRerun) => RcHookRerunResult
  } = {}

  // The bot-agnostic collaboration routing snapshot (agent-collaboration §2.3/§6.2).
  // The CP ships it over `rc/collab-routes`; the cross-daemon `rd/agentmsg` router
  // (built below, once `log` exists) resolves+authorizes+forwards agent-calls on it.
  const collab = new CollaborationRouter()
  const server = buildRelayServer(
    {
      isReady: () => held.client?.isReady() ?? false,
      relayId: () => held.client?.relayId
    },
    { logger: true }
  )
  const log: Logger = {
    debug: (m) => server.log.debug(m),
    info: (m) => server.log.info(m),
    warn: (m) => server.log.warn(m),
    error: (m) => server.log.error(m)
  }

  // Cross-daemon `rd/agentmsg` router (agent-collaboration §2.3/§6.2) — resolves the
  // target via the collaboration snapshot, authorizes the caller, and forwards a
  // trusted claim to the owning daemon. Uses the holder so it sees `rdServer` late.
  const routeAgentMsg = createAgentMsgRouter({ router: collab, daemons: () => held.rdServer, log })

  // The relay is the shared INGRESS plane — a floating async rejection from any one
  // bot's inbound handling (an async forward, a `views.open`, a `WebClient` call)
  // must NEVER take down the whole process and drop every other bot + webchat +
  // webhook. Log and keep serving, mirroring the daemon's guard. Node's default
  // here is to crash.
  process.on('unhandledRejection', (reason) => {
    log.error(
      `relay: unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    )
  })
  process.on('uncaughtException', (err) => {
    log.error(
      `relay: uncaught exception (continuing): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    )
  })

  // The hook routing table — a memory copy of the CP's enabled hooks, replayed
  // in full after every (re)register (webhook-triggers doc). Rules carry
  // hmacSecret — never logged.
  const hookTable = new HookTable()

  // MCP proxy bindings — the CP pushes providerId → { upstreamUrl, headers, grantKeyHashes }
  // over rc/mcp-assign (whole-pool broadcast); the /mcp/:providerId route resolves + proxies.
  // Upstream headers are the upstream credential — never logged.
  const mcpBindings = new McpBindingTable()
  const memoryBindings = new MemoryConnectionBindingTable()

  const wsOrigin = toWsOrigin(config.CP_URL)
  const client = new RelayCpClient({
    auth: resolveAuth(config),
    name: config.RELAY_NAME,
    daemonUrl: config.DAEMON_DIAL_URL,
    heartbeatDefaultMs: config.HEARTBEAT_DEFAULT_MS,
    clock: systemClock,
    connect: () => ClientTransport.dial(wsOrigin, { subprotocol: RELAY_CP_SUBPROTOCOL, path: RELAY_WS_PATH }),
    log,
    onRegistered: (id) => log.info(`relay: registered with CP as ${id}`),
    onDeploymentConfig: (snapshot) => {
      deploymentConfig.githubWebhookSecret = snapshot.githubWebhookSecret
    },
    // Link (re)became READY — re-emit thread-assign reports and channel snapshots
    // dropped while it was down.
    onReady: () => {
      // The CP now replays the complete active memory-binding set for this
      // registration. Clear only here (not while disconnected), so deleted or
      // revoked grants cannot survive a reconnect while a CP outage still leaves
      // the last verified bindings available.
      memoryBindings.clear()
      held.relayIngress?.flushPendingReports()
    },
    // CP revoked a daemon's credential/membership — drop its rd/* connection now (§9).
    onRevoke: (daemonId) => held.rdServer?.revoke(daemonId),
    // HTTP-bot control (§10): the manager is constructed below (after rdServer);
    // these callbacks only fire once the relay is READY, so `held.relayIngress` is set.
    onBotAssign: (a) => {
      // §6.1: the assignment's origin-kind classification (present from an S1b CP)
      // teaches this relay how to classify a platform id its build predates.
      collab.learnPlatformKind(a.platform, a.originKind)
      const assignment = toBotAssignment(a)
      if (!assignment) {
        // §6.7: an opaque secret bag for a platform this build predates — ids only,
        // never the material. The S3 platform module takes this shape over.
        log.warn(`relay: bot-assign for ${a.botId} carried a secret shape this build does not support — skipped`)
        return
      }
      void held.relayIngress?.assign(assignment).catch((err) => log.error(`relay: bot-assign failed: ${String(err)}`))
    },
    onBotUnassign: (a) =>
      void held.relayIngress
        ?.unassign(a.botId, a.credentialRevision)
        .catch((err) => log.error(`relay: bot-unassign failed: ${String(err)}`)),
    onRoutes: (r) =>
      held.relayIngress?.updateRoutes(r.botId, {
        members: r.members,
        agents: mapAgentDirectory(r.agents),
        routes: r.routes,
        ...(r.defaultAgentId ? { defaultAgentId: r.defaultAgentId } : {}),
        ...(r.defaultDaemonId ? { defaultDaemonId: r.defaultDaemonId } : {}),
        gatedAgentIds: r.gatedAgentIds,
        mutedChannels: r.mutedChannels,
        gatedOffChannels: r.gatedOffChannels,
        noticeAuthority: r.noticeAuthority,
        noticedDmConversations: r.noticedDmConversations
      }),
    onAssign: (a) => {
      const target = { agentId: a.agentId, daemonId: a.daemonId, integrationId: '' }
      held.relayIngress?.setAffinity(a.botId, a.sessionKey, target)
    },
    onParticipantAssign: (a) =>
      held.relayIngress?.setParticipant(a.botId, a.sessionKey, {
        agentId: a.agentId,
        daemonId: a.daemonId,
        integrationId: ''
      }),
    onHookAssign: (rule) => hookTable.upsert(rule),
    onHookRemove: (hookId) => hookTable.remove(hookId),
    // Late-bound: the gitlab ingress deps this reuses are built after listen, so
    // a frame that somehow beats them finds no rule table either.
    onHookRerun: (rerun) => held.gitlabRerun?.(rerun) ?? { admitted: false, code: 'replay_pending' },
    // Bot-agnostic collaboration routing snapshot (agent-collaboration §2.3/§6.2) —
    // FULL-REPLACE the relay's cross-daemon agent-call routing/policy table.
    onCollabRoutes: (snap) => collab.replace(snap),
    // MCP proxy bindings (centralized-tool-management.md §5.2) — token-bearing, never logged.
    onMcpAssign: (a) => mcpBindings.assign(a),
    onMcpUnassign: (a) => mcpBindings.unassign(a.providerId, a.grantKeyHash),
    onMemoryConnectionAssign: (a) => memoryBindings.assign(a),
    onMemoryConnectionUnassign: (a) => memoryBindings.unassign(a.connectionId, a.revision, a.grantKeyHash)
  })
  held.client = client

  // Relay ingress manager (§10): loads each `rc/bot-assign`'s inbound routing + creds and
  // arbitrates/forwards inbound. Constructed before `listen()` so the IM HTTP
  // ingresses can register their routes; `getDaemon` late-binds the rd/* server
  // (created after listen).
  const relayIngress = new RelayIngressManager({
    getDaemon: (daemonId) => held.rdServer?.get(daemonId),
    setChannelAgent: (botId, channelId, agentId) => client.emitSetChannelAgent({ botId, channelId, agentId }),
    reportBotChannels: (m) => client.emitBotChannels(m),
    reportBotConversation: (m) => client.emitBotConversation(m),
    reportNoticePosted: (m) => client.emitNoticePosted(m),
    reportBotRevoked: (m) => client.reportBotRevoked(m),
    selfRelayId: () => client.relayId,
    reportThreadAssign: (m) => client.emitThreadAssign(m),
    reportThreadParticipant: (m) => client.emitThreadParticipant(m),
    lookupThread: (m) => client.lookupThread(m),
    isAgentBotApp: (targetAgentId, platform, channelId, appId) =>
      collab.isAgentBotAppFor(targetAgentId, platform, channelId, appId),
    admitsAgentCall: (callerAgentId, targetAgentId) => collab.admits(callerAgentId, targetAgentId),
    clock: systemClock,
    log
  })
  held.relayIngress = relayIngress

  // IM HTTP ingress. Each callback is demuxed, authenticated, deduplicated,
  // normalized, arbitrated, and forwarded. Routes must register before listen.
  //
  // Mounted from the platform registry, not by name (audit F5): each plugin
  // declares its own paths, so adding a platform never edits this file. The
  // paths themselves are unchanged by construction and pinned by enumeration
  // in `platforms/route-mounts.test.ts` — public callback URLs are external
  // contracts.
  for (const plugin of relayIngressPlugins) {
    plugin.installRoutes(server, { manager: () => held.relayIngress, log })
  }

  // Public webhook ingress (POST /webhooks/in/:token). Routes must register
  // before listen; the rd/* server only exists after it — hence the late bind.
  // One limiter serves both ingresses (keys are hookIds — no collision).
  const limiter = new HookRateLimiter(systemClock)
  registerHookIngress(server, {
    table: hookTable,
    daemons: () => held.rdServer,
    report: (r) => client.emitRunReport(r),
    limiter,
    clock: systemClock,
    log
  })

  // Live Issue/PR actor checks cost at least two GitHub calls. Keep their
  // repository-wide upstream budget separate from per-hook run capacity.
  const githubAuthzLimiter = new HookRateLimiter(systemClock, { capacity: 10, refillPerSec: 0.25 })
  registerGithubIngress(server, {
    table: hookTable,
    daemons: () => held.rdServer,
    report: (r) => client.emitRunReport(r),
    doorbell: (poke) => client.emitGithubInstallation(poke),
    reportPullRequestFeedback: (signal) => client.reportPullRequestFeedback(signal),
    authorizeComment: (request) => client.authorizeGithubComment(request),
    authorizeRerequest: (request) => client.authorizeGithubRerequest(request),
    authzLimiter: githubAuthzLimiter,
    limiter,
    clock: systemClock,
    log,
    webhookSecret: () => deploymentConfig.githubWebhookSecret
  })

  // GitLab project webhooks (gitlab-com-integration.md §11.2): rule-carried
  // signing tokens, live membership through the CP, same shared run limiter.
  const gitlabAuthzLimiter = new HookRateLimiter(systemClock, { capacity: 10, refillPerSec: 0.25 })
  const gitlabIngressDeps = {
    table: hookTable,
    daemons: () => held.rdServer,
    report: (r: RcRunReport) => client.emitRunReport(r),
    authorizeMembership: (request: RcCodeHostMembershipAuthz) => client.authorizeCodeHostMembership(request),
    authzLimiter: gitlabAuthzLimiter,
    limiter,
    clock: systemClock,
    log
  }
  registerGitlabIngress(server, gitlabIngressDeps)
  // The Console "Run again" action (§16.1) re-enters the same dispatch path.
  held.gitlabRerun = (rerun) => dispatchGitlabRerun(gitlabIngressDeps, rerun)

  // MCP reverse proxy (ALL /mcp/:providerId) — resolves a grant to its upstream, SSRF-guards
  // + IP-pins the operator-supplied upstream, swaps the bearer for the real headers, streams
  // the exchange through. Routes must register before listen.
  registerMcpProxy(server, {
    bindings: mcpBindings,
    allowlist: new Set(
      (config.RELAY_MCP_ALLOWED_UPSTREAMS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    ),
    log,
    ...(config.OPEN_CONNECTOR_URL ? { openConnectorUrl: config.OPEN_CONNECTOR_URL } : {}),
    ...(config.OPEN_CONNECTOR_RUNTIME_TOKEN ? { openConnectorToken: config.OPEN_CONNECTOR_RUNTIME_TOKEN } : {})
  })

  registerMemoryPluginProxy(server, {
    bindings: memoryBindings,
    allowlist: new Set(
      (config.RELAY_MEMORY_ALLOWED_UPSTREAMS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    ),
    log
  })

  client.start()
  await server.listen({ port: config.PORT, host: config.HOST })

  // The webchat router (chatId → browser) — a daemon's rd/chat is delivered here.
  const router = new WebchatRouter()

  // Accept daemon dial-ins on rd/* (after listen, so `server.server` exists). Each
  // rd/hello delegates the daemon's key to the CP via the CP client's `verify`; each
  // inbound rd/chat is routed to the browser owning its chatId.
  const rdServer = createRelayDaemonServer(server, {
    verify: (kind, credential, daemonId) => client.verify(kind, credential, daemonId),
    relayId: () => client.relayId,
    clock: systemClock,
    onChat: (chat) => router.deliver(chat),
    // A completed reply post: render to the browser (if attached), then fan a
    // context copy to every OTHER participant's daemon from the router's roster
    // cache — independent of the browser sink, so a mid-turn browser close cannot
    // drop the canonical post for the peers (webchat-multi-agents.md §5.2).
    //
    // The authorship claim is bound to the AUTHENTICATED source daemon FIRST
    // (§5.2a): only a bound claim keeps the activation-capable depth stamp; an
    // unbound one is stripped to the pre-§5.2a transcript-only shape, so a daemon
    // can never make peers execute under an author identity the relay did not
    // verify against the CP roster placement.
    onWebchatPost: (fromDaemonId, post) => {
      const roster = router.rosterOf(post.conversationId)
      const bound = bindWebchatPostAuthor(post, fromDaemonId, roster)
      if (!bound.authorBound && bound.post !== post) {
        log.warn(
          `relay: webchat post ${post.post.postId} author claim not bound to daemon ${fromDaemonId} — ` +
            `depth stripped, context stays transcript-only`
        )
      }
      router.deliverPost(bound.post)
      for (const p of roster) {
        if (p.agentId === post.agentId || !p.daemonId) continue
        const conn = rdServer.get(p.daemonId)
        if (!conn) continue
        void conn
          .sendMsg({
            source: 'webchat',
            agentId: p.agentId,
            sessionKey: post.conversationId,
            msgId: randomUUID(),
            chatId: post.conversationId,
            payload: { op: 'context', post: bound.post.post }
          })
          .catch((err) => log.warn(`relay: webchat post context fan-out failed: ${(err as Error).message}`))
      }
    },
    onAgentMsg: (fromDaemonId, msg) => routeAgentMsg(fromDaemonId, msg),
    log
  })
  held.rdServer = rdServer

  // Accept browser webchat dial-ins on /webchat (CP-minted token → rc/verify → bridge
  // onto the target daemon's rd/* socket).
  const browserServer = createRelayBrowserServer(server, {
    verify: (kind, token) => client.verify(kind, token),
    daemons: rdServer,
    router,
    log
  })

  log.info(`relay: health on ${config.HOST}:${config.PORT}; dialing CP at ${config.CP_URL} as "${config.RELAY_NAME}"`)

  let shuttingDown = false
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`relay: ${sig} — shutting down`)
    // Drop daemon + browser sockets (1012 = non-fatal → they reconnect elsewhere),
    // stop the CP client, then close the http server.
    for (const ws of rdServer.wss.clients) ws.close(1012, 'relay restarting')
    for (const ws of browserServer.clients) ws.close(1012, 'relay restarting')
    await held.relayIngress?.stopAll()
    await client.stop()
    await server.close()
    // Last, so spans from the drain above still make it out.
    await telemetry
      .shutdown()
      .catch((err: unknown) => log.error(`relay: opentelemetry shutdown failed: ${(err as Error).message}`))
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('relay: fatal boot error', err)
  process.exit(1)
})
