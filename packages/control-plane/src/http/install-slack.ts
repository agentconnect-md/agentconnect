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
import type { HttpDeps } from './deps.js'
import type { AgentRecord, IntegrationRecord, SlackTransport } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import { installNewBot } from './install-bot.js'
import { SlackWorkspaceClaimed } from '../persistence/errors.js'
import { slackAppIdFromAppToken } from '../platforms/slack/provider.js'

// Relocated to the Slack platform provider (§9, S3): its `validateConfig` runs
// the same same-app cross-check as the create route, and this module sits
// downstream of `placement.ts` (which imports the provider's projection
// helpers), so the provider cannot import it back. Re-exported so the existing
// call sites (`routes/integrations.ts`, `routes/slack-install.ts`) are unchanged.
export { slackAppIdFromAppToken }

export interface InstallSlackBotArgs {
  orgId: OrgId
  /** The owning agent. For SOCKET transport it MUST already be placed (`daemonId`
   *  non-null; the daemon owns the socket) — caller checks. An http-transport
   *  install tolerates an unplaced agent: the relay assignment simply defers until
   *  placement re-converges the HTTP bot (preset-agents.md §5.3). */
  agent: AgentRecord
  name: string
  botToken: string // xoxb-…
  /** Slack inbound transport (slack-http-mode). 'http' ⇒ relay-pool ingest (send-only
   *  daemon spec); 'socket' ⇒ classic daemon Socket Mode. Default 'socket'. */
  transport?: SlackTransport
  /** Public Slack app id learned from OAuth/config-token setup or bot-token verification. */
  slackAppId?: string
  /** Slack workspace id ("T…") — platform-app installs persist it as the composite
   *  relay demux key (Bot.teamId). Public metadata. */
  teamId?: string
  /** Display-only workspace identity/name learned from OAuth or auth.test. */
  workspaceId?: string
  workspaceName?: string
  /** Slack bot user id from the OAuth exchange. Public metadata. */
  botUserId?: string
  /** Provisioned by AgentConnect (the platform app), not a console user. */
  prebuilt?: boolean
  /** xapp-… — required for socket transport (Socket Mode); absent for http. */
  appToken?: string
  /** Slack signing secret — required for http transport (Events API verification). */
  signingSecret?: string
  /** Multi-agent sharing (http transport only). Caller has checked a relay is connected. */
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

  // Socket mode can derive the id from xapp; HTTP mode receives it from the
  // config-token funnel or bot-token verification. Keep the derivation as the
  // authority when both are present (the caller already rejects a mismatch).
  const slackAppId = (appToken ? slackAppIdFromAppToken(appToken) : undefined) ?? args.slackAppId

  // Workspace-claim admission fence (ingress-tenant-fence.md §5): the same app
  // installed into the same workspace by TWO organizations would share one
  // signing secret AND one tenant — the delivery-time fence cannot tell those
  // rows apart, so the second claim is refused here instead. Unknown identity
  // skips the check (auth.test may legitimately be unavailable at install
  // time), mirroring the delivery fence's fail-open arm. The check-then-create
  // window takes no lock: a same-instant double claim is out of scope,
  // consistent with the funnel's existing concurrency posture.
  const claimTenant = args.teamId ?? args.workspaceId
  if (
    slackAppId &&
    claimTenant &&
    (await deps.repos.bot.slackWorkspaceClaimedElsewhere(orgId, slackAppId, claimTenant))
  ) {
    throw new SlackWorkspaceClaimed()
  }

  // The row writes, the transport fork and the shareable coercion are core's ONE
  // create skeleton (§9, `install-bot.ts`) — the same one `POST /integrations`
  // drives from the provider's `buildNewBotInstall`. What stays here is the Slack
  // funnels' argument shape: this function is the tail BOTH funnel paths call
  // (config-token `finalize` and the platform app's OAuth callback).
  const { integration } = await installNewBot(deps, log, {
    orgId,
    agent,
    platform: 'slack',
    name,
    transport,
    ...(args.prebuilt ? { prebuilt: true } : {}),
    bot: {
      ...(slackAppId ? { slackAppId } : {}),
      ...(args.teamId ? { teamId: args.teamId } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
      ...(args.botUserId ? { botUserId: args.botUserId } : {}),
      ...(args.shareable ? { shareable: true } : {})
    },
    // The xapp (socket) / signing secret (http) stay CP-side for the relay — the
    // daemon never receives them.
    secrets: { botToken, appToken: appToken ?? null, signingSecret: signingSecret ?? null },
    ...(createdByUserId ? { createdByUserId } : {})
  })
  return integration
}
