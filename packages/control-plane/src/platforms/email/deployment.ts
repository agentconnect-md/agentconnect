// The deployment's Email configuration (email-integration.md §7), projected from the Setup Server's `email` slice: the four keys or none.
import { createHmac } from 'node:crypto'
import { z, type ZodRawShape } from 'zod'
import { EMAIL_AUTHSERV_ID_DEFAULT, RcEmailDeployment } from '@agentconnect.md/protocol'

export const EmailCpEnvSchema = {
  EMAIL_PLATFORM_MAIL_DOMAIN: z.string().optional(),
  EMAIL_PLATFORM_ACCOUNT_ID: z.string().optional(),
  EMAIL_PLATFORM_API_TOKEN: z.string().optional(),
  EMAIL_PLATFORM_INGRESS_SECRET: z.string().optional(),
  // The most messages the whole deployment sends in a day (§6.3); unset, only the per-address and per-organization budgets apply.
  EMAIL_PLATFORM_DAILY_SEND_LIMIT: z.coerce.number().int().positive().optional()
} satisfies ZodRawShape

export interface EmailDeployment {
  /** The domain every agent address is on, lower-cased. */
  mailDomain: string
  accountId: string
  /** Secret material, never logged or returned; it reaches the relay and never a daemon (§2). */
  apiToken: string
  /** The secret the ingress Worker signs each inbound post with; never logged or returned. */
  ingressSecret: string
  dailySendLimit?: number
}

interface Env {
  EMAIL_PLATFORM_MAIL_DOMAIN?: string | undefined
  EMAIL_PLATFORM_ACCOUNT_ID?: string | undefined
  EMAIL_PLATFORM_API_TOKEN?: string | undefined
  EMAIL_PLATFORM_INGRESS_SECRET?: string | undefined
  EMAIL_PLATFORM_DAILY_SEND_LIMIT?: number | undefined
}

/** The key relays sign reply tickets with (§6.2), derived from the pepper like the CP's other signing keys; base64url. */
export function emailRelayTicketKey(pepper: string): string {
  return createHmac('sha256', pepper).update('email-relay-ticket-v1').digest('base64url')
}

/** Undefined ⇒ Email is not set up. Throws on a partial set, and on a value the relay would refuse. */
export function resolveEmailDeployment(env: Env): EmailDeployment | undefined {
  const mailDomain = env.EMAIL_PLATFORM_MAIL_DOMAIN
  const accountId = env.EMAIL_PLATFORM_ACCOUNT_ID
  const apiToken = env.EMAIL_PLATFORM_API_TOKEN
  const ingressSecret = env.EMAIL_PLATFORM_INGRESS_SECRET
  const set = [mailDomain, accountId, apiToken, ingressSecret].filter((value) => value !== undefined).length
  if (set === 0) return undefined
  if (set < 4 || !mailDomain || !accountId || !apiToken || !ingressSecret)
    throw new Error('email config is partial (set all four EMAIL_PLATFORM_* keys or none)')
  const email: EmailDeployment = {
    mailDomain: mailDomain.trim().toLowerCase(),
    accountId: accountId.trim().toLowerCase(),
    apiToken,
    ingressSecret,
    ...(env.EMAIL_PLATFORM_DAILY_SEND_LIMIT ? { dailySendLimit: env.EMAIL_PLATFORM_DAILY_SEND_LIMIT } : {})
  }
  // The same shape the relay reads, so a value it would refuse stops the boot rather than turning mail off silently.
  const issue = RcEmailDeployment.safeParse(relayShape(email, 'k'.repeat(43))).error?.issues[0]
  if (issue) throw new Error(`email config is invalid: EMAIL_PLATFORM value for ${issue.path.join('.')} was refused`)
  return email
}

function relayShape(email: EmailDeployment, ticketKey: string): RcEmailDeployment {
  return {
    mailDomain: email.mailDomain,
    accountId: email.accountId,
    apiToken: email.apiToken,
    ingressSecret: email.ingressSecret,
    authservId: EMAIL_AUTHSERV_ID_DEFAULT,
    ...(email.dailySendLimit ? { dailySendLimit: email.dailySendLimit } : {}),
    ticketKey
  }
}

/** The configuration as the relay receives and sends with it (§7); none while Email is not set up. */
export function emailRelayDeployment(
  email: EmailDeployment | undefined,
  pepper: string
): RcEmailDeployment | undefined {
  return email ? RcEmailDeployment.parse(relayShape(email, emailRelayTicketKey(pepper))) : undefined
}
