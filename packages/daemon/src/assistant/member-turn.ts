// Whether a turn was started by members' own messages alone (email-integration.md §6.4): read from the messages the place rules judge, failing closed.
import type { ReadAsker } from './place-access.js'
import { askerOf, type TurnMessage } from './place-members.js'

export interface MemberTurnInput {
  /** The live turn's own message and every message folded into it; undefined when no turn is live. */
  messages: readonly TurnMessage[] | undefined
  /** The bot the turn's messages arrived on. */
  bot: string | undefined
  /** The turn works on a delegated task or an approved proposal, which no member's message started. */
  delegated: boolean
  /** The console user a person is while they are a member of the organization; undefined or a rejection reads as not one. */
  memberOf(asker: ReadAsker): Promise<string | undefined>
}

/** The console users behind a turn every message of which a member typed themselves, its own sender first; undefined for any other turn. */
export async function memberTurnConsoleUsers(input: MemberTurnInput): Promise<string[] | undefined> {
  if (input.delegated || !input.messages?.length) return undefined
  const users: string[] = []
  for (const message of input.messages) {
    // A schedule's recorded person, a hook, another agent or a report is no member's own message.
    if (message.person || message.msg.source !== 'user') return undefined
    const asker = askerOf(message, input.bot)
    if (!asker) return undefined
    const user = await input.memberOf(asker).catch(() => undefined)
    if (!user) return undefined
    if (!users.includes(user)) users.push(user)
  }
  return users
}
