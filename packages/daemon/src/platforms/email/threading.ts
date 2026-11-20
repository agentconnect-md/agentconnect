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

/** A thread the agent started (§6.4): its conversation, whom the started mail went to, and its current members, those recipients until a reply is admitted. */
export interface EmailStartedThread {
  thread: string
  conversation: string
  recipients: readonly string[]
  members: readonly string[]
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
  /** The message continues a thread the agent started, sent to these recipients. */
  started?: { recipients: readonly string[] }
}

/** Whether a thread key is a started thread's tag, which no `Message-ID` can be. */
export function isEmailStartedThread(thread: string): boolean {
  return EMAIL_STARTED_TAG_PATTERN.test(thread)
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
  // A started thread keeps the sender check and drops the opener check; a sender not on it starts a thread of its own (§5.2).
  const ownThread = (): EmailPlacement => ({
    thread: mail.messageId,
    conversation: emailConversation(mail, agentAddress, mail.messageId),
    redelivered: false
  })
  const intoStarted = async (tag: string): Promise<EmailPlacement | undefined> => {
    const started = await index.startedThread?.(tag)
    if (!started) return undefined
    if (!started.members.includes(sender)) return ownThread()
    return {
      thread: started.thread,
      conversation: emailConversationOf(started.conversation),
      redelivered: false,
      started: { recipients: started.recipients }
    }
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
    // A reply that names the started mail itself is placed as its tag would place it.
    if (isEmailStartedThread(hit.thread)) {
      const started = await intoStarted(hit.thread)
      if (started) return started
    }
    const conversation = emailConversation(mail, agentAddress, hit.thread)
    if (await continues(conversation, hit)) return { thread: hit.thread, conversation, redelivered: false }
  }
  if (!known) {
    const thread = emailFallbackThreadKey(mail)
    const conversation = emailConversation(mail, agentAddress, thread)
    if (await continues(conversation)) return { thread, conversation, redelivered: false }
  }
  // Fenced off every thread it names: it starts one of its own, which its replies then reach first.
  return ownThread()
}
