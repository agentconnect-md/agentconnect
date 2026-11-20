// Where a mail belongs (email-integration.md §5.1, §5.2): a started thread its tag names, else its thread from the messages the daemon knows, its conversation from the message itself, and the participant fence between the two.
import { EMAIL_STARTED_TAG_PATTERN, type WireEmailAdapterExt } from '@agentconnect.md/protocol'
import {
  emailConversation,
  emailFallbackThreadKey,
  emailParticipants,
  emailThreadCandidates,
  type EmailConversation
} from '@agentconnect.md/message'

/** A message the daemon received or sent, as the index keeps it. */
export interface EmailKnownMessage {
  thread: string
  conversation: string
}

/** A group conversation as the fence reads it: who opened it, and the participants of its latest admitted message. */
export interface EmailConversationState {
  opener: string
  members: readonly string[]
}

/** A thread the agent started (§6.4): its conversation, whom the started mail went to, its current members (those recipients until a reply is admitted), and whom its session was classified for. */
export interface EmailStartedThread {
  thread: string
  conversation: string
  recipients: readonly string[]
  members: readonly string[]
  owner?: string
}

/** The reads placement makes of the mail index, all within one agent's address. */
export interface EmailPlacementIndex {
  message(messageId: string): Promise<EmailKnownMessage | undefined>
  /** Undefined for a conversation no admitted message has opened. */
  conversation(channel: string): Promise<EmailConversationState | undefined>
  /** The started thread a tag names; undefined for a tag the daemon never minted. */
  startedThread?(tag: string): Promise<EmailStartedThread | undefined>
}

export interface EmailPlacement {
  thread: string
  conversation: EmailConversation
  /** The message was admitted before, so this is a redelivery placed where it already is. */
  redelivered: boolean
  /** The message answers a mail the agent started: in its thread, or in the own thread of a recipient who left others off (§5.2). */
  started?: { tag: string; recipients: readonly string[]; own: boolean; owner?: string }
}

/** Whether a thread key is a started thread's tag, which no `Message-ID` can be. */
export function isEmailStartedThread(thread: string): boolean {
  return EMAIL_STARTED_TAG_PATTERN.test(thread)
}

/** The thread one recipient's replies to a started mail are kept in when they answer the agent alone (§5.2); `>` never occurs in a `Message-ID`, so no mail can name it as its own. */
export function emailStartedReplyThread(tag: string, recipient: string): string {
  return `${tag}>${recipient}`
}

/** The started tag a thread key belongs to: the started thread itself, or one recipient's own thread of it. */
export function emailStartedTagOf(thread: string): string | undefined {
  const tag = thread.split('>', 1)[0]!
  return isEmailStartedThread(tag) && (tag === thread || thread.length > tag.length + 1) ? tag : undefined
}

/** A conversation read back from its channel: `dm:<address>` is a member's own, anything else a group. */
export function emailConversationOf(channel: string): EmailConversation {
  return { kind: channel.startsWith('dm:') ? 'dm' : 'group', channel }
}

/** Place one mail: the thread of the nearest known message whose conversation it may continue, else the header-only key, else a thread of its own. */
export async function placeEmail(
  mail: WireEmailAdapterExt,
  agentAddress: string,
  index: EmailPlacementIndex
): Promise<EmailPlacement> {
  const own = await index.message(mail.messageId)
  if (own) return { thread: own.thread, conversation: emailConversationOf(own.conversation), redelivered: true }
  const sender = mail.from.address
  const participants = emailParticipants(mail, agentAddress)
  const ownThread = (): EmailPlacement => ({
    thread: mail.messageId,
    conversation: emailConversation(mail, agentAddress, mail.messageId),
    redelivered: false
  })
  const startedOf = (tag: string, started: EmailStartedThread, own: boolean): EmailPlacement['started'] => ({
    tag,
    recipients: started.recipients,
    own,
    ...(started.owner !== undefined ? { owner: started.owner } : {})
  })
  // A started thread drops the opener check and takes only a message every current member is on (§5.2).
  const intoStarted = async (tag: string): Promise<EmailPlacement | undefined> => {
    const started = await index.startedThread?.(tag)
    if (!started) return undefined
    if (started.members.includes(sender) && started.members.every((member) => participants.includes(member)))
      return {
        thread: started.thread,
        conversation: emailConversationOf(started.conversation),
        redelivered: false,
        started: startedOf(tag, started, false)
      }
    // A recipient leaving others off answers in a thread of their own, so nobody reads what was not written to them.
    if (!started.recipients.includes(sender)) return ownThread()
    const thread = emailStartedReplyThread(tag, sender)
    return {
      thread,
      conversation: emailConversation(mail, agentAddress, thread),
      redelivered: false,
      started: startedOf(tag, started, true)
    }
  }
  // A recipient's own thread is continued as any thread is, keeping what admission and ownership read of its started mail.
  const ownOf = async (tag: string | undefined): Promise<Pick<EmailPlacement, 'started'>> => {
    const started = tag ? await index.startedThread?.(tag) : undefined
    return tag && started ? { started: startedOf(tag, started, true) } : {}
  }
  // A tag the daemon minted names its thread first, whatever the headers say (§5.1).
  if (mail.tag) {
    const tagged = await intoStarted(mail.tag)
    if (tagged) return tagged
  }
  // A direct conversation needs no fence: its key is the authenticated sender.
  const continues = async (conversation: EmailConversation, from?: EmailKnownMessage): Promise<boolean> => {
    if (conversation.kind === 'dm') return true
    const state = await index.conversation(conversation.channel)
    if (state) return state.members.includes(sender) && participants.includes(state.opener)
    // A group not opened yet: a member's own thread opens it, and so does a thread no known message is on.
    return from === undefined || from.conversation === `dm:${sender}`
  }
  let known = false
  for (const id of emailThreadCandidates(mail)) {
    const hit = await index.message(id)
    if (!hit) continue
    known = true
    // A reply that names the started mail or its thread is placed as its tag would place it.
    const tag = emailStartedTagOf(hit.thread)
    if (tag === hit.thread) {
      const started = await intoStarted(tag)
      if (started) return started
    }
    const conversation = emailConversation(mail, agentAddress, hit.thread)
    if (await continues(conversation, hit))
      return { thread: hit.thread, conversation, redelivered: false, ...(await ownOf(tag)) }
  }
  if (!known) {
    const thread = emailFallbackThreadKey(mail)
    const conversation = emailConversation(mail, agentAddress, thread)
    if (await continues(conversation)) return { thread, conversation, redelivered: false }
  }
  // Fenced off every thread it names: it starts one of its own, which its replies then reach first.
  return ownThread()
}
