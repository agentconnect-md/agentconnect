// Google Chat's Control Plane provider (google-chat-integration.md §3, §7): one provider for both credential holders.
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import {
  GOOGLE_CHAT_PLATFORM,
  RcGoogleChatAnchor,
  googleChatEventsUrl,
  type IntegrationGoogleChatConfig
} from '@agentconnect.md/protocol'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import {
  TENANTLESS_SENTINEL,
  type BotIdentitySnapshot,
  type BotRecord,
  type BotSecretMaterial
} from '../../persistence/ports.js'
import type {
  CpConfigRefusal,
  CpConfigValidation,
  CpInstallTransport,
  CpNewBotInstall,
  CpPlatformProvider,
  CpTenantLearning
} from '../provider.js'
import {
  checkGoogleChatApp,
  probeFailureIsConnectivity,
  serviceAccountProject,
  type GoogleChatAppFailure
} from './credential.js'
import {
  GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE,
  googleChatPrimaryTenant,
  googleChatTenantEntries,
  googleChatTenantKeys,
  googleChatTenantLearning,
  googleChatTenantOf,
  type GoogleChatTenant
} from './tenant.js'

/** The `googlechat` block of `POST /integrations`; an entered project number is only a cross-check of the resolved one. */
export const GoogleChatCreateCredentials = z.object({
  projectId: z.string().trim().min(1).max(100),
  projectNumber: z.string().trim().min(1).max(40).optional(),
  serviceAccountKey: z.string().trim().min(1).max(20_000)
})
export type GoogleChatCreateCredentials = z.infer<typeof GoogleChatCreateCredentials>

/** Google delivers interaction events only to the relay's HTTPS endpoint, so there is no socket install. */
export function refineGoogleChatCreateBody(
  body: { credentials: GoogleChatCreateCredentials; transport: CpInstallTransport },
  addIssue: (message: string) => void
): void {
  if (body.transport !== 'http')
    addIssue('googlechat requires transport http: Google Chat events arrive through the relay')
}

/** The deployment-owned Chat app, projected from the Setup Server's `googleChat` slice (`config/deployment.ts`). */
export const GoogleChatCpEnvSchema = {
  GOOGLE_CHAT_PLATFORM_PROJECT_ID: z.string().optional(),
  GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER: z.string().optional(),
  GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: z.string().optional()
} satisfies ZodRawShape

/** The 409 copy of the one-bot-per-app fence; a Chat app cannot move between agents or organizations. */
export const GOOGLE_CHAT_APP_TAKEN_MESSAGE =
  'This Google Chat app is already connected to an agent. Each Chat app serves one agent; create a Chat app in its own Google Cloud project for this agent.'

/** The 409 copy when a per-agent install names the deployment's own app, which organizations claim from Google Chat (§10.5). */
export const GOOGLE_CHAT_DEPLOYMENT_APP_MESSAGE =
  'This is the deployment’s own Google Chat app. Your organization connects it from Google Chat: send the app a message there.'

/** The machine code the console switches on, per refusal. */
const REFUSAL_CODES: Record<GoogleChatAppFailure, string> = {
  project_number_invalid: 'GOOGLE_CHAT_PROJECT_NUMBER_INVALID',
  invalid_key: 'GOOGLE_CHAT_KEY_INVALID',
  project_mismatch: 'GOOGLE_CHAT_PROJECT_MISMATCH',
  key_rejected: 'GOOGLE_CHAT_KEY_REJECTED',
  crm_disabled: 'GOOGLE_CHAT_CRM_DISABLED',
  crm_forbidden: 'GOOGLE_CHAT_CRM_FORBIDDEN',
  project_unresolved: 'GOOGLE_CHAT_PROJECT_UNRESOLVED',
  project_number_mismatch: 'GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH',
  chat_api_refused: 'GOOGLE_CHAT_APP_UNAVAILABLE',
  unreachable: 'GOOGLE_CHAT_UNREACHABLE',
  google_unavailable: 'GOOGLE_CHAT_UNREACHABLE'
}

/** A Chat app whose identity came from Google: the service account's owning project and that project's resolved number. */
export interface ResolvedGoogleChatApp {
  projectId: string
  projectNumber: string
  serviceAccountKey: string
  /** The one Workspace customer whose named Spaces the probe listed, when it listed exactly one (§10.3). */
  customerId?: string
}

/** Key check, the project number resolved with the key, then one bounded `chat.bot` read; no message is ever sent (§3). */
export async function resolveGoogleChatApp(
  credentials: GoogleChatCreateCredentials,
  fetchImpl: typeof fetch
): Promise<({ ok: true } & ResolvedGoogleChatApp) | CpConfigRefusal> {
  const checked = await checkGoogleChatApp(credentials, fetchImpl)
  if (checked.status === 'ok') {
    // Neither the entered project nor the entered number: both come from the authenticated account.
    return {
      ok: true,
      projectId: checked.key.projectId,
      projectNumber: checked.projectNumber,
      serviceAccountKey: checked.key.json,
      ...(checked.customerId ? { customerId: checked.customerId } : {})
    }
  }
  // An unreachable Google is inconclusive, never proof the key is bad.
  const status = probeFailureIsConnectivity(checked.status) ? 503 : 400
  return { ok: false, status, code: REFUSAL_CODES[checked.status], message: checked.message }
}

/** The provider's `validateConfig`: the resolved app becomes the identity core persists, unless it is the deployment's own app. */
export async function validateGoogleChatApp(
  credentials: GoogleChatCreateCredentials,
  fetchImpl: typeof fetch,
  deploymentProjectNumber?: string
): Promise<CpConfigValidation> {
  const resolved = await resolveGoogleChatApp(credentials, fetchImpl)
  if (!resolved.ok) return resolved
  if (resolved.projectNumber === deploymentProjectNumber) {
    return { ok: false, status: 409, code: 'GOOGLE_CHAT_DEPLOYMENT_APP', message: GOOGLE_CHAT_DEPLOYMENT_APP_MESSAGE }
  }
  return {
    ok: true,
    identity: {
      name: `Google Chat · ${resolved.projectId}`,
      externalAppId: resolved.projectNumber,
      // The customer the probe proved becomes the row's own fence from the start (§10.3).
      ...(resolved.customerId ? { platformConfig: { customerId: resolved.customerId } } : {})
    }
  }
}

/** The owning project of a validated key's service account; throws for a key validation would have refused. */
export function googleChatKeyProject(serviceAccountKey: string): string {
  const email = (JSON.parse(serviceAccountKey) as Record<string, unknown>).client_email
  const projectId = typeof email === 'string' ? serviceAccountProject(email) : undefined
  if (!projectId) throw new Error('googlechat install requires a user-managed service-account key')
  return projectId
}

/** The rows one Chat app writes, keyed by its resolved identity and, for a claimed customer, by that customer (§10.3); a single-tenant row only records its own ids beside the tenantless key. */
export function buildGoogleChatInstall(
  app: ResolvedGoogleChatApp,
  tenant: GoogleChatTenant = {},
  keying: 'customer' | 'single' = 'customer'
): CpNewBotInstall {
  const { projectId, projectNumber } = app
  const primary = keying === 'customer' ? googleChatPrimaryTenant(tenant) : undefined
  return {
    bot: { externalAppId: projectNumber, platformConfig: { projectId, ...googleChatTenantEntries(tenant) } },
    // The key's canonical JSON in the `botToken` slot; it reaches the assigned daemon only.
    secrets: {
      botToken: JSON.stringify(JSON.parse(app.serviceAccountKey)),
      appToken: null,
      signingSecret: null
    },
    externalIdentity: {
      externalAppId: projectNumber,
      externalTenantId: primary ?? TENANTLESS_SENTINEL,
      conflictMessage: primary ? GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE : GOOGLE_CHAT_APP_TAKEN_MESSAGE
    }
  }
}

/** Every tenant key a bot row is known by; empty for a single-tenant row. */
export function googleChatRowTenantKeys(bot: Pick<BotRecord, 'externalTenantId' | 'platformConfig'>): string[] {
  const keys = googleChatTenantKeys(googleChatTenantOf(bot.platformConfig))
  const primary = bot.externalTenantId
  if (primary && primary !== TENANTLESS_SENTINEL && !keys.includes(primary)) keys.unshift(primary)
  return keys
}

/** The deployment app's anchor for the relay snapshot (§10.4): its audience and the console's claim page; none unless the page is https. */
export function googleChatClaimAnchor(
  app: Pick<GoogleChatPlatformAppConfig, 'projectNumber'> | undefined,
  webAppUrl: string | undefined
): RcGoogleChatAnchor | undefined {
  if (!app || !webAppUrl) return undefined
  const anchor = RcGoogleChatAnchor.safeParse({
    projectNumber: app.projectNumber,
    claimUrl: `${webAppUrl.replace(/\/+$/, '')}/googlechat/claim`
  })
  return anchor.success ? anchor.data : undefined
}

/** The two shapes a Google Chat bot row takes (§10.3): a claimed customer of the deployment app, or one organization's own app. */
export type GoogleChatRowKind = 'customer' | 'single'

type GoogleChatRowIdentity = Pick<BotRecord, 'externalAppId'> &
  Partial<Pick<BotRecord, 'externalTenantId' | 'platformConfig'>>

/** A row keyed by a tenant is a customer row; every tenantless row is single-tenant. */
export function googleChatRowKind(bot: GoogleChatRowIdentity): GoogleChatRowKind {
  return (bot.externalTenantId ?? TENANTLESS_SENTINEL) === TENANTLESS_SENTINEL ? 'single' : 'customer'
}

/** A tenantless row of the deployment app's project (an organization's own install of it): it would shadow the relay's anchor and take other Workspaces' DMs, so it serves nothing (§10.4). */
export function googleChatRowShadowsAnchor(
  bot: GoogleChatRowIdentity,
  deploymentProjectNumber: string | undefined
): boolean {
  return googleChatRowKind(bot) === 'single' && !!bot.externalAppId && bot.externalAppId === deploymentProjectNumber
}

/** The tenant fields the daemon and the relay both read, by row kind: strict keys for a customer row, the recorded own keys for a single-tenant row. */
function googleChatRowTenantFields(bot: GoogleChatRowIdentity): { tenantIds?: string[]; ownTenantIds?: string[] } {
  if (googleChatRowKind(bot) === 'customer') {
    return {
      tenantIds: googleChatRowTenantKeys({
        externalTenantId: bot.externalTenantId ?? null,
        platformConfig: bot.platformConfig ?? null
      })
    }
  }
  const own = googleChatTenantKeys(googleChatTenantOf(bot.platformConfig))
  return own.length > 0 ? { ownTenantIds: own } : {}
}

/** The daemon spec payload, with the relay's events URL for an add-on's card actions (§11); undefined when the row lacks its app identity or key. */
export function googleChatIntegrationConfig(
  bot: GoogleChatRowIdentity,
  secrets: Pick<BotSecretMaterial, 'botToken'>,
  publicRelayUrl?: string
): IntegrationGoogleChatConfig | undefined {
  const projectId = bot.platformConfig?.projectId
  if (!bot.externalAppId || typeof projectId !== 'string' || !secrets.botToken) return undefined
  return {
    projectId,
    projectNumber: bot.externalAppId,
    serviceAccountKey: secrets.botToken,
    ...googleChatRowTenantFields(bot),
    ...(publicRelayUrl ? { eventsUrl: googleChatEventsUrl(publicRelayUrl) } : {})
  }
}

/** The relay assignment: no secret, the project number as audience (§2), the app's identity, a customer row's tenant keys, and a single-tenant row's own keys. */
export function googleChatBotAssignBags(bot: GoogleChatRowIdentity & Pick<BotRecord, 'botUserId'>): {
  secrets: Record<string, unknown>
  ingress: Record<string, unknown>
} {
  const fields = googleChatRowTenantFields(bot)
  return {
    secrets: {},
    ingress: {
      ...(bot.externalAppId ? { apiAppId: bot.externalAppId } : {}),
      ...(bot.botUserId ? { appUserName: bot.botUserId } : {}),
      ...(fields.tenantIds?.length ? { tenantIds: fields.tenantIds } : {}),
      ...(fields.ownTenantIds ? { ownTenantIds: fields.ownTenantIds } : {})
    }
  }
}

/** A single-tenant row records what its traffic names (§10.3); a customer row learns only through claims and a row shadowing the anchor serves nothing. */
export function learnGoogleChatTenant(
  bot: GoogleChatRowIdentity,
  current: BotIdentitySnapshot,
  tenantId: string,
  deploymentProjectNumber?: string
): CpTenantLearning {
  const row = { ...bot, externalTenantId: current.externalTenantId }
  if (googleChatRowKind(row) === 'customer') return { kind: 'refused', reason: 'a customer row does not learn tenants' }
  if (googleChatRowShadowsAnchor(row, deploymentProjectNumber))
    return { kind: 'refused', reason: 'the deployment app’s tenantless row serves nothing' }
  const learning = googleChatTenantLearning(current.platformConfig, tenantId)
  return learning.kind === 'record' ? { kind: 'record', change: { platformConfig: learning.entries } } : learning
}

export interface GoogleChatCpProviderDeps {
  /** The Google HTTP layer for the credential probe; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** The key and claim routes, pre-bound by the composition root. */
  installRoutes?: { org: FastifyPluginAsync[]; publicCallback: FastifyPluginAsync[] }
  /** The deployment app, read per call: organizations claim it from Google Chat and never install it per agent (§3). */
  readonly app?: Pick<GoogleChatPlatformAppConfig, 'projectNumber'>
  /** The boot pass that re-stamps a rotated deployment key on the customer rows (§10.3). */
  credentialReconciler?: { start(): void; stop(): void }
  /** The relay pool's public http(s) origin, under which the daemon names the events URL in an add-on's card actions (§11). */
  publicRelayUrl?: string
}

export function createGoogleChatCpProvider(
  deps: GoogleChatCpProviderDeps = {}
): CpPlatformProvider<GoogleChatCreateCredentials> {
  const fetchImpl: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init)
  return {
    platformId: GOOGLE_CHAT_PLATFORM,

    installRoutes: (scope) =>
      scope === 'org' ? (deps.installRoutes?.org ?? []) : (deps.installRoutes?.publicCallback ?? []),

    credentialBodySchema: GoogleChatCreateCredentials,

    refineCreateBody: refineGoogleChatCreateBody,

    validateConfig: (credentials) => validateGoogleChatApp(credentials, fetchImpl, deps.app?.projectNumber),

    // One app serves one agent in this version, so a requested `shareable` is dropped.
    buildNewBotInstall: ({ credentials, identity }) => {
      if (!identity.externalAppId) throw new Error('googlechat install requires the resolved project number')
      // The project comes from the authenticated service-account email, as validation required it to; the customer the probe proved is stamped, never keyed.
      const customerId = identity.platformConfig?.customerId
      return buildGoogleChatInstall(
        {
          projectId: googleChatKeyProject(credentials.serviceAccountKey),
          projectNumber: identity.externalAppId,
          serviceAccountKey: credentials.serviceAccountKey
        },
        customerId ? { customerId } : {},
        'single'
      )
    },

    // The project number plus the claimed customer's primary key (the tenantless sentinel otherwise), and the ids as public metadata.
    projectBotIdentity: (input) => {
      if (!input.externalAppId) return {}
      const tenant = googleChatTenantOf(input.platformConfig)
      const platformConfig = {
        ...(input.platformConfig?.projectId ? { projectId: input.platformConfig.projectId } : {}),
        ...googleChatTenantEntries(tenant)
      }
      return {
        externalAppId: input.externalAppId,
        externalTenantId: googleChatPrimaryTenant(tenant) ?? TENANTLESS_SENTINEL,
        ...(Object.keys(platformConfig).length > 0 ? { platformConfig } : {})
      }
    },

    secretShape: {
      slots: { botToken: 'Google Chat service-account key JSON (daemon egress only; never sent to the relay)' },
      httpAssignRequires: []
    },

    envSchema: GoogleChatCpEnvSchema,

    // The one loop re-stamps keys; Google offers no app-authenticated read of the app's `users/…` name, so only traffic reveals it (§3).
    ...(deps.credentialReconciler
      ? {
          backgroundLoops: [
            {
              label: 'googlechat-credential-restamp',
              start: () => deps.credentialReconciler!.start(),
              stop: () => deps.credentialReconciler!.stop()
            }
          ]
        }
      : {}),

    learnTenant: (bot, current, tenantId) => learnGoogleChatTenant(bot, current, tenantId, deps.app?.projectNumber),

    // A freed customer row is deleted so the customer can be claimed anew, by any organization (§10.5).
    releasesFreedBot: (bot) => googleChatRowKind(bot) === 'customer',

    // The relay's anchor owns the deployment audience app-only; a tenantless row of that project must not shadow it (§10.4).
    relayAssignable: (bot) => !googleChatRowShadowsAnchor(bot, deps.app?.projectNumber),

    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return googleChatRowShadowsAnchor(bot, deps.app?.projectNumber)
        ? undefined
        : googleChatIntegrationConfig(bot, secrets, deps.publicRelayUrl)
    },

    async projectBotAssign(bot) {
      return googleChatBotAssignBags(bot)
    }
  }
}
