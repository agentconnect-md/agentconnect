// Google Chat's per-bot relay ingest (google-chat-integration.md §4): a pure decoder holding the app's project number and identity.
import { GOOGLE_CHAT_PLATFORM, type IntegrationChannel } from '@agentconnect.md/protocol'
import type { GoogleChatEvent, GoogleChatEventForm, GoogleChatMembershipChange } from '@agentconnect.md/message'
import type { GoogleChatCertificateStore } from './token.js'

/** Hard cap on one delivery's raw body; interaction events are small JSON documents. */
export const GOOGLE_CHAT_BODY_LIMIT = 1024 * 1024

/** A `users/…` name no Google identity can take (Google's are numeric), so an unknown app strips nothing and matches nobody. */
export const UNKNOWN_APP_USER_NAME = 'users/unknown-app'

const USER_NAME = /^users\/[A-Za-z0-9._-]+$/

/** The plugin's typed verified product: the event, as a Chat API `Event`, whose bearer token proved Google sent it to this bot. */
export interface VerifiedGoogleChatDelivery {
  event: GoogleChatEvent
  /** The form the request came in, which is the form it is answered in (§11). */
  form: GoogleChatEventForm
  traceId: string
}

/** What the claim page decodes from `state` (design §10.5): unsigned, since the page re-derives every fact it acts on. */
export interface GoogleChatClaimState {
  v: 1
  /** The project number, the token audience. */
  app: string
  space: string
  /** The asking person's `users/…` name, on a prompt only they see; the welcome card, seen by the whole conversation, names nobody and the claimant is whoever signs in. */
  user?: string
  kind: 'dm' | 'space'
  /** The tenant key seen on the event. */
  tenant: string
  /** The event's `configCompleteRedirectUrl`, when it carried one. */
  redirect?: string
  /** Unix seconds. */
  iat: number
}

/** The claim page's address carrying `state` (design §10.5). */
export function googleChatClaimLink(claimUrl: string, state: GoogleChatClaimState): string {
  const url = new URL(claimUrl)
  url.searchParams.set('state', Buffer.from(JSON.stringify(state)).toString('base64url'))
  return url.toString()
}

/** What the relay answers an unclaimed tenant with (design §10.4), before a writer puts it in the request's form. */
export type GoogleChatAnswer = { kind: 'card'; cardsV2: unknown[] } | { kind: 'prompt'; url: string }

/** The name an add-on's authorization prompt shows for what the claim connects (§11). */
export const GOOGLE_CHAT_PROMPT_RESOURCE = 'AgentConnect'

/** The private prompt a message gets that sends its sender to the claim page (design §10.4). */
export function googleChatClaimPrompt(claimUrl: string, state: GoogleChatClaimState): GoogleChatAnswer {
  return { kind: 'prompt', url: googleChatClaimLink(claimUrl, state) }
}

/** The welcome card an unclaimed tenant sees on an add (design §10.7); its button opens the claim page, since Chat refuses a prompt for a card click. */
export function googleChatWelcomeCard(claimUrl: string, state: GoogleChatClaimState): GoogleChatAnswer {
  const text = 'Connect this Google Chat app to your AgentConnect organization to start.'
  const buttons = [{ text: 'Connect', onClick: { openLink: { url: googleChatClaimLink(claimUrl, state) } } }]
  const widgets = [{ textParagraph: { text } }, { buttonList: { buttons } }]
  return { kind: 'card', cardsV2: [{ cardId: 'agentconnect-claim', card: { sections: [{ widgets }] } }] }
}

/** An answer as a Chat app writes it: the card as the synchronous message, the prompt as `REQUEST_CONFIG`. */
export function chatAppAnswer(answer: GoogleChatAnswer): unknown {
  return answer.kind === 'card'
    ? { cardsV2: answer.cardsV2 }
    : { actionResponse: { type: 'REQUEST_CONFIG', url: answer.url } }
}

/** An answer as a Workspace add-on writes it (§11): the card as a create-message action, the prompt as the basic authorization prompt. */
export function addOnAnswer(answer: GoogleChatAnswer): unknown {
  return answer.kind === 'card'
    ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { cardsV2: answer.cardsV2 } } } } }
    : { basic_authorization_prompt: { authorization_url: answer.url, resource: GOOGLE_CHAT_PROMPT_RESOURCE } }
}

/** The body answering a request in the form it came in. */
export function googleChatAnswerBody(form: GoogleChatEventForm, answer: GoogleChatAnswer): unknown {
  return form === 'addon' ? addOnAnswer(answer) : chatAppAnswer(answer)
}

/** How a single-tenant row's fence answers one event's tenant key (design §10.3). */
export type OwnTenantVerdict = 'pass' | 'learned' | 'refused'

/** A bounded per-tenant once-a-window latch (LRU): a chatty unclaimed or refused tenant costs one log line a minute, never a different answer. */
export class UnclaimedTenantMemo {
  private readonly lastAt = new Map<string, number>()

  constructor(
    private readonly maxEntries = 512,
    private readonly windowMs = 60_000
  ) {}

  /** True when `key` was not seen within the window; the entry is refreshed as most recent either way. */
  first(key: string, now: number): boolean {
    const last = this.lastAt.get(key)
    const due = last === undefined || now - last >= this.windowMs
    this.lastAt.delete(key)
    this.lastAt.set(key, due ? now : (last as number))
    if (this.lastAt.size > this.maxEntries) this.lastAt.delete(this.lastAt.keys().next().value as string)
    return due
  }
}

/** The dedup identity the normalizer mints for a message-bearing event; undefined when the event carries no message. */
export function googleChatDedupId(event: GoogleChatEvent): string | undefined {
  const space = event.space?.name
  const message = event.message?.name
  return space && message ? `${GOOGLE_CHAT_PLATFORM}:${space}:${message}` : undefined
}

/** The relay's dedup key: the shared table is scoped by bot, since one Space message mentioning two apps reaches the relay once per app. */
export function googleChatDedupKey(botId: string, msgId: string | undefined): string | undefined {
  return msgId === undefined ? undefined : `${botId}\0${msgId}`
}

// Bot `users/…` names carried by USER_MENTION annotations of one mention type.
function mentionedBots(event: GoogleChatEvent, mentionType: string): string[] {
  const names = new Set<string>()
  for (const annotation of event.message?.annotations ?? []) {
    const mention = annotation.userMention
    if (annotation.type !== 'USER_MENTION' || mention?.type !== mentionType || mention.user?.type !== 'BOT') continue
    const name = mention.user.name
    if (name && USER_NAME.test(name)) names.add(name)
  }
  return [...names]
}

/** The receiving app's own name when Google's data proves it: the one app an add event adds, or the one app a Space message mentions. */
export function provenAppUserName(event: GoogleChatEvent): string | undefined {
  if (event.type === 'ADDED_TO_SPACE') {
    const added = mentionedBots(event, 'ADD')
    return added.length === 1 ? added[0] : undefined
  }
  // Google delivers a Space message only to the apps it mentions, so a lone mentioned app is this one.
  if (event.type === 'MESSAGE' && event.space?.spaceType === 'SPACE') {
    const mentioned = mentionedBots(event, 'MENTION')
    return mentioned.length === 1 ? mentioned[0] : undefined
  }
  return undefined
}

export class GoogleChatHttpIngest {
  private learnedAppUserName: string | undefined
  private readonly observed = new Map<string, IntegrationChannel>()
  private warnedUnknownIdentity = false
  /** A single-tenant row's own customer and domains (§10.3): seeded from the assignment, grown by its traffic. */
  private ownCustomer: string | undefined
  private readonly ownDomains = new Set<string>()

  constructor(
    readonly botId: string,
    /** The Cloud project number: a Chat app token's audience, and the number in an add-on token's service account (§11). */
    readonly projectNumber: string,
    private readonly assignedAppUserName: string | undefined,
    /** Shared across the platform's ingests; the keys are Google's, not the bot's. */
    readonly certificates: GoogleChatCertificateStore,
    /** The relay's public events URL, read per request: an add-on token's audience (§11); absent until the CP's snapshot names it. */
    readonly eventsUrl: () => string | undefined,
    /** The generation THIS ingest was built from. */
    readonly credentialRevision?: number,
    /** The tenant keys this row is known by: a customer row of a multi-tenant app (design §10.3), else absent. */
    readonly tenantIds?: readonly string[],
    /** The console's claim page, present only on the deployment app's anchor, which routes nothing itself (§10.4). */
    readonly claimUrl?: string,
    /** A single-tenant row's recorded keys (§10.3), the fence's memory across relay restarts. */
    ownTenantIds?: readonly string[]
  ) {
    for (const key of ownTenantIds ?? []) this.admitTenant(key)
  }

  /** A row with neither customer keys nor the claim page: one organization's own app, fenced by what its traffic proves. */
  get singleTenant(): boolean {
    return this.tenantIds === undefined && this.claimUrl === undefined
  }

  /** The own-tenant fence: one customer, learned from the first Space; any DM domain, recorded; anything else refused. */
  admitTenant(key: string): OwnTenantVerdict {
    if (key.startsWith('customers/')) {
      if (this.ownCustomer === undefined) {
        this.ownCustomer = key
        return 'learned'
      }
      return this.ownCustomer === key ? 'pass' : 'refused'
    }
    // Google shows an unlisted app only to its own organization, so a DM's domain is that organization's (§10.3).
    if (key.startsWith('domains/')) {
      if (this.ownDomains.has(key)) return 'pass'
      this.ownDomains.add(key)
      return 'learned'
    }
    return 'refused'
  }

  /** §8 RelayBotIngress: a pure decoder has nothing to release. */
  stop(): void {}

  /** The app's `users/…` name: the assignment's, else the one learned from Google's own annotations. */
  get appUserName(): string | undefined {
    return this.assignedAppUserName ?? this.learnedAppUserName
  }

  /** Remember an identity Google's data proved; true when this ingest did not know it before. */
  learn(appUserName: string): boolean {
    if (this.appUserName !== undefined) return false
    this.learnedAppUserName = appUserName
    return true
  }

  /** Apply one membership observation and return the snapshot of every Space this ingest has seen the app in. */
  observeMembership(change: GoogleChatMembershipChange, displayName: string | undefined): IntegrationChannel[] {
    if (change.change === 'removed') this.observed.delete(change.channel)
    else
      this.observed.set(change.channel, {
        id: change.channel,
        ...(displayName ? { name: displayName } : {}),
        kind: change.isDm ? 'im' : 'channel'
      })
    return [...this.observed.values()]
  }

  /** True once per ingest: the first message forwarded before the app's identity was known. */
  firstUnknownIdentity(): boolean {
    if (this.warnedUnknownIdentity) return false
    this.warnedUnknownIdentity = true
    return true
  }
}
