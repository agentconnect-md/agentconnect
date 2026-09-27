// Google Chat's Control Plane provider (google-chat-integration.md §3, §7): one provider for both credential holders.
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { GOOGLE_CHAT_PLATFORM, type IntegrationGoogleChatConfig } from '@agentconnect.md/protocol'
import { TENANTLESS_SENTINEL, type BotRecord, type BotSecretMaterial } from '../../persistence/ports.js'
import type {
  CpConfigRefusal,
  CpConfigValidation,
  CpInstallTransport,
  CpNewBotInstall,
  CpPlatformProvider
} from '../provider.js'
import {
  checkGoogleChatApp,
  probeFailureIsConnectivity,
  serviceAccountProject,
  type GoogleChatAppFailure
} from './credential.js'

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
      serviceAccountKey: checked.key.json
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
    identity: { name: `Google Chat · ${resolved.projectId}`, externalAppId: resolved.projectNumber }
  }
}

/** The owning project of a validated key's service account; throws for a key validation would have refused. */
export function googleChatKeyProject(serviceAccountKey: string): string {
  const email = (JSON.parse(serviceAccountKey) as Record<string, unknown>).client_email
  const projectId = typeof email === 'string' ? serviceAccountProject(email) : undefined
  if (!projectId) throw new Error('googlechat install requires a user-managed service-account key')
  return projectId
}

/** The rows one Chat app writes, keyed by its resolved identity. */
export function buildGoogleChatInstall(app: ResolvedGoogleChatApp): CpNewBotInstall {
  const { projectId, projectNumber } = app
  return {
    bot: { externalAppId: projectNumber, platformConfig: { projectId } },
    // The key's canonical JSON in the `botToken` slot; it reaches the assigned daemon only.
    secrets: {
      botToken: JSON.stringify(JSON.parse(app.serviceAccountKey)),
      appToken: null,
      signingSecret: null
    },
    externalIdentity: {
      externalAppId: projectNumber,
      externalTenantId: TENANTLESS_SENTINEL,
      conflictMessage: GOOGLE_CHAT_APP_TAKEN_MESSAGE
    }
  }
}

/** The daemon spec payload; undefined when the row lacks its app identity or key, which withholds the integration. */
export function googleChatIntegrationConfig(
  bot: Pick<BotRecord, 'externalAppId' | 'platformConfig'>,
  secrets: Pick<BotSecretMaterial, 'botToken'>
): IntegrationGoogleChatConfig | undefined {
  const projectId = bot.platformConfig?.projectId
  if (!bot.externalAppId || typeof projectId !== 'string' || !secrets.botToken) return undefined
  return { projectId, projectNumber: bot.externalAppId, serviceAccountKey: secrets.botToken }
}

/** The relay assignment: no secret, and the project number as both the demux key and the expected token audience (§2). */
export function googleChatBotAssignBags(bot: Pick<BotRecord, 'externalAppId'>): {
  secrets: Record<string, unknown>
  ingress: Record<string, unknown>
} {
  return { secrets: {}, ingress: bot.externalAppId ? { apiAppId: bot.externalAppId } : {} }
}

export interface GoogleChatCpProviderDeps {
  /** The Google HTTP layer for the credential probe; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** The deployment-app install route, pre-bound by the composition root. */
  installRoutes?: { org: FastifyPluginAsync[]; publicCallback: FastifyPluginAsync[] }
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
      // The project comes from the authenticated service-account email, as validation required it to.
      return buildGoogleChatInstall({
        projectId: googleChatKeyProject(credentials.serviceAccountKey),
        projectNumber: identity.externalAppId,
        serviceAccountKey: credentials.serviceAccountKey
      })
    },

    // App-scoped with no tenant axis: the project number plus the tenantless sentinel, and the project ID as public metadata.
    projectBotIdentity: (input) =>
      input.externalAppId
        ? {
            externalAppId: input.externalAppId,
            externalTenantId: TENANTLESS_SENTINEL,
            ...(input.platformConfig?.projectId
              ? { platformConfig: { projectId: input.platformConfig.projectId } }
              : {})
          }
        : {},

    secretShape: {
      slots: { botToken: 'Google Chat service-account key JSON (daemon egress only; never sent to the relay)' },
      httpAssignRequires: []
    },

    envSchema: GoogleChatCpEnvSchema,

    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return googleChatIntegrationConfig(bot, secrets)
    },

    async projectBotAssign(bot) {
      return googleChatBotAssignBags(bot)
    }
  }
}
