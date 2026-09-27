// Google Chat's per-bot relay ingest (google-chat-integration.md §4): a pure decoder holding the expected audience and the app's identity.
import { GOOGLE_CHAT_PLATFORM, type IntegrationChannel } from '@agentconnect.md/protocol'
import type { GoogleChatEvent, GoogleChatMembershipChange } from '@agentconnect.md/message'
import type { GoogleChatCertificateStore } from './token.js'

/** Hard cap on one delivery's raw body; interaction events are small JSON documents. */
export const GOOGLE_CHAT_BODY_LIMIT = 1024 * 1024

/** A `users/…` name no Google identity can take (Google's are numeric), so an unknown app strips nothing and matches nobody. */
export const UNKNOWN_APP_USER_NAME = 'users/unknown-app'

const USER_NAME = /^users\/[A-Za-z0-9._-]+$/

/** The plugin's typed verified product: the event whose bearer token proved Google sent it to this bot. */
export interface VerifiedGoogleChatDelivery {
  event: GoogleChatEvent
  traceId: string
}

/** The function the welcome card's button invokes; its `CARD_CLICKED` is answered with the claim prompt (design §10.7). */
export const GOOGLE_CHAT_CLAIM_FUNCTION = 'agentconnect.claim'

/** The one card the relay posts: the welcome message an unclaimed tenant sees on `ADDED_TO_SPACE` (design §10.7). */
export const GOOGLE_CHAT_WELCOME_CARD = {
  cardsV2: [
    {
      cardId: 'agentconnect-claim',
      card: {
        sections: [
          {
            widgets: [
              { textParagraph: { text: 'Connect this Google Chat app to your AgentConnect organization to start.' } },
              {
                buttonList: {
                  buttons: [{ text: 'Connect', onClick: { action: { function: GOOGLE_CHAT_CLAIM_FUNCTION } } }]
                }
              }
            ]
          }
        ]
      }
    }
  ]
} as const

/** What the claim page decodes from `state` (design §10.5): unsigned, since the page re-derives every fact it acts on. */
export interface GoogleChatClaimState {
  v: 1
  /** The project number, the token audience. */
  app: string
  space: string
  /** The initiating person's `users/…` name; the page accepts the claim only from that Google account. */
  user: string
  kind: 'dm' | 'space'
  /** The tenant key seen on the event. */
  tenant: string
  /** The event's `configCompleteRedirectUrl`, when it carried one. */
  redirect?: string
  /** Unix seconds. */
  iat: number
}

/** The private `REQUEST_CONFIG` answer that sends the initiating person to the claim page with `state` (design §10.4). */
export function googleChatClaimPrompt(
  claimUrl: string,
  state: GoogleChatClaimState
): { actionResponse: { type: 'REQUEST_CONFIG'; url: string } } {
  const url = new URL(claimUrl)
  url.searchParams.set('state', Buffer.from(JSON.stringify(state)).toString('base64url'))
  return { actionResponse: { type: 'REQUEST_CONFIG', url: url.toString() } }
}

/** A bounded per-tenant once-a-window latch (LRU): a chatty unclaimed domain costs one log line a minute, never a different answer. */
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

  constructor(
    readonly botId: string,
    /** The Cloud project number: the audience every token must carry. */
    readonly audience: string,
    private readonly assignedAppUserName: string | undefined,
    /** Shared across the platform's ingests; the certificates are Google's, not the bot's. */
    readonly certificates: GoogleChatCertificateStore,
    /** The generation THIS ingest was built from. */
    readonly credentialRevision?: number,
    /** The tenant keys this row is known by: a customer row of a multi-tenant app (design §10.3), else absent. */
    readonly tenantIds?: readonly string[],
    /** The console's claim page, present only on a multi-tenant app's anchor, which routes nothing itself (§10.4). */
    readonly claimUrl?: string
  ) {}

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
