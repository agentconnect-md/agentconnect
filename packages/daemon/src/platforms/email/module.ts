// Email's daemon platform module (email-integration.md §4, §5, §8): mail arrives pre-addressed from the relay, is placed by the messages the daemon knows, and is admitted from members, or from anyone where the address says so.
import {
  EMAIL_PLATFORM,
  EMAIL_V1_FEATURE,
  WireEmailAdapterExt,
  type PlaceExternalReason,
  type RdMsgIm,
  type WireEmailAdapterExt as EmailExt
} from '@agentconnect.md/protocol'
import { emailParticipants, renderEmailHeaderBlock } from '@agentconnect.md/message'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { EmailMessages } from '../../store/email-messages.js'
import type { DaemonPlatformModule, RelayIngressStrategy } from '../contract.js'
import type { EmailConnection, EmailStoredMail } from './connection.js'
import { isAdmittedOutsider, isOutsider, type EmailMemberVerdict, type EmailMembers } from './members.js'
import { placeEmail } from './threading.js'

export interface EmailModuleHost {
  /** The integration's live connection, once the reconciler has bound it. */
  connection(integrationId: string): EmailConnection | undefined
  members: EmailMembers
  /** A conversation the member answer shows someone outside the organization on, reported as every platform reports one (§5.2). */
  placeExternal(integrationIds: readonly string[], channel: string, reason: PlaceExternalReason): void
  /** Who may write to the integration's address, as its spec says; absent reads as Members (§4.1). */
  whoMayWrite(integrationId: string): 'members' | 'anyone'
  store(): { emailMessages: EmailMessages }
  now(): number
  warn(message: string): void
}

/** A mail's header fields from the message bag, read defensively because the bag is persisted. */
export function emailExtOf(msg: Pick<NormalizedMessage, 'platform' | 'adapterExt'>): EmailExt | undefined {
  if (msg.platform !== EMAIL_PLATFORM) return undefined
  const parsed = WireEmailAdapterExt.safeParse(msg.adapterExt?.[EMAIL_PLATFORM])
  return parsed.success ? parsed.data : undefined
}

/** The transcript key of a received mail's row: the native last segment of its `msgId`, as core records it. */
export function emailTranscriptTs(msg: Pick<NormalizedMessage, 'msgId' | 'transcriptTs'>): string {
  return msg.transcriptTs ?? msg.msgId.split(':').at(-1) ?? msg.msgId
}

/** The receipt outliving the dispatch row: the agent address and the `Message-ID`, the relay's own dedup identity (§5.5). */
export function emailDeliveryReceiptId(normalized: NormalizedMessage): string {
  const ext = emailExtOf(normalized)
  return ['email-served', normalized.msgId, ext?.messageId ?? ''].join('\u001f')
}

/** Who a reply's Cc may hold (§6.1): a member, or someone outside who has written on the thread themselves, under Anyone or in a started thread, where one the started mail went to may be copied too. */
export function emailCopyable(
  verdict: EmailMemberVerdict | undefined,
  address: string,
  wrote: ReadonlySet<string>,
  started?: ReadonlySet<string>
): boolean {
  if (verdict?.allowed) return true
  if (started) return isOutsider(verdict) && (wrote.has(address) || started.has(address))
  return isAdmittedOutsider(verdict) && wrote.has(address)
}

/** Whether a reply might copy this address as someone outside the organization, so the thread's senders must be read. */
export function emailMayCopyOutsider(verdict: EmailMemberVerdict | undefined, started: boolean): boolean {
  return started ? isOutsider(verdict) : isAdmittedOutsider(verdict)
}

/** What the agent reads (§5.4): the header block, the body as the relay cut it, the attachment notes, and who will not receive the reply. */
export function emailPrompt(
  body: string,
  ext: EmailExt,
  leftOff: readonly string[],
  outsidersCopied = false,
  started = false
): string {
  const copied = started
    ? 'people outside it who have written on this thread themselves or were sent the mail you started'
    : 'people outside it who have written on this thread themselves'
  const notes = [
    ...(ext.unreadableRecipients
      ? [
          `[${ext.unreadableRecipients} recipient${ext.unreadableRecipients === 1 ? '' : 's'} of this mail could not be read as an address and will not receive your reply.]`
        ]
      : []),
    ...(leftOff.length
      ? [
          outsidersCopied
            ? `[Your reply will not be sent to: ${leftOff.join(', ')}. It goes to members of this organization and to ${copied}. Say so in your reply if it matters.]`
            : `[Not members of this organization, so your reply will not be sent to them: ${leftOff.join(', ')}. Say so in your reply if it matters.]`
        ]
      : [])
  ]
  return [renderEmailHeaderBlock(ext), body.trim(), ...notes].filter(Boolean).join('\n\n')
}

/** The relay-ingress strategy: placement and the member question before the record, the index row inside the admission fence. */
export function emailRelayIngress(host: EmailModuleHost): RelayIngressStrategy {
  return {
    admit: async (msg: RdMsgIm, normalized: NormalizedMessage) => {
      const ext = emailExtOf(normalized)
      if (!ext) return 'rejected'
      const conn = host.connection(msg.integrationId)
      // Not bound yet: the reconciler is converging, so the sender's server tries again.
      if (!conn) return 'retry'
      const participants = emailParticipants(ext, conn.address)
      const verdicts = await host.members.judge(msg.agentId, participants)
      // §4 step 3: unanswered admits nobody and is retried, never read as an outside sender; a refusal never says why.
      if (!verdicts) return 'retry'
      const sender = verdicts.get(ext.from.address)
      // Under Anyone the spec and the answer must agree, so a setting turned back to Members closes at once (§4.1).
      const anyone = isAdmittedOutsider(sender) && host.whoMayWrite(msg.integrationId) === 'anyone'
      // Anyone else outside may answer only a started thread it was sent, which placement says (§4 step 3, §6.4).
      const answering = !sender?.allowed && !anyone && ext.tag !== undefined && isOutsider(sender)
      if (!sender?.allowed && !anyone && !answering) return 'rejected'
      let placement
      try {
        placement = await placeEmail(ext, conn.address, conn)
      } catch (err) {
        host.warn(`email: placing a mail failed (${(err as Error).message}); it is retried`)
        return 'retry'
      }
      // One the fence splits off is refused with step 3's reason, so no session exists to own (§5.3).
      if (answering && !placement.started?.recipients.includes(ext.from.address)) return 'rejected'
      const outsider = anyone || answering
      const started = placement.started ? new Set(placement.started.recipients) : undefined
      const group = placement.conversation.kind === 'group'
      normalized.channel = placement.conversation.channel
      normalized.thread = placement.thread
      normalized.isDm = !group
      if (group) normalized.isGroupDm = true
      else delete normalized.isGroupDm
      normalized.mentionedBots = group ? [conn.address] : []
      // The started mail is the thread's own root, so a session that never ran reads it once (§6.4).
      if (started) normalized.threadRootIsOwn = true
      // The daemon's own mark of how the sender was admitted, which the reply and the index read; never the relay's.
      const marked: EmailExt = { ...ext }
      if (outsider) marked.outsider = true
      else delete marked.outsider
      normalized.adapterExt = { ...normalized.adapterExt, [EMAIL_PLATFORM]: marked }
      // A conversation someone outside the organization is on is external, read before the turn it starts (§5.2).
      if (participants.some((address) => isOutsider(verdicts.get(address))))
        host.placeExternal([msg.integrationId], placement.conversation.channel, 'externalMember')
      const outsidersCopied = participants.some((address) => emailMayCopyOutsider(verdicts.get(address), !!started))
      let leftOff: string[] = []
      if (group) {
        // Only an outsider the reply might copy needs the thread's senders read.
        const wrote = outsidersCopied
          ? await conn.threadSenders(placement.conversation.channel, placement.thread).catch(() => undefined)
          : new Set<string>()
        if (!wrote) return 'retry'
        leftOff = participants
          .slice(1)
          .filter((address) => !emailCopyable(verdicts.get(address), address, wrote, started))
      }
      normalized.text = emailPrompt(normalized.text, marked, leftOff, outsidersCopied, !!started)
      return 'admit'
    },
    // Mail has no commands and no acknowledgement, so an admitted message goes straight to dispatch.
    prepare: async (_msg, _normalized, trace) => {
      trace.stage = 'email:dispatch'
      return 'dispatch'
    },
    // The index row is written with the admission, so the fence and a reply read only admitted mail.
    onAdmitted: async (msg, normalized) => {
      const ext = emailExtOf(normalized)
      const conn = host.connection(msg.integrationId)
      if (!ext || !conn) throw new Error('email: the admitted mail has no connection to be indexed under')
      const stored: EmailStoredMail = { ...ext, participants: emailParticipants(ext, conn.address) }
      await host.store().emailMessages.record({
        address: conn.address,
        messageId: ext.messageId,
        thread: normalized.thread ?? ext.messageId,
        conversation: normalized.channel,
        direction: 'received',
        mail: JSON.stringify(stored),
        ts: emailTranscriptTs(normalized),
        createdAt: host.now()
      })
    },
    // The relay settles a redelivery from the admission, so the ack waits for the durable row (§5.5).
    requireDurable: true,
    receiptId: emailDeliveryReceiptId
  }
}

/** Email's daemon platform module, bound to one daemon's host. */
export function emailPlatformModule(host: EmailModuleHost): DaemonPlatformModule {
  return {
    platformId: EMAIL_PLATFORM,
    relayIngress: emailRelayIngress(host),
    // The address is the member's identity, matched only against a verified sign-in email (§4 step 3).
    consoleUserOf: async (agentId, memberId) => await host.members.consoleUser(agentId, memberId),
    // The Control Plane sends an Email integration only to a daemon listing this (§8).
    registrationFeatures: [EMAIL_V1_FEATURE]
  }
}
