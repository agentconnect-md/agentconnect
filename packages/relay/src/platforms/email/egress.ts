// The deployment's mail sender on the relay (email-integration.md §6.2, §6.3): a reply goes out with the deployment's token, which never reaches a daemon.
import {
  EMAIL_RECIPIENTS_MAX,
  RD_PLATFORM_REQUEST_BUDGET_MS,
  type RcEmailDeployment,
  type RdPlatformReply,
  type WireEmailCall
} from '@agentconnect.md/protocol'
import { EmailSendBudgets, type EmailSendReservation } from './counters.js'
import { emailTicketAudience, openEmailTicket } from './ticket.js'
import { retryAfterMs } from '../provider-call.js'

/** The provider's REST root; a test names a local server instead. */
export const EMAIL_PROVIDER_API_BASE = 'https://api.cloudflare.com/client/v4'
/** A send is not started with less than this left of the request's budget. */
const MIN_SEND_MS = 1_000
/** The provider's limit on one header value, in bytes. */
const HEADER_VALUE_MAX_BYTES = 2_048

/** What the relay answers a send with, as the `payload` of an `ok` reply: the provider's status and JSON body; `504` stands for a call that got no answer and may have been sent. */
export interface EmailSendResult {
  status: number
  body?: Record<string, unknown>
  retryAfterMs?: number
}

/** The address a send goes out as: the assignment's, and the organization its budget is counted in. */
export interface EmailSender {
  botId: string
  address: string
  organization: string
}

const refused = (reason: string): RdPlatformReply => ({ outcome: 'refused', reason })
const answered = (payload: EmailSendResult): RdPlatformReply => ({ outcome: 'ok', payload })

// `References` as one header value inside the provider's limit; the oldest IDs are dropped first, as §6.1 cuts the chain.
function referencesHeader(ids: readonly string[]): string {
  const kept = ids.map((id) => `<${id}>`)
  while (kept.length > 1 && Buffer.byteLength(kept.join(' ')) > HEADER_VALUE_MAX_BYTES) kept.shift()
  return kept.join(' ')
}

type EmailReplyCall = Extract<WireEmailCall, { op: 'send' }>
type EmailStartCall = Extract<WireEmailCall, { op: 'start' }>

/** The provider request a send makes; the sender is the assignment's address, whatever the daemon would have named. */
export function emailSendRequest(sender: EmailSender, call: EmailReplyCall): Record<string, unknown> {
  const to = [...new Set(call.to)]
  const cc = [...new Set(call.cc)].filter((address) => !to.includes(address))
  return {
    from: { address: sender.address, ...(call.fromName?.trim() ? { name: call.fromName.trim() } : {}) },
    to,
    ...(cc.length ? { cc } : {}),
    subject: call.subject,
    text: call.text,
    html: call.html,
    headers: {
      'In-Reply-To': `<${call.inReplyTo}>`,
      References: referencesHeader(call.references.length ? call.references : [call.inReplyTo]),
      // RFC 3834: other automatic responders stay silent (§6.1).
      'Auto-Submitted': 'auto-replied'
    }
  }
}

/** A started mail's recipients, each once, or why the relay refuses them: more than a send carries, or one on the deployment's own mail domain (§6.4). */
export function emailStartRecipients(
  call: Pick<EmailStartCall, 'to' | 'cc'>,
  mailDomain: string
): { to: string[]; cc: string[] } | 'recipients' | 'own_domain' {
  const to = [...new Set(call.to)]
  const cc = [...new Set(call.cc)].filter((address) => !to.includes(address))
  if (to.length + cc.length > EMAIL_RECIPIENTS_MAX) return 'recipients'
  const domain = mailDomain.toLowerCase()
  // Mail between agents stays excluded, as §4 step 1 keeps it on the way in.
  const own = (address: string) => {
    const at = address.slice(address.lastIndexOf('@') + 1)
    return at === domain || at.endsWith(`.${domain}`)
  }
  return [...to, ...cc].some(own) ? 'own_domain' : { to, cc }
}

/** The provider request a started mail makes: `From` and `Reply-To` from the assignment's address, the tag naming the new thread (§6.4). */
export function emailStartRequest(
  sender: EmailSender,
  call: EmailStartCall,
  recipients: { to: string[]; cc: string[] }
): Record<string, unknown> {
  const at = sender.address.lastIndexOf('@')
  const replyTo = `${sender.address.slice(0, at)}+${call.tag}${sender.address.slice(at)}`
  return {
    from: { address: sender.address, ...(call.fromName?.trim() ? { name: call.fromName.trim() } : {}) },
    to: recipients.to,
    ...(recipients.cc.length ? { cc: recipients.cc } : {}),
    subject: call.subject,
    text: call.text,
    html: call.html,
    headers: {
      'Reply-To': replyTo,
      // RFC 3834: a mail nobody answered is `auto-generated`, so other automatic responders stay silent too.
      'Auto-Submitted': 'auto-generated'
    }
  }
}

export class EmailRelayEgress {
  private readonly budgets = new EmailSendBudgets()

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly apiBase: string = EMAIL_PROVIDER_API_BASE,
    private readonly now: () => number = Date.now,
    /** The whole call's bound, the single retry included, so the relay answers before the daemon stops waiting. */
    private readonly budgetMs: number = RD_PLATFORM_REQUEST_BUDGET_MS,
    /** Elapsed time for the budget, apart from `now`, which dates the counters. */
    private readonly clock: () => number = () => performance.now()
  ) {}

  /** Send one reply for `sender` within the request budget; the caller has checked the daemon serves the bot. */
  async send(config: RcEmailDeployment, sender: EmailSender, call: EmailReplyCall): Promise<RdPlatformReply> {
    const started = this.clock()
    const audience = emailTicketAudience(call.audience)
    if (!openEmailTicket(Buffer.from(config.ticketKey, 'base64url'), sender.botId, call.ticket, audience))
      return refused('ticket')
    // The ticket vouches for the people an admitted mail named, and a reply reaches nobody else (§6.2).
    if (![...call.to, ...call.cc].every((address) => audience.includes(address))) return refused('recipient')
    const reservation = this.budgets.reserve(
      {
        botId: sender.botId,
        organization: sender.organization,
        ...(config.dailySendLimit !== undefined ? { deploymentLimit: config.dailySendLimit } : {}),
        // A reply that reaches someone outside the organization spends the outside budget, never members' replies (§6.4).
        ...(call.outside ? { outside: { recipients: new Set([...call.to, ...call.cc]).size } } : {})
      },
      this.now()
    )
    if (typeof reservation === 'string') return refused(reservation)
    return await this.deliver(config, emailSendRequest(sender, call), reservation, started)
  }

  /** Start one mail for `sender` (§6.4): no ticket, so its recipients are checked here and every one of them counts on the outside budget. */
  async start(config: RcEmailDeployment, sender: EmailSender, call: EmailStartCall): Promise<RdPlatformReply> {
    const started = this.clock()
    const recipients = emailStartRecipients(call, config.mailDomain)
    if (typeof recipients === 'string') return refused(recipients)
    const reservation = this.budgets.reserve(
      {
        botId: sender.botId,
        organization: sender.organization,
        ...(config.dailySendLimit !== undefined ? { deploymentLimit: config.dailySendLimit } : {}),
        outside: { recipients: recipients.to.length + recipients.cc.length }
      },
      this.now()
    )
    if (typeof reservation === 'string') return refused(reservation)
    return await this.deliver(config, emailStartRequest(sender, call, recipients), reservation, started)
  }

  // One provider call within the request's budget, retried once on a rate limit; a call that sent nothing gives its budget back.
  private async deliver(
    config: RcEmailDeployment,
    request: Record<string, unknown>,
    reservation: EmailSendReservation,
    started: number
  ): Promise<RdPlatformReply> {
    const left = () => this.budgetMs - (this.clock() - started)
    const url = `${this.apiBase}/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`
    const body = JSON.stringify(request)
    let result = await this.post(url, config.apiToken, body, left())
    // Only a rate-limit answer proves nothing was sent, so it alone is tried again, once, when its wait fits the budget.
    if (result.status === 429) {
      const wait = result.retryAfterMs ?? 0
      if (left() - wait >= MIN_SEND_MS) {
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
        result = await this.post(url, config.apiToken, body, left())
      }
    }
    // An answer other than success means nothing was sent; no answer may mean it was, and keeps its place in the budgets.
    if (result.status !== 504 && (result.status < 200 || result.status >= 300)) reservation.release()
    return answered(result)
  }

  private async post(url: string, token: string, body: string, timeoutMs: number): Promise<EmailSendResult> {
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
      })
    } catch {
      // No answer: the mail may have been sent, which the daemon reads from a gateway timeout and never repeats.
      return { status: 504 }
    }
    const parsed: unknown = await res.json().catch(() => undefined)
    const json =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    const wait = retryAfterMs(res, this.now())
    return {
      status: res.status,
      ...(json ? { body: json } : {}),
      ...(wait !== undefined ? { retryAfterMs: wait } : {})
    }
  }
}
