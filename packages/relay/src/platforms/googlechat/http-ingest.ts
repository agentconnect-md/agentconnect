// Google Chat's per-bot relay ingest (google-chat-integration.md §4): a pure decoder holding the app's project number and identity.
import { GOOGLE_CHAT_PLATFORM, type IntegrationChannel } from '@agentconnect.md/protocol'
import {
  googleChatPayloadOf,
  type GoogleChatEventObject,
  type GoogleChatMembershipChange
} from '@agentconnect.md/message'
import type { GoogleChatTokenVerifier } from './token.js'

/** Hard cap on one delivery's raw body; add-on event objects are small JSON documents. */
export const GOOGLE_CHAT_BODY_LIMIT = 1024 * 1024

/** A `users/…` name no Google identity can take (Google's are numeric), so an unknown app strips nothing and matches nobody. */
export const UNKNOWN_APP_USER_NAME = 'users/unknown-app'

const USER_NAME = /^users\/[A-Za-z0-9._-]+$/

/** The plugin's typed verified product: the add-on's `EventObject`, whose bearer token proved Google sent it to this bot. */
export interface VerifiedGoogleChatDelivery {
  event: GoogleChatEventObject
  traceId: string
}

/** What the claim page decodes from `state` (design §10.5): unsigned, since the page re-derives every fact it acts on. */
export interface GoogleChatClaimState {
  v: 1
  /** The app's project number. */
  app: string
  space: string
  /** The asking person's `users/…` name, on a prompt only they see; the welcome card, seen by the whole conversation, names nobody and the claimant is whoever signs in. */
  user?: string
  kind: 'dm' | 'space'
  /** The tenant key seen on the event. */
  tenant: string
  /** The payload's `configCompleteRedirectUri`, when it carried one. */
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

/** The name the authorization prompt shows for what the claim connects (§11.4). */
export const GOOGLE_CHAT_PROMPT_RESOURCE = 'AgentConnect'

/** The private authorization prompt a message gets that sends its sender to the claim page (design §10.4, §11.4). */
export function googleChatClaimPrompt(claimUrl: string, state: GoogleChatClaimState): unknown {
  const url = googleChatClaimLink(claimUrl, state)
  return { basic_authorization_prompt: { authorization_url: url, resource: GOOGLE_CHAT_PROMPT_RESOURCE } }
}

/** A synchronous answer that posts `message` in the conversation: the add-on's `createMessageAction` envelope (§11.4). */
export function googleChatCreatedMessage(message: Record<string, unknown>): unknown {
  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message } } } }
}

/** The welcome card an unclaimed tenant sees on an add (design §10.7), as a created message; its button opens the claim page, since Chat refuses a prompt for a click. */
export function googleChatWelcomeCard(claimUrl: string, state: GoogleChatClaimState): unknown {
  const text = 'Connect this Google Chat app to your AgentConnect organization to start.'
  const buttons = [{ text: 'Connect', onClick: { openLink: { url: googleChatClaimLink(claimUrl, state) } } }]
  const widgets = [{ textParagraph: { text } }, { buttonList: { buttons } }]
  return googleChatCreatedMessage({ cardsV2: [{ cardId: 'agentconnect-claim', card: { sections: [{ widgets }] } }] })
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
export function googleChatDedupId(event: unknown): string | undefined {
  const found = googleChatPayloadOf(event)
  const space = found?.space?.name
  const message = found?.payload.message?.name
  return typeof space === 'string' && space && typeof message === 'string' && message
    ? `${GOOGLE_CHAT_PLATFORM}:${space}:${message}`
    : undefined
}

/** The relay's dedup key: the shared table is scoped by bot, since one Space message mentioning two apps reaches the relay once per app. */
export function googleChatDedupKey(botId: string, msgId: string | undefined): string | undefined {
  return msgId === undefined ? undefined : `${botId}\0${msgId}`
}

/** The receiving app's own name when Google's data proves it: the one app a Space message mentions or adds. */
export function provenAppUserName(event: unknown): string | undefined {
  const found = googleChatPayloadOf(event)
  if (found?.key !== 'messagePayload' || found.space?.spaceType !== 'SPACE') return undefined
  // Google delivers a Space message only to the apps it mentions or adds, so a lone such app is this one.
  const names = new Set<string>()
  const annotations = found.payload.message?.annotations
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    const mention = annotation?.userMention
    if (annotation?.type !== 'USER_MENTION' || mention?.user?.type !== 'BOT') continue
    if (mention.type !== 'MENTION' && mention.type !== 'ADD') continue
    const name = mention.user.name
    if (typeof name === 'string' && USER_NAME.test(name)) names.add(name)
  }
  return names.size === 1 ? [...names][0] : undefined
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
    /** The Cloud project number, the number in the add-on service account that signs its requests (§11.2). */
    readonly projectNumber: string,
    private readonly assignedAppUserName: string | undefined,
    /** Shared across the platform's ingests; the keys are Google's, not the bot's. */
    readonly verifier: GoogleChatTokenVerifier,
    /** The relay's public events URL, read per request: the token audience (§11.2); absent until the CP's snapshot names it. */
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
