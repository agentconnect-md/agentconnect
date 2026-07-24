/**
 * `installNewSlackBot` — register a new Slack bot from its tokens and push it live.
 *
 * The tail shared by BOTH install paths that mint a fresh bot: the manual
 * `POST /integrations` (operator pasted both tokens) and the config-token funnel's
 * `finalize` (bot token from OAuth, app-level token pasted). Creating the bot +
 * storing its secret + creating the integration + best-effort `integration/upsert`
 * to the owning daemon must be IDENTICAL across the two, so it lives here once.
 *
 * The caller owns the policy that precedes this: the agent is placed
 * (`agent.daemonId` non-null), the caller may edit it, and the tokens are already
 * validated / obtained. Token-bearing — never log the spec.
 */
import { randomUUID } from 'node:crypto'
import type { HttpDeps } from './deps.js'
import type { AgentRecord, IntegrationRecord, SlackTransport } from '../persistence/ports.js'
import { BotId, IntegrationId, type OrgId } from '../domain/ids.js'
import { integrationToSpec } from '../orchestrator/placement.js'
import { NoConnection } from '../orchestrator/outbound.js'

/** App-level tokens are structured `xapp-1-{APP_ID}-{epoch}-{hex}`. The id segment
 *  (A…) is public metadata (it appears in every app-page URL) — stored on the bot so
 *  the console can deep-link "manage / delete the app on Slack". An unexpected shape
 *  just leaves it null. */
export function slackAppIdFromAppToken(appToken: string): string | undefined {
  const seg = appToken.split('-')[2]
  return seg && /^A[A-Z0-9]+$/.test(seg) ? seg : undefined
}

export interface InstallSlackBotArgs {
  orgId: OrgId
  /** The owning agent — MUST already be placed (`daemonId` non-null); caller checks. */
  agent: AgentRecord
  name: string
  botToken: string // xoxb-…
  /** Slack inbound transport (slack-http-mode). 'http' ⇒ relay-pool ingest (send-only
   *  daemon spec); 'socket' ⇒ classic daemon Socket Mode. Default 'socket'. */
  transport?: SlackTransport
  /** Public Slack app id learned from OAuth/config-token setup or bot-token verification. */
  slackAppId?: string
  /** xapp-… — required for socket transport (Socket Mode); absent for http. */
  appToken?: string
  /** Slack signing secret — required for http transport (Events API verification). */
  signingSecret?: string
  /** Multi-agent shared mode (http transport only). Caller has checked a relay is connected. */
  shareable?: boolean
  createdByUserId?: string
}

/** Minimal log surface (Fastify logger in prod). */
interface DebugLog {
  debug(obj: unknown, msg?: string): void
}

export async function installNewSlackBot(
  deps: HttpDeps,
  log: DebugLog,
  args: InstallSlackBotArgs
): Promise<IntegrationRecord> {
  const { orgId, agent, name, botToken, appToken, signingSecret, createdByUserId } = args
  const transport: SlackTransport = args.transport ?? 'socket'
  // Shareable (multi-agent) applies ONLY to the relay-ingress http transport. Coerce it
  // off for socket at this single bot-create seam so a stray flag can never mint a
  // shareable Socket Mode bot — which would break the ≤1-install cap (duplicate sockets
  // on one appToken). The console already hides the toggle for socket; this is the
  // load-bearing guarantee behind it (no 400 needed at the call sites).
  const shareable = transport === 'http' && args.shareable === true
  const daemonId = agent.daemonId! // caller guarantees placement

  // Socket mode can derive the id from xapp; HTTP mode receives it from the
  // config-token funnel or bot-token verification. Keep the derivation as the
  // authority when both are present (the caller already rejects a mismatch).
  const slackAppId = (appToken ? slackAppIdFromAppToken(appToken) : undefined) ?? args.slackAppId
  const botId = BotId(randomUUID())
  await deps.repos.bot.create({
    id: botId,
    orgId,
    platform: 'slack',
    name,
    transport,
    ...(slackAppId ? { slackAppId } : {}),
    ...(shareable ? { shareable: true } : {}),
    ...(createdByUserId ? { createdByUserId } : {})
  })
  // Store tokens via the ONLY secret path. The configured SecretCipher is identity
  // under `none` and encrypts with an encrypting provider. The xapp (socket) /
  // signing secret (http) stay here for the relay — the daemon never receives them.
  await deps.repos.botSecret.put(botId, {
    botToken,
    appToken: appToken ?? null,
    signingSecret: signingSecret ?? null
  })

  const id = IntegrationId(randomUUID())
  const integration = await deps.repos.integration.create({
    id,
    orgId,
    agentId: agent.id,
    botId,
    platform: 'slack',
    name,
    ...(createdByUserId ? { createdByUserId } : {})
  })

  // HTTP transport: the relay pool owns the ingest — broadcast the bot assign and push
  // the send-only spec to the daemon (SharedBotOrchestrator does both). No Socket Mode
  // socket opens on the daemon.
  if (transport === 'http') {
    await deps.sharedBot.syncBot(botId)
    return integration
  }

  // Classic: push the full spec (metadata + tokens) to the owning daemon so it opens
  // the Socket Mode socket. Best-effort: an offline daemon picks it up from the
  // register/ok reconcile roster on reconnect. Never log the token-bearing spec.
  const [secret, channels] = await Promise.all([
    deps.repos.botSecret.get(botId),
    deps.repos.integrationChannel.listForIntegration(id)
  ])
  if (secret) {
    try {
      await deps.control.integrationUpsert(daemonId, integrationToSpec(integration, secret, channels))
    } catch (err) {
      if (!(err instanceof NoConnection)) throw err
      log.debug({ integrationId: id, daemonId }, 'integration/upsert skipped: daemon offline')
    }
  }
  return integration
}
