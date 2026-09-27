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
    readonly credentialRevision?: number
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
