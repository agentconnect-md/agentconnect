// The deployment Teams app's answer to a tenant no organization connected (teams-integration.md §8.4): a welcome or Connect card, posted by the relay itself.
import type { RcMsTeamsAnchor } from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'

const TOKEN_SCOPE = 'https://api.botframework.com/.default'
const TIMEOUT_MS = 10_000
/** A token is refreshed this long before Entra says it expires. */
const TOKEN_MARGIN_MS = 60_000
const GUIDE_URL = 'https://www.agentconnect.md/docs/connect-automate/chat-platforms'
const SUPPORT_EMAIL = 'contact@agentconnect.md'

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

/** What the anchor does with one activity: a welcome on the bot's own install, a Connect reply to an address, or nothing. */
export type MsTeamsAnchorAnswer =
  | { kind: 'welcome'; target: AnchorTarget; addedBy?: { id: string; name?: string } }
  | { kind: 'connect'; target: AnchorTarget }
  | undefined

interface AnchorTarget {
  serviceUrl: string
  /** The raw conversation ID, `;messageid=` kept, so a channel reply lands in its thread. */
  conversationId: string
  tenantId: string
}

/** Decide the anchor's answer: only the bot's own install and a DM or mention of it are answered. */
export function msTeamsAnchorAnswer(activity: Obj, appId: string, tenantId: string | undefined): MsTeamsAnchorAnswer {
  const bot = `28:${appId}`.toLowerCase()
  const conversation = obj(activity.conversation)
  const serviceUrl = str(activity.serviceUrl)
  const conversationId = str(conversation?.id)
  if (!serviceUrl || !conversationId || !tenantId) return undefined
  const target = { serviceUrl, conversationId, tenantId }
  const from = obj(activity.from)
  if (activity.type === 'conversationUpdate') {
    const added = Array.isArray(activity.membersAdded) ? activity.membersAdded : []
    if (!added.some((entry) => str(obj(entry)?.id)?.toLowerCase() === bot)) return undefined
    const fromId = str(from?.id)
    const fromName = str(from?.name)?.replace(/[<>]/g, '').trim()
    const personal = conversation?.conversationType === 'personal'
    return {
      kind: 'welcome',
      // An install's welcome starts the conversation rather than replying in a thread.
      target: { ...target, conversationId: conversationId.split(';')[0]! },
      // A team install names its installer by ID only; the post looks the name up.
      ...(!personal && fromId ? { addedBy: { id: fromId, ...(fromName ? { name: fromName } : {}) } } : {})
    }
  }
  if (activity.type !== 'message' || str(from?.id)?.toLowerCase() === bot) return undefined
  if (conversation?.conversationType === 'personal') return { kind: 'connect', target }
  const entities = Array.isArray(activity.entities) ? activity.entities : []
  const mentioned = entities.some(
    (entity) => obj(entity)?.type === 'mention' && str(obj(obj(entity)?.mentioned)?.id)?.toLowerCase() === bot
  )
  return mentioned ? { kind: 'connect', target } : undefined
}

function textBlock(text: string, extra: Obj = {}): Obj {
  return { type: 'TextBlock', text, wrap: true, ...extra }
}

/** The welcome or Connect card; the Connect button carries the tenant the Console pins the sign-in to. */
export function msTeamsAnchorCard(answer: NonNullable<MsTeamsAnchorAnswer>, connectUrl: string): Obj {
  const connect = `${connectUrl}?tenant=${encodeURIComponent(answer.target.tenantId)}`
  const name = answer.kind === 'welcome' ? answer.addedBy?.name?.replace(/[<>]/g, '').trim() : undefined
  const mention = name ? `<at>${name}</at>` : undefined
  const body: Obj[] =
    answer.kind === 'welcome'
      ? [
          // No event tells the name the listing shows, and a store requires the two to match, so the greeting names no app.
          textBlock('Hi! I’m an AI agent powered by AgentConnect', { weight: 'Bolder', size: 'Medium' }),
          ...(mention ? [textBlock(`Thanks for adding me, ${mention}.`)] : []),
          textBlock('Give me a task and I work on it with the tools and access your organization connects.'),
          textBlock(
            'Before I can answer here, an AgentConnect organization connects this Microsoft 365 organization: anyone who can edit an agent in AgentConnect signs in, picks the agent, and confirms with a work account of this organization.'
          )
        ]
      : [
          textBlock(
            'This Microsoft 365 organization isn’t connected to AgentConnect yet, so I can’t answer here. Connect it to an AgentConnect organization to start.'
          )
        ]
  const card: Obj = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    msteams: {
      width: 'Full',
      ...(mention && name && answer.kind === 'welcome' && answer.addedBy
        ? { entities: [{ type: 'mention', text: mention, mentioned: { id: answer.addedBy.id, name } }] }
        : {})
    },
    body: [
      ...body,
      {
        type: 'ActionSet',
        actions: [
          { type: 'Action.OpenUrl', title: 'Connect AgentConnect', url: connect, style: 'positive' },
          { type: 'Action.OpenUrl', title: 'Guide', url: GUIDE_URL },
          { type: 'Action.OpenUrl', title: 'Contact us', url: `mailto:${SUPPORT_EMAIL}` }
        ]
      }
    ]
  }
  return card
}

/** The anchor's sender: a Bot Framework token from the app's home tenant, cached until shortly before it expires. */
export class MsTeamsAnchorEgress {
  private token?: { value: string; until: number }

  constructor(
    public anchor: RcMsTeamsAnchor,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** Take a new snapshot's anchor in place, so the ingest already built keeps sending; a changed credential drops the token. */
  update(anchor: RcMsTeamsAnchor): void {
    if (
      anchor.appId !== this.anchor.appId ||
      anchor.tenantId !== this.anchor.tenantId ||
      anchor.clientSecret !== this.anchor.clientSecret
    )
      this.token = undefined
    this.anchor = anchor
  }

  /** A conversation member's display name from the Bot Connector; undefined when the lookup tells none. */
  async memberName(target: AnchorTarget, user: string): Promise<string | undefined> {
    const base = new URL(target.serviceUrl.endsWith('/') ? target.serviceUrl : `${target.serviceUrl}/`)
    const path = `v3/conversations/${encodeURIComponent(target.conversationId)}/members/${encodeURIComponent(user)}`
    const response = await this.fetchImpl(new URL(path, base).toString(), {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) return undefined
    return str(obj(await response.json().catch(() => undefined))?.name)?.trim()
  }

  /** Post one card into the target conversation; rejects when Entra or the Bot Connector refuses. */
  async post(target: AnchorTarget, card: Obj): Promise<void> {
    const base = new URL(target.serviceUrl.endsWith('/') ? target.serviceUrl : `${target.serviceUrl}/`)
    const url = new URL(`v3/conversations/${encodeURIComponent(target.conversationId)}/activities`, base)
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }]
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`the Bot Connector answered ${response.status}`)
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(this.anchor.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.anchor.appId,
          client_secret: this.anchor.clientSecret,
          scope: TOKEN_SCOPE
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    )
    const body = obj(await response.json().catch(() => undefined))
    const value = str(body?.access_token)
    if (!response.ok || !value) throw new Error(`Entra answered ${response.status} without a token`)
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in * 1000 : 0
    this.token = { value, until: this.now() + Math.max(0, expiresIn - TOKEN_MARGIN_MS) }
    return value
  }
}

/** Answer one activity for the anchor; a failed post is logged, since Teams retries nothing a 200 answered. */
export async function answerMsTeamsAnchor(
  egress: MsTeamsAnchorEgress,
  activity: Obj,
  tenantId: string | undefined,
  log: Logger
): Promise<void> {
  let answer = msTeamsAnchorAnswer(activity, egress.anchor.appId, tenantId)
  if (!answer) return
  // A nameless installer is looked up so the welcome still mentions them; a failed lookup only drops the mention.
  if (answer.kind === 'welcome' && answer.addedBy && !answer.addedBy.name) {
    const name = await egress.memberName(answer.target, answer.addedBy.id).catch(() => undefined)
    if (name) answer = { ...answer, addedBy: { ...answer.addedBy, name } }
  }
  try {
    await egress.post(answer.target, msTeamsAnchorCard(answer, egress.anchor.connectUrl))
  } catch (err) {
    log.warn(`msteams anchor: ${answer.kind} card not posted: ${(err as Error).message}`)
  }
}
