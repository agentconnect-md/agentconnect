// The Email provider (email-integration.md §3, §5.3, §8): an address on the deployment's mail domain, which the relay receives and sends for; an address has no credential.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  EMAIL_PLATFORM,
  EMAIL_STARTED_OWNER_PREFIX,
  EMAIL_V1_FEATURE,
  EmailWhoMayWrite,
  type IntegrationEmailConfig
} from '@agentconnect.md/protocol'
import { canonicalEmailAddress, validateEmailName, type EmailNameRefusal } from '@agentconnect.md/message'
import {
  TENANTLESS_SENTINEL,
  type BotRecord,
  type BotSecretMaterial,
  type EmailAddressRepo,
  type UserRepo
} from '../../persistence/ports.js'
import type { CpConfigRefusal, CpInstallTransport, CpPlatformProvider, CpValidatedIdentity } from '../provider.js'
import { EmailCpEnvSchema } from './deployment.js'
import {
  EMAIL_OUTSIDE_MEMBER_UNKNOWN,
  EmailOutsideSessionsBody,
  emailAddressSettings,
  emailOutsideSessionOwner,
  emailSettingsEntries
} from './settings.js'

/** The `email` block of `POST /integrations`: the address name, and optionally its two settings (§4.1). */
export const EmailCreateCredentials = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('The address name, the part before the @: 3 to 40 lower-case letters, digits, dots and hyphens.'),
  whoMayWrite: EmailWhoMayWrite.optional().describe(
    '`members` (the default): members who may use the agent; `anyone`: any authenticated sender.'
  ),
  outsideSessions: EmailOutsideSessionsBody.optional().describe(
    'Who sees a session a message from outside the organization opens; defaults to whoever can edit the agent.'
  )
})
export type EmailCreateCredentials = z.infer<typeof EmailCreateCredentials>

/** What an address's row stores in its secret slot: a marker, not a secret, since the sending credential is the deployment's and stays on the relay (§2). */
export const EMAIL_SECRET_MARKER = 'email-address:no-secret'

export function emailSecrets(): BotSecretMaterial {
  return { botToken: EMAIL_SECRET_MARKER, appToken: null, signingSecret: null }
}

/** Mail reaches an address only through the relay, so there is no socket install. */
export function refineEmailCreateBody(
  body: { credentials: EmailCreateCredentials; transport: CpInstallTransport },
  addIssue: (message: string) => void
): void {
  if (body.transport !== 'http') addIssue('email requires transport http: mail arrives through the relay')
}

export type EmailNameUnavailable = EmailNameRefusal | 'taken' | 'not_configured'

const REFUSALS: Record<EmailNameUnavailable, Omit<CpConfigRefusal, 'ok'>> = {
  not_configured: { status: 409, code: 'EMAIL_NOT_CONFIGURED', message: 'Email is not set up on this deployment.' },
  length: { status: 400, code: 'EMAIL_NAME_LENGTH', message: 'An address name is 3 to 40 characters long.' },
  characters: {
    status: 400,
    code: 'EMAIL_NAME_CHARACTERS',
    message:
      'An address name uses lower-case letters, digits, dots and hyphens, and starts and ends with a letter or a digit.'
  },
  reserved: { status: 400, code: 'EMAIL_NAME_RESERVED', message: 'This name is reserved. Choose another one.' },
  taken: {
    status: 409,
    code: 'EMAIL_ADDRESS_TAKEN',
    message: 'This address is in use or was used before, and an address is never issued twice. Choose another name.'
  }
}

/** The 409 copy when a removed address's row is offered for another install (§3). */
export const EMAIL_REUSE_MESSAGE =
  'An email address is never moved to another agent. Add Email to the agent with a new name.'

/** A name as an address on the mail domain, or why it cannot be one; reads nothing. */
export function emailAddressFor(
  name: string,
  mailDomain: string | undefined
): { ok: true; address: string } | { ok: false; reason: Exclude<EmailNameUnavailable, 'taken'> } {
  if (!mailDomain) return { ok: false, reason: 'not_configured' }
  const checked = validateEmailName(name.trim())
  return checked.ok ? { ok: true, address: `${checked.name}@${mailDomain}` } : checked
}

export interface EmailCpProviderDeps {
  /** The deployment's mail domain, lower-cased (§7); absent ⇒ Email is not set up, and nothing is created or delivered. */
  mailDomain?: string
  /** Every address ever taken; absent ⇒ nothing is created. */
  addresses?: Pick<EmailAddressRepo, 'claim'>
  /** The member an address is the verified sign-in email of; absent ⇒ no sender is matched. */
  memberByVerifiedEmail?: UserRepo['memberByVerifiedEmail']
  /** Every member an address is a verified sign-in email of, which tells an outside sender from an unmatched one; absent ⇒ nobody is outside. */
  verifiedEmailHolders?: UserRepo['verifiedEmailHolders']
  /** Whether a member an address's outside sessions go to is still active (§4.1). */
  activeMember?: UserRepo['activeMember']
  /** The name-availability route, pre-bound by the composition root. */
  installRoutes?: FastifyPluginAsync[]
}

export function createEmailCpProvider(deps: EmailCpProviderDeps = {}): CpPlatformProvider<EmailCreateCredentials> {
  // A row whose address is on another domain than the one the deployment serves now receives and sends nothing.
  const served = (bot: Pick<BotRecord, 'externalAppId'>): string | undefined =>
    deps.mailDomain && bot.externalAppId?.endsWith(`@${deps.mailDomain}`) ? bot.externalAppId : undefined
  // The one member an address is a verified sign-in email of; an address several members hold names none.
  const memberByAddress = async (orgId: string, sender: string): Promise<string | null> => {
    const address = canonicalEmailAddress(sender)
    if (!address || !deps.memberByVerifiedEmail) return null
    return (await deps.memberByVerifiedEmail(orgId, address))?.userId ?? null
  }
  return {
    platformId: EMAIL_PLATFORM,
    installRoutes: (scope) => (scope === 'org' ? (deps.installRoutes ?? []) : []),
    credentialBodySchema: EmailCreateCredentials,
    refineCreateBody: refineEmailCreateBody,
    envSchema: EmailCpEnvSchema,

    // The claim is the fence: an address is recorded before its row exists, so a create that fails afterwards leaves it taken rather than free for someone else.
    async validateConfig(credentials, _transport, context) {
      const named = emailAddressFor(credentials.name, deps.addresses ? deps.mailDomain : undefined)
      if (!named.ok) return { ok: false, ...REFUSALS[named.reason] }
      // A picked member is checked before the claim, so a refused pick leaves the name free.
      const outside = credentials.outsideSessions
      if (outside?.kind === 'member' && !(context && (await deps.activeMember?.(context.orgId, outside.userId))))
        return { ok: false, status: 400, ...EMAIL_OUTSIDE_MEMBER_UNKNOWN }
      if (!(await deps.addresses!.claim(named.address))) return { ok: false, ...REFUSALS.taken }
      const identity: CpValidatedIdentity = { name: named.address, externalAppId: named.address }
      return { ok: true, identity }
    },

    // One address serves one agent, so a requested `shareable` is dropped.
    buildNewBotInstall: ({ credentials, identity }) => {
      const address = identity.externalAppId ?? ''
      const { whoMayWrite, outsideSessions } = credentials
      const chosen = whoMayWrite !== undefined || outsideSessions !== undefined
      return {
        bot: {
          externalAppId: address,
          ...(chosen
            ? {
                platformConfig: emailSettingsEntries({
                  whoMayWrite: whoMayWrite ?? 'members',
                  outsideSessions: outsideSessions ?? { kind: 'editors' }
                })
              }
            : {})
        },
        secrets: emailSecrets(),
        externalIdentity: {
          externalAppId: address,
          externalTenantId: TENANTLESS_SENTINEL,
          conflictMessage: REFUSALS.taken.message
        }
      }
    },

    // The settings a create chose ride the bag, re-read so only the two known keys are stored.
    projectBotIdentity: (input) =>
      input.externalAppId
        ? {
            externalAppId: input.externalAppId,
            externalTenantId: TENANTLESS_SENTINEL,
            ...(input.platformConfig
              ? { platformConfig: emailSettingsEntries(emailAddressSettings({ platformConfig: input.platformConfig })) }
              : {})
          }
        : {},

    secretShape: {
      slots: { botToken: 'A fixed marker: an address has no credential, and the sending token never leaves the relay' },
      httpAssignRequires: []
    },

    // Removing the integration deletes the row, and a row an agent's deletion left behind is never installed again (§3).
    releasesFreedBot: () => true,
    reuseRefusal: () => EMAIL_REUSE_MESSAGE,
    relayAssignable: (bot) => served(bot) !== undefined,

    // The sender's address is the platform identity, matched only against a verified sign-in email of the bot's organization (§4, §5.3).
    async dmOwnerMember(bot, sender) {
      // A thread the agent started is owned from the send, by the member it names while they are an active member (§5.3).
      if (sender.startsWith(EMAIL_STARTED_OWNER_PREFIX)) {
        const userId = sender.slice(EMAIL_STARTED_OWNER_PREFIX.length)
        if (!userId || !deps.activeMember) return null
        return (await deps.activeMember(bot.orgId, userId)) ? userId : null
      }
      return await memberByAddress(bot.orgId, sender)
    },
    groupOwnedByOpener: true,

    // A transcript's sender is the member whose verified address wrote it, by the rule a direct conversation's owner is read (§5.3).
    senderMember: (orgId, sender) => memberByAddress(orgId, sender),

    // Under Anyone, a sender no member holds opens a session the address's setting places, read now and fixed then (§5.3).
    async outsiderSession(bot, sender) {
      const address = canonicalEmailAddress(sender)
      const { verifiedEmailHolders, activeMember } = deps
      if (!address || !verifiedEmailHolders || !activeMember) return null
      if ((await verifiedEmailHolders(bot.orgId, address)).length > 0) return null
      const settings = emailAddressSettings(bot)
      if (settings.whoMayWrite !== 'anyone') return null
      return await emailOutsideSessionOwner(bot.orgId, settings, { activeMember })
    },

    async projectIntegrationConfig(_integration, bot): Promise<IntegrationEmailConfig | undefined> {
      const address = served(bot)
      if (!address) return undefined
      // Who may write rides the spec, so a change reaches the daemon and drops the answers it holds (§4.1).
      const { whoMayWrite } = emailAddressSettings(bot)
      return { address, egress: 'relay', botId: bot.id, whoMayWrite }
    },

    requiredDaemonFeatures: () => [EMAIL_V1_FEATURE],

    // No secret: the relay finds the row by the envelope recipient and sends with the deployment's token.
    async projectBotAssign(bot) {
      const address = served(bot)
      return { secrets: {}, ingress: address ? { apiAppId: address } : {} }
    }
  }
}
