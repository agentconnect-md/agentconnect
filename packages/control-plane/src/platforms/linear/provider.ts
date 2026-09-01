/**
 * Linear's control-plane platform provider (docs/designs/linear-integration.md §9.2).
 *
 * Linear is a chat-kind platform whose ingress is relay-terminated and whose egress is
 * daemon-direct GraphQL. Its Linear-side identity is the DEPLOYMENT's one OAuth app (§4.3): a
 * connected workspace is one shared `Bot` row (D6 identity `(clientId, organizationId)`), and each
 * enabled agent is an `Integration` member of it. That shape is why this provider looks unlike its
 * four peers in two places:
 *
 *  - {@link CpPlatformProvider.validateConfig} REFUSES the generic `POST /integrations` credential
 *    path outright. There are no per-org app credentials to paste, and a member Integration must
 *    never exist outside a connected workspace, so the credential block is vestigial by design
 *    (§9.2) and the funnel is the only way a Linear bot is born;
 *  - {@link CpPlatformProvider.projectIntegrationConfig} is genuinely ASYNC — it loads the
 *    workspace's ≤24 h access token from this provider's own `linear_token` table by the bot's D6
 *    identity. That is the case the contract made both projectors async for (§4.4).
 *
 * SCOPE OF THIS MODULE. The connect funnel, its OAuth callback, `buildNewBotInstall`, and the token
 * exchange/refresh service land with the funnel; the `linearcred` broker lands with the WS handler.
 * What is here is the skeleton core reads through the registry today: the deployment config slice,
 * the refusal, the secret shape, the two projectors, the D6 identity projection, and the disconnect
 * side effect.
 */
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { IntegrationLinearConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial, LinearTokenStore } from '../../persistence/ports.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { CpConfigValidation, CpNewBotInstall, CpPlatformProvider } from '../provider.js'

/**
 * The `linear` credential block of the `POST /integrations` create body — VESTIGIAL by design
 * (§9.2). It exists because every provider contributes one and core's exactly-one-of
 * `botId`/credentials rule is platform-agnostic; nothing may be pasted into it, and
 * {@link createLinearCpProvider}'s `validateConfig` refuses the whole path. Adding an agent to an
 * already-connected workspace is the generic existing-bot (`botId`) arm, which never reaches here.
 */
export const LinearCreateCredentials = z.object({})
export type LinearCreateCredentials = z.infer<typeof LinearCreateCredentials>

/** The refusal `validateConfig` sends for the credential-paste path. Points at the one flow that
 *  can mint a Linear bot instead of describing a credential the operator does not have. */
export const LINEAR_CONNECT_WORKSPACE_MESSAGE =
  'Linear integrations are created by connecting a workspace. Use Connect Linear in your organization settings, then enable this agent on the connected workspace.'

/** The machine-readable code the console switches its copy on (contract §9: the one refusal here). */
export const LINEAR_CONNECT_WORKSPACE_CODE = 'LINEAR_CONNECT_WORKSPACE_REQUIRED'

/**
 * Env keys this provider owns (§9 `envSchema`) — the deployment's one Linear OAuth app (§7.1), the
 * `SLACK_PLATFORM_*` precedent. ALL THREE must be set to enable the platform; any unset ⇒ absent,
 * and the provider self-disables (no external app identity is projected, the funnel routes never
 * mount, and the console's Linear surface stays hidden). MUST stay `.optional()` so an image bump
 * never fail-fasts an existing deploy — the all-or-none partial-set fail-fast lives in
 * `config/linear-platform.ts` (`resolveLinearPlatformAppConfig`).
 *
 * The install path additionally hard-depends on core's `PUBLIC_CP_URL` (the OAuth callback origin)
 * + `PUBLIC_RELAY_URL` + a connected relay: Linear offers no dial-out transport, so a Linear bot
 * exists only on the `http` transport (§4.2).
 */
export const LinearCpEnvSchema = {
  LINEAR_PLATFORM_CLIENT_ID: z.string().optional(),
  LINEAR_PLATFORM_CLIENT_SECRET: z.string().optional(),
  LINEAR_PLATFORM_SIGNING_SECRET: z.string().optional()
} satisfies ZodRawShape

/**
 * The two opaque `rc/bot-assign` bags for a connected Linear workspace (§6.2) — STRICTLY these two,
 * with no routing in them: the member-name keyword rules `@<agent-name>` addressing needs are
 * already emitted by the HTTP-bot orchestrator's core compile, and `members` / `agents` /
 * `defaultAgentId` / `credentialRevision` stay core-assembled.
 *
 *  - secrets `signingSecret` — the deployment app's webhook signing secret, stamped into each
 *    workspace bot's secret row at connect. The client secret and the refresh token never reach the
 *    relay. Core's completeness gate requires this slot before an assign is built
 *    (`secretShape.httpAssignRequires`), so the empty fallback is unreachable in production.
 *  - ingress `apiAppId` + `teamId` — the tenant-scoped demux composite, in the bag's GENERIC slots,
 *    which is what actually makes it a demux: relay core indexes `{appId: apiAppId, tenantId:
 *    teamId}` and its tenant fence takes the STRICT arm off `teamId`, so platform-named keys would
 *    be silently dropped and every Linear delivery would fall to the verify-scan. Sibling installs
 *    of the same app share one signing secret, so the composite is the only demux that cannot leak
 *    one workspace's events into another's bot. Both halves are read from the D6 columns — the
 *    deployment app's client id and the Linear organization id the callback wrote.
 *  - ingress `botUserId` — the app's own Linear user id, the self-echo guard and shared-bot
 *    addressing input.
 *
 * Token-bearing — NEVER log the result.
 */
export function linearBotAssignBags(
  bot: Pick<BotRecord, 'externalAppId' | 'externalTenantId' | 'botUserId'>,
  secret: Pick<BotSecretMaterial, 'signingSecret'>
): { secrets: Record<string, unknown>; ingress: Record<string, unknown> } {
  return {
    secrets: { signingSecret: secret.signingSecret ?? '' },
    ingress: {
      ...(bot.externalAppId ? { apiAppId: bot.externalAppId } : {}),
      ...(bot.externalTenantId ? { teamId: bot.externalTenantId } : {}),
      ...(bot.botUserId ? { botUserId: bot.botUserId } : {})
    }
  }
}

/**
 * The §6.4 opaque `IntegrationSpec.config` payload for one enabled agent on a connected workspace
 * (§7.2). `agent.json` therefore holds a ≤24 h token, not a durable secret — a strictly smaller
 * exposure than the other platforms' permanent bot tokens; the daemon renews it over `linearcred`.
 *
 * `undefined` is the FAIL-CLOSED answer for a bot whose identity or grant is missing (a dead token
 * awaiting reconnect, a row written before the app was configured): the daemon's platform module
 * rejects a spec whose `config` fails its schema (skip + warn), which is exactly the intended
 * outcome — no Linear egress from an unauthorized workspace. Token-bearing — NEVER log.
 */
export function linearIntegrationConfig(
  bot: Pick<BotRecord, 'workspaceName' | 'botUserId'>,
  organizationId: string,
  token: { accessToken: string; expiresAt: Date }
): IntegrationLinearConfig {
  return {
    workspaceId: organizationId,
    ...(bot.workspaceName ? { workspaceName: bot.workspaceName } : {}),
    ...(bot.botUserId ? { appUserId: bot.botUserId } : {}),
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.expiresAt.toISOString()
  }
}

/** The provider's injected seams. Both are optional so a focused unit test composes only the facet
 *  it exercises, exactly as the four shipped providers do; member presence follows slot presence. */
export interface LinearCpProviderDeps {
  /** The deployment's one OAuth app (§7.1). Absent ⇒ the platform self-disables: no external app
   *  identity is projected onto new rows and no workspace can be connected. READ PER CALL below
   *  (never captured), so a late-bound composition — the test harness's mutable stub bag — is still
   *  observed after the provider is built, the same discipline the Slack seams follow. */
  readonly app?: LinearPlatformAppConfig
  /** The provider-owned `linear_token` store (§4.4). Absent ⇒ `projectIntegrationConfig` has no
   *  grant to load and answers fail-closed, and the disconnect side effect has nothing to drop. */
  tokens?: LinearTokenStore
}

export function createLinearCpProvider(deps: LinearCpProviderDeps): CpPlatformProvider<LinearCreateCredentials> {
  const { tokens } = deps

  /** The bot's connection identity (§4.4), or null when the row carries no complete D6 pair. */
  const connectionOf = (bot: BotRecord) =>
    bot.externalAppId && bot.externalTenantId
      ? { orgId: bot.orgId, clientId: bot.externalAppId, organizationId: bot.externalTenantId }
      : null

  return {
    platformId: 'linear',

    // The connect funnel (org-scoped start/status/reconnect) and its unauthenticated OAuth callback
    // land with the funnel itself; until then this platform contributes no routes at either scope.
    installRoutes: () => [],

    credentialBodySchema: LinearCreateCredentials,

    /**
     * The credential-paste path is refused OUTRIGHT (§9.2). Every other provider validates pasted
     * credentials here; Linear has none to validate — the deployment owns the one OAuth app, and a
     * member Integration must never exist outside a workspace that was actually connected. 400 is
     * the definitive-rejection status the contract reserves for exactly this: no provider round
     * trip happened and none would change the answer.
     */
    validateConfig(): Promise<CpConfigValidation> {
      return Promise.resolve({
        ok: false,
        status: 400,
        code: LINEAR_CONNECT_WORKSPACE_CODE,
        message: LINEAR_CONNECT_WORKSPACE_MESSAGE
      })
    },

    /** Unreachable by construction: `validateConfig` refuses before the create tail is reached, and
     *  the OAuth callback's finalize is the only writer of a Linear bot. Throwing states that. */
    buildNewBotInstall(): CpNewBotInstall {
      throw new Error('linear bots are created by the workspace connect flow, not the credential path')
    },

    /**
     * D6 identity (§4.3): Linear is TENANT-SCOPED, and its app half is a CONSTANT — every workspace
     * bot in every organization belongs to the deployment's one OAuth app. So `externalAppId` comes
     * from this provider's config slice rather than from a per-row column (there is none to read),
     * and `externalTenantId` is the Linear organization id the callback captured as the display
     * `workspaceId`. The composite unique then reads as "one bot per (app, workspace)", which is
     * the fence a shared signing secret makes load-bearing.
     *
     * Without the config slice the platform is disabled, so there is no identity to project and the
     * row keeps NULLs — the same "captured no app identity" state a pre-capture Slack row has.
     */
    projectBotIdentity: (input) => {
      const app = deps.app
      if (!app || !input.workspaceId) return {}
      return {
        externalAppId: app.clientId,
        externalTenantId: input.workspaceId,
        platformConfig: {
          clientId: app.clientId,
          organizationId: input.workspaceId,
          ...(input.workspaceName ? { workspaceName: input.workspaceName } : {})
        }
      }
    },

    /**
     * Linear packs the DEPLOYMENT app's credentials into the workspace bot's shared secret row
     * (§7.2): `botToken` carries the client SECRET — the slot's overloading, made data here, as
     * Feishu does for its app secret — and `signingSecret` the webhook signing secret. The client
     * secret stays CP-side (code exchange + refresh); only the signing secret reaches the relay.
     * An http assign is gated on it: an unverifiable webhook bot must not be placed, and Linear has
     * no other transport.
     */
    secretShape: {
      slots: {
        botToken: 'Linear OAuth client secret (deployment app; CP-only)',
        signingSecret: 'Linear webhook signing secret (Linear-Signature verification)'
      },
      httpAssignRequires: ['signingSecret']
    },

    envSchema: LinearCpEnvSchema,

    /**
     * Disconnecting a workspace is deleting its Bot, and the grant does not hang off that row — it
     * is keyed by the connection identity — so nothing else would ever collect it (§7.4). Dropping
     * it here is the whole of this member's job in this stage; the best-effort upstream
     * `POST /oauth/revoke` joins it with the token service that owns Linear's HTTP surface.
     *
     * Best-effort by contract: core logs a failure and the delete stands, and the orphan-token
     * sweeper (§7.1) is the backstop for a row this misses.
     */
    ...(tokens
      ? {
          sideEffects: {
            onBotDelete: async (bot) => {
              const connection = connectionOf(bot)
              if (!connection) return
              await tokens.delete(connection)
            }
          }
        }
      : {}),

    /**
     * §6.4 projection — ASYNC for the reason the contract made it so: the payload's credential
     * lives in this provider's OWN store, not in the shared secret row core already loaded. The
     * lookup is by the bot's D6 identity, which is what makes §7.1's write-before-create ordering
     * work: the callback upserts the grant BEFORE the create tail mints the bot, so by the time
     * this runs the row is already durable. Token-bearing — NEVER log.
     */
    async projectIntegrationConfig(_integration, bot) {
      const connection = connectionOf(bot)
      if (!connection || !tokens) return undefined
      const token = await tokens.get(connection)
      if (!token) return undefined
      return linearIntegrationConfig(bot, connection.organizationId, token)
    },

    // §6.7 projection: strictly the two opaque bags (§6.2) — routing is the core compile's.
    // Token-bearing — NEVER log.
    projectBotAssign(bot, secrets) {
      return Promise.resolve(linearBotAssignBags(bot, secrets))
    }
  }
}
