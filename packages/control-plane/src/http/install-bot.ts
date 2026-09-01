/**
 * `installNewBot` — the ONE core skeleton that registers a new bot identity and
 * pushes it live (integration-plugin-architecture.md §9, "the common create
 * skeleton stays core").
 *
 * Before S3 this shape existed three times: `installNewSlackBot`,
 * `installNewFeishuBot`, and two inline copies inside the `POST /integrations`
 * telegram/discord tails. All four wrote the same rows in the same order and
 * forked the same way on transport — they differed only in WHICH columns and
 * secret slots the platform fills, which is exactly what
 * {@link CpNewBotInstall} now declares. So the skeleton lands here once and the
 * platform half arrives as data:
 *
 *   bot row → secret row → integration row → (http) relay assign | (socket)
 *   best-effort `integration/upsert` to the owning daemon.
 *
 * The CALLER owns the policy that precedes this: the agent is visible, editable
 * and (for socket) placed; the credentials are already validated; the D6 fence
 * pre-check has run. Token-bearing — never log the spec.
 */
import { randomUUID } from 'node:crypto'
import type { HttpDeps } from './deps.js'
import type { AgentRecord, BotRecord, IntegrationRecord, SlackTransport } from '../persistence/ports.js'
import { BotId, IntegrationId, type OrgId } from '../domain/ids.js'
import { integrationToSpec, isGatedAgent } from '../orchestrator/placement.js'
import { NoConnection } from '../orchestrator/outbound.js'
import { seedSoleConversationOwner } from '../orchestrator/soleConversation.js'
import type { CpNewBotInstall } from '../platforms/provider.js'
import { BotWorkspaceClaimed } from '../persistence/errors.js'

export interface InstallNewBotArgs extends CpNewBotInstall {
  orgId: OrgId
  /** The owning agent. For SOCKET transport it MUST already be placed
   *  (`daemonId` non-null; the daemon owns the connection) — caller checks. An
   *  http-transport install tolerates an unplaced agent: the relay assignment
   *  defers until placement re-converges the HTTP bot (preset-agents.md §5.3). */
  agent: AgentRecord
  /** Registry platform id — the bot/integration rows' `platform` column. */
  platform: string
  name: string
  /** Inbound transport. 'http' ⇒ relay-pool ingest (send-only daemon spec);
   *  'socket' ⇒ the daemon's own long-lived connection. Default 'socket'. */
  transport?: SlackTransport
  /** Provisioned by AgentConnect (the platform app), not a console user. */
  prebuilt?: boolean
  createdByUserId?: string
}

/** Minimal log surface (Fastify logger in prod). */
interface DebugLog {
  debug(obj: unknown, msg?: string): void
}

export async function installNewBot(
  deps: HttpDeps,
  log: DebugLog,
  args: InstallNewBotArgs
): Promise<{ integration: IntegrationRecord; bot: BotRecord }> {
  const { orgId, agent, platform, name, secrets, createdByUserId } = args
  const transport: SlackTransport = args.transport ?? 'socket'
  // Shareable (multi-agent) applies ONLY to the relay-ingress http transport.
  // Coerce it off for socket at this single bot-create seam so a stray flag can
  // never mint a shareable socket bot — which would break the ≤1-install cap
  // (duplicate connections on one credential). The console already hides the
  // toggle for socket; this is the load-bearing guarantee behind it.
  const shareable = transport === 'http' && args.bot?.shareable === true

  // Workspace-claim admission fence (ingress-tenant-fence.md §5), at the ONE
  // seam every create path passes through — the generic `POST /integrations`
  // (provider-projected) and both Slack funnels (`install-slack.ts`) alike.
  // Placing it on any single caller would leave the others open, which is the
  // whole failure mode this fence exists to close. A claim the platform could
  // not capture is absent here and simply skips the check (§3.3 fail-open).
  // The check-then-create window takes no lock: a same-instant double claim is
  // out of scope, consistent with the create path's existing concurrency posture.
  const claim = args.workspaceClaim
  if (claim && (await deps.repos.bot.workspaceClaimedElsewhere(orgId, platform, claim.appId, claim.tenantId))) {
    throw new BotWorkspaceClaimed(claim.conflictMessage)
  }

  // Ids are minted HERE, not by the caller: the funnel that needs pre-reserved
  // ids for restart-idempotency (Feishu's one-click registration) keeps its own
  // tail, `install-feishu.ts`.
  const botId = BotId(randomUUID())
  const bot = await deps.repos.bot.create({
    ...args.bot,
    id: botId,
    orgId,
    platform,
    name,
    transport,
    ...(args.prebuilt ? { prebuilt: true } : {}),
    shareable,
    ...(createdByUserId ? { createdByUserId } : {})
  })
  // Store credentials via the ONLY secret path. The configured SecretCipher is
  // identity under `none` and encrypts with an encrypting provider. Slots the
  // relay needs (Slack's signing secret, Feishu's verification token) stay
  // CP-side; the daemon never receives them.
  await deps.repos.botSecret.put(orgId, botId, secrets)

  const id = IntegrationId(randomUUID())
  const integration = await deps.repos.integration.create({
    ...args.integration,
    id,
    orgId,
    agentId: agent.id,
    botId,
    platform,
    name,
    ...(createdByUserId ? { createdByUserId } : {})
  })

  // HTTP transport: the relay pool owns the ingest — broadcast the bot assign and
  // push the send-only spec to the daemon (HttpBotOrchestrator does both). No
  // long-lived platform connection opens on the daemon.
  if (transport === 'http') {
    // Before the sync, so the routes this publishes already carry the workspace default (§5).
    await seedSoleConversationOwner(deps.repos.integrationChannel, integration, bot)
    await deps.httpBot.syncBot(botId)
    return { integration, bot }
  }

  // Classic: push the full spec (metadata + credentials) to every daemon serving
  // this agent so it opens its connection — the placement and any duty holder,
  // because a freshly pasted credential that reaches only the placement leaves the
  // holder authenticating with the old one. Best-effort — an offline daemon picks
  // it up from the register/ok reconcile roster. Never log the token-bearing spec.
  // The bot row joins the reads: it is a required input of the §9 projector that
  // assembles the spec payload (`orchestrator/placement.ts`). `bot` was created
  // above, so this is the same row, not a second fetch.
  const [secret, channels] = await Promise.all([
    deps.repos.botSecret.get(orgId, botId),
    deps.repos.integrationChannel.listForIntegration(id)
  ])
  const spec = secret
    ? await integrationToSpec(deps.platforms, integration, bot, secret, channels, isGatedAgent(agent))
    : null
  // No secret, or a provider with no deliverable payload: withhold the push and let the reconcile
  // roster carry (or prune) the row.
  if (spec) {
    await deps.agentDelivery.integrationUpsert(agent, spec, (err, target) => {
      if (!(err instanceof NoConnection)) throw err
      log.debug({ integrationId: id, daemonId: target }, 'integration/upsert skipped: daemon offline')
    })
  }
  return { integration, bot }
}
