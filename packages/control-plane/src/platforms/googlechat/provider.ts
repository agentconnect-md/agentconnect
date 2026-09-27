// Google Chat's Control Plane provider (google-chat-integration.md §3, §7): one provider for both credential holders.
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { GOOGLE_CHAT_PLATFORM, type IntegrationGoogleChatConfig } from '@agentconnect.md/protocol'
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
  GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: z.string().optional(),
  // Explicit enum, not z.coerce.boolean(), so 'false' stays false.
  GOOGLE_CHAT_PLATFORM_MULTI_TENANT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
} satisfies ZodRawShape

/** The 409 copy of the one-bot-per-app fence; a Chat app cannot move between agents or organizations. */
export const GOOGLE_CHAT_APP_TAKEN_MESSAGE =
  'This Google Chat app is already connected to an agent. Each Chat app serves one agent; create a Chat app in its own Google Cloud project for this agent.'

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

/** The provider's `validateConfig`: the resolved app becomes the identity core persists. */
export async function validateGoogleChatApp(
  credentials: GoogleChatCreateCredentials,
  fetchImpl: typeof fetch
): Promise<CpConfigValidation> {
  const resolved = await resolveGoogleChatApp(credentials, fetchImpl)
  if (!resolved.ok) return resolved
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

/** Every tenant key a bot row is known by; empty for a single-tenant row and for the anchor. */
export function googleChatRowTenantKeys(bot: Pick<BotRecord, 'externalTenantId' | 'platformConfig'>): string[] {
  const keys = googleChatTenantKeys(googleChatTenantOf(bot.platformConfig))
  const primary = bot.externalTenantId
  if (primary && primary !== TENANTLESS_SENTINEL && !keys.includes(primary)) keys.unshift(primary)
  return keys
}

/** The multi-tenant deployment app's anchor: its project number and the console's claim page (§10.5). */
export interface GoogleChatClaimAnchor {
  projectNumber: string
  claimUrl: string
}

/** The three shapes a Google Chat bot row takes (§10.3): a claimed customer row, the multi-tenant anchor, or one organization's own app. */
export type GoogleChatRowKind = 'customer' | 'anchor' | 'single'

type GoogleChatRowIdentity = Pick<BotRecord, 'externalAppId'> &
  Partial<Pick<BotRecord, 'externalTenantId' | 'platformConfig'>>

/** A row keyed by a tenant is a customer row; the deployment app's tenantless row is the anchor while the switch is on; every other row is single-tenant. */
export function googleChatRowKind(bot: GoogleChatRowIdentity, anchor?: GoogleChatClaimAnchor): GoogleChatRowKind {
  const primary = bot.externalTenantId ?? TENANTLESS_SENTINEL
  if (primary !== TENANTLESS_SENTINEL) return 'customer'
  return anchor && bot.externalAppId === anchor.projectNumber ? 'anchor' : 'single'
}

/** The tenant fields the daemon and the relay both read, by row kind: strict keys for a customer row (none for the anchor), the recorded own keys for a single-tenant row. */
function googleChatRowTenantFields(
  bot: GoogleChatRowIdentity,
  anchor?: GoogleChatClaimAnchor
): { tenantIds?: string[]; ownTenantIds?: string[] } {
  const identity = { externalTenantId: bot.externalTenantId ?? null, platformConfig: bot.platformConfig ?? null }
  switch (googleChatRowKind(bot, anchor)) {
    case 'customer':
      return { tenantIds: googleChatRowTenantKeys(identity) }
    case 'anchor':
      return { tenantIds: [] }
    case 'single': {
      const own = googleChatTenantKeys(googleChatTenantOf(bot.platformConfig))
      return own.length > 0 ? { ownTenantIds: own } : {}
    }
  }
}

/** The daemon spec payload; undefined when the row lacks its app identity or key, which withholds the integration. */
export function googleChatIntegrationConfig(
  bot: GoogleChatRowIdentity,
  secrets: Pick<BotSecretMaterial, 'botToken'>,
  anchor?: GoogleChatClaimAnchor
): IntegrationGoogleChatConfig | undefined {
  const projectId = bot.platformConfig?.projectId
  if (!bot.externalAppId || typeof projectId !== 'string' || !secrets.botToken) return undefined
  return {
    projectId,
    projectNumber: bot.externalAppId,
    serviceAccountKey: secrets.botToken,
    ...googleChatRowTenantFields(bot, anchor)
  }
}

/** The relay assignment: no secret, the project number as audience (§2), the app's identity, a customer row's tenant keys, a single-tenant row's own keys, and the anchor's claim page. */
export function googleChatBotAssignBags(
  bot: GoogleChatRowIdentity & Pick<BotRecord, 'botUserId'>,
  anchor?: GoogleChatClaimAnchor
): {
  secrets: Record<string, unknown>
  ingress: Record<string, unknown>
} {
  const kind = googleChatRowKind(bot, anchor)
  const fields = googleChatRowTenantFields(bot, anchor)
  return {
    secrets: {},
    ingress: {
      ...(bot.externalAppId ? { apiAppId: bot.externalAppId } : {}),
      ...(bot.botUserId ? { appUserName: bot.botUserId } : {}),
      ...(fields.tenantIds?.length ? { tenantIds: fields.tenantIds } : {}),
      ...(fields.ownTenantIds ? { ownTenantIds: fields.ownTenantIds } : {}),
      ...(kind === 'anchor' && anchor ? { claimUrl: anchor.claimUrl } : {})
    }
  }
}

/** A single-tenant row records what its traffic names (§10.3); a customer row learns only through claims and the anchor serves no tenant. */
export function learnGoogleChatTenant(
  bot: GoogleChatRowIdentity,
  current: BotIdentitySnapshot,
  tenantId: string,
  anchor?: GoogleChatClaimAnchor
): CpTenantLearning {
  const kind = googleChatRowKind({ ...bot, externalTenantId: current.externalTenantId }, anchor)
  if (kind !== 'single') return { kind: 'refused', reason: `a ${kind} row does not learn tenants` }
  const learning = googleChatTenantLearning(current.platformConfig, tenantId)
  return learning.kind === 'record' ? { kind: 'record', change: { platformConfig: learning.entries } } : learning
}

export interface GoogleChatCpProviderDeps {
  /** The Google HTTP layer for the credential probe; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** The deployment-app install route, pre-bound by the composition root. */
  installRoutes?: { org: FastifyPluginAsync[]; publicCallback: FastifyPluginAsync[] }
  /** Present only when the deployment app is multi-tenant: its anchor row's assignment carries the claim page. */
  claimAnchor?: GoogleChatClaimAnchor
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

    validateConfig: (credentials) => validateGoogleChatApp(credentials, fetchImpl),

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

    // No background loop: Google offers no app-authenticated read of the app's `users/…` name, so only traffic reveals it (§3).

    learnTenant: (bot, current, tenantId) => learnGoogleChatTenant(bot, current, tenantId, deps.claimAnchor),

    // A freed customer row is deleted so the customer can be claimed anew, by any organization (§10.5).
    releasesFreedBot: (bot) => googleChatRowKind(bot, deps.claimAnchor) === 'customer',

    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return googleChatIntegrationConfig(bot, secrets, deps.claimAnchor)
    },

    async projectBotAssign(bot) {
      return googleChatBotAssignBags(bot, deps.claimAnchor)
    }
  }
}
