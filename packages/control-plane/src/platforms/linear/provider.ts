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
 * SCOPE OF THIS MODULE. The `linearcred` broker is core's (`ws/handlers/linearcred.ts`), reading
 * the token service and {@link linearConnectionIdentity}; everything else the registry reads is here — the deployment config slice, the refusal, the secret shape, the two
 * projectors, the D6 identity projection, the connect funnel's routes and TTL reaper, the
 * orphan-token sweep, and the disconnect side effect.
 */
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { IntegrationLinearConfig } from '@agentconnect.md/protocol'
import type {
  BotRecord,
  BotSecretMaterial,
  LinearConnectionIdentity,
  LinearTokenStore
} from '../../persistence/ports.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { LinearCredentialReconciler } from './credential-reconciler.js'
import type {
  CpBackgroundLoop,
  CpConfigValidation,
  CpNewBotInstall,
  CpPendingInstallDecl,
  CpPlatformProvider,
  CpValidatedIdentity
} from '../provider.js'
import type { LinearTokenService } from './token-service.js'

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
 * awaiting reconnect, a row written before the app was configured). Core reads that as "no
 * deliverable spec" and withholds the integration entirely: the reconnect roster omits it so
 * `drop.integrations` prunes the daemon's entry, and the live http path pulls the send-only bundle.
 * Emitting a config-less spec instead would NOT revoke anything — the daemon refuses the
 * replacement and keeps the entry it already holds, so egress would continue on the dead grant.
 * Token-bearing — NEVER log.
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

/**
 * The rows one connected workspace's install writes (§7.1 step 2) — the SHARED implementation the
 * OAuth callback's finalize and {@link CpPlatformProvider.buildNewBotInstall} both call, so the two
 * can never drift. Pure, and everything platform-specific about a Linear bot is here:
 *
 *  - the D6 identity `(clientId, organizationId)` and the workspace claim, both fenced by core;
 *  - `shareable: true` STRUCTURALLY (§4.3), not as a caller's request: one deployment app means one
 *    bot per workspace, and every enabled agent is a member of it, so the shipped multi-integration
 *    gate has to admit the second one;
 *  - the deployment app's credentials stamped into the workspace bot's secret row — client secret in
 *    the `botToken` slot (CP-only) and the webhook signing secret in `signingSecret` (relay-only).
 */
export function buildLinearWorkspaceInstall(
  app: LinearPlatformAppConfig,
  identity: Pick<CpValidatedIdentity, 'workspaceId' | 'workspaceName' | 'botUserId'>
): CpNewBotInstall {
  const organizationId = identity.workspaceId
  if (!organizationId) throw new Error('linear workspace install requires the Linear organization id')
  return {
    bot: {
      workspaceId: organizationId,
      ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
      ...(identity.botUserId ? { botUserId: identity.botUserId } : {}),
      shareable: true
    },
    secrets: { botToken: app.clientSecret, appToken: null, signingSecret: app.signingSecret },
    externalIdentity: {
      externalAppId: app.clientId,
      externalTenantId: organizationId,
      conflictMessage:
        'this Linear workspace is already connected — enable your agent on the existing workspace instead'
    },
    workspaceClaim: {
      appId: app.clientId,
      tenantId: organizationId,
      conflictMessage: 'this Linear workspace is already connected to another organization'
    }
  }
}

/** The provider's injected seams. All optional so a focused unit test composes only the facet it
 *  exercises, exactly as the four shipped providers do; member presence follows slot presence. */
export interface LinearCpProviderDeps {
  /** The deployment's one OAuth app (§7.1). Absent ⇒ the platform self-disables: no external app
   *  identity is projected onto new rows and no workspace can be connected. READ PER CALL below
   *  (never captured), so a late-bound composition — the test harness's mutable stub bag — is still
   *  observed after the provider is built, the same discipline the Slack seams follow. */
  readonly app?: LinearPlatformAppConfig
  /** The provider-owned `linear_token` store (§4.4). Absent ⇒ `projectIntegrationConfig` has no
   *  grant to load and answers fail-closed, and the disconnect side effect has nothing to drop. */
  tokens?: LinearTokenStore
  /** The §10.6 re-stamp loop. Absent ⇒ it contributes no `backgroundLoops` entry, exactly as
   *  Slack's optional identity reconciler works — member presence follows slot presence. */
  credentialReconciler?: Pick<LinearCredentialReconciler, 'start' | 'stop'>
  /** Token custody (§4.4). Present ⇒ the disconnect edge also revokes upstream before dropping the
   *  row; absent ⇒ it only drops the row, which is still the whole of the local teardown. */
  tokenService?: LinearTokenService
  /** The connect funnel's plugins, injected PRE-BOUND by the composition root (a provider never
   *  reaches back for a route factory — the Slack/Feishu discipline). */
  funnelRoutes?: { org: FastifyPluginAsync[]; publicCallback: FastifyPluginAsync[] }
  /** `linear_install_state`'s reap slice + its sweep parameters (§9.2 `pendingInstalls`). */
  pendingInstalls?: { installStates: { reapExpired(staleBefore: Date): Promise<number> }; intervalMs: number }
  /** The §7.1 orphan-token sweeper — the SAME instance `startBackground()`/shutdown drive. */
  orphanTokenSweeper?: CpBackgroundLoop
}

/** An abandoned connect tab must not leave a live state nonce; the row holds no secrets, so this
 *  only has to be shorter than "a human forgot about the tab". */
export const LINEAR_CONNECT_TTL_MS = 30 * 60 * 1000

/**
 * The workspace bot's connection identity (§4.4), or null when the row carries no complete D6 pair.
 * Exported because the `linearcred` broker resolves the same identity from the same columns (§7.3),
 * and "what a Linear grant is keyed by" must have exactly one description.
 */
export function linearConnectionIdentity(
  bot: Pick<BotRecord, 'orgId' | 'externalAppId' | 'externalTenantId'>
): LinearConnectionIdentity | null {
  return bot.externalAppId && bot.externalTenantId
    ? { orgId: bot.orgId, clientId: bot.externalAppId, organizationId: bot.externalTenantId }
    : null
}

export function createLinearCpProvider(deps: LinearCpProviderDeps): CpPlatformProvider<LinearCreateCredentials> {
  const { tokens, tokenService, funnelRoutes, pendingInstalls, orphanTokenSweeper, credentialReconciler } = deps

  return {
    platformId: 'linear',

    // The connect funnel rides here (contract §9): org-scoped start/status/reconnect, plus the
    // unauthenticated OAuth callback core mounts twice (internal `/api/v1` + the public `/v1`
    // alias — the double mount is core's, and the handed-out redirect URL is the public form).
    installRoutes: (scope) => (scope === 'org' ? (funnelRoutes?.org ?? []) : (funnelRoutes?.publicCallback ?? [])),

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

    /**
     * The rows a connected workspace writes. Unreachable from the create ROUTE by construction —
     * `validateConfig` refuses before the tail — but the member is the real one the OAuth callback
     * runs (§9.2, the Feishu one-click precedent), through the shared
     * {@link buildLinearWorkspaceInstall} so there is exactly one description of a Linear bot's
     * rows. `shareable` is ignored: it is structural here, not a caller's request (§4.3).
     */
    buildNewBotInstall(input): CpNewBotInstall {
      const app = deps.app
      if (!app) throw new Error('linear platform app is not configured')
      return buildLinearWorkspaceInstall(app, input.identity)
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

    /** The connect funnel's nonce table (§9.2 `pendingInstalls`) — the shared reaper class, one
     *  instance, at {@link LINEAR_CONNECT_TTL_MS}. Absent ⇒ no funnel state declared (focused tests). */
    ...(pendingInstalls
      ? {
          pendingInstalls: [
            {
              model: 'LinearInstallState',
              label: 'linear-install-state',
              store: pendingInstalls.installStates,
              ttlMs: LINEAR_CONNECT_TTL_MS,
              intervalMs: pendingInstalls.intervalMs
            }
          ] satisfies readonly CpPendingInstallDecl[]
        }
      : {}),

    /**
     * This platform's convergence loops, declared so `startBackground()` and shutdown drive them
     * without naming platforms. ONE array, assembled from two independently optional slots — two
     * spreads would each carry a `backgroundLoops` key and the later one would silently replace the
     * earlier, dropping a loop with nothing to show for it:
     *
     *  - the §10.6 RE-STAMP. Rotating the deployment app's credentials moves the source of truth
     *    away from every workspace bot's stamped secret row, and only a provider-owned pass can
     *    close that gap — core has no reason to know that two `BotSecret` slots on this platform
     *    are copies of a deployment credential rather than a per-workspace one;
     *  - the §7.1 ORPHAN-TOKEN SWEEP: the only collector of a grant written before a create tail
     *    that then refused, and the backstop for an `onBotDelete` that failed.
     */
    ...(credentialReconciler || orphanTokenSweeper
      ? {
          backgroundLoops: [
            ...(credentialReconciler
              ? [
                  {
                    label: 'linear-credential-restamp',
                    start: () => credentialReconciler.start(),
                    stop: () => credentialReconciler.stop()
                  }
                ]
              : []),
            ...(orphanTokenSweeper ? [orphanTokenSweeper] : [])
          ]
        }
      : {}),

    /**
     * Disconnecting a workspace is deleting its Bot, and the grant does not hang off that row — it
     * is keyed by the connection identity — so nothing else would ever collect it (§7.4). Two steps,
     * in this order because the revoke needs the access token the delete is about to drop:
     *
     *  1. best-effort `POST /oauth/revoke` at Linear, but ONLY when no organization still relies on
     *     this app's authorization of the workspace. The fences are global while token rows are
     *     org-scoped, so a loser's teardown must never revoke the grant backing the WINNER's live
     *     install (§7.1) — and because a revoke acts on the app↔workspace grant, that question is
     *     asked DURABLY, under the identity's advisory lock, rather than from a plain read a
     *     concurrent connect could falsify before the call goes out;
     *  2. drop the identity's row, unconditionally — it is dead weight in this organization either
     *     way. The delete runs after core removed the bot, so a refused delete changes nothing.
     *
     * BOTH INSIDE ONE HOLD, for the same reason the sweep's claim is. Released between the decision
     * and the removal, a `put` queued on the lock publishes a fresh grant the instant the section
     * ends, and this unconditional delete then removes THAT row while the create or reconnect tail
     * behind it carries on believing its grant is durable. Under one hold nothing can interleave, so
     * the row removed is exactly the one the revoke decision was made about.
     *
     * `owned()` is asked BEFORE the removal on purpose: it deliberately excludes the caller's own
     * organization, so it reads the world as it will be once this row is gone.
     *
     * Best-effort by contract: core logs a failure and the delete stands, and the orphan-token
     * sweeper (§7.1) is the backstop for a row this misses.
     */
    ...(tokens
      ? {
          sideEffects: {
            onBotDelete: async (bot) => {
              const connection = linearConnectionIdentity(bot)
              if (!connection) return
              await tokens.withIdentityLock(connection, async (section) => {
                if (tokenService && !(await section.owned())) await tokenService.revoke(connection)
                await section.remove()
              })
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
      const connection = linearConnectionIdentity(bot)
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
