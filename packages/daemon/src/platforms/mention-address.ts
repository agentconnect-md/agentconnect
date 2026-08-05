/**
 * The **compound mention-address strategy** (§7.4 strategy table, stage S3).
 *
 * WHAT IT PROTECTS. The reply splitter must never cut an address in half
 * (send-message-routing-rework.md §5.3/§8.5). It protects every self-delimiting
 * token on its own, but it cannot know that a bare word FOLLOWING a mention
 * belongs to the address — in any other message that word is ordinary prose. So
 * core asks the platform which COMPOUND addresses this conversation can contain.
 *
 * Only Slack has any today: a shared bot's `<@U_SHARED> reviewer`, where the bot
 * user id names the app and the trailing slug selects the agent, so the two
 * halves are one address though only the first is self-delimiting. A dedicated
 * bot's `<@U…>` is already indivisible and is deliberately NOT reported — over-
 * protecting a boundary that is not really an address would make the splitter
 * refuse to split.
 *
 * The default is therefore "no compound addresses", which is exactly the
 * behavior every non-Slack platform already had (the branch this replaces read
 * `if (msg.platform !== 'slack') return []`). Unknown ids get it too: guessing an
 * address shape for a platform this build does not know is the fail-OPEN
 * direction.
 */
import { slackMentionAddress, type AgentMentionIdentity } from '@agentconnect.md/message'

/** Given the conversation's mention directory, the addresses in it that the
 *  splitter must not cut. */
export type CompoundMentionAddressReader = (directory: readonly AgentMentionIdentity[]) => string[]

const READERS = new Map<string, CompoundMentionAddressReader>([
  [
    'slack',
    (directory) =>
      directory
        // Shared-bot entries only: those are the ones whose address carries a
        // trailing slug and is therefore splittable.
        .filter((entry) => entry.botShared)
        .map((entry) => slackMentionAddress(entry))
        .filter((address): address is string => address !== undefined)
  ]
])

/**
 * The platform's compound-address reader, or `undefined` when it has none — the
 * caller then skips the directory lookup entirely and reports no protected
 * addresses, every non-Slack platform's behavior.
 */
export function compoundMentionAddressesFor(platform: string): CompoundMentionAddressReader | undefined {
  return READERS.get(platform)
}
