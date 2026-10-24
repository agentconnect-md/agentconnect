// Google Chat's plain-text answers the relay posts itself (google-chat-integration.md §11.4): the welcome on an add and the `/help` reply.
import { COMMAND_HELP } from '@agentconnect.md/activation-policy'
import { GOOGLE_CHAT_HELP_COMMAND } from '@agentconnect.md/message'
import { googleChatCreatedMessage } from './http-ingest.js'

const INTRO = 'I’m an AI agent powered by AgentConnect.'
const UNCLAIMED =
  'Before I can answer, your organization needs to connect this app: send me a message and follow the prompt.'

/** The `/help` reply's text; an unclaimed tenant is first told to connect the app. */
export function googleChatHelpText(opts: { unclaimed?: boolean } = {}): string {
  const commands = Object.values(COMMAND_HELP).map(({ usage, does }) => `${usage} — ${does}`)
  return [
    INTRO,
    ...(opts.unclaimed ? [UNCLAIMED] : []),
    'Send me a direct message, or @mention me in a space and I’ll answer in that thread.',
    '',
    'Commands (send one as a message; in a space, @mention me with it):',
    ...commands,
    `${GOOGLE_CHAT_HELP_COMMAND} — show this help`
  ].join('\n')
}

/** The welcome text a claimed or own app posts when it is added to a DM or a space (design §10.7). */
export function googleChatWelcomeText(isDm: boolean): string {
  const use = isDm
    ? 'Send me a message here to get started, or @mention me in a space and I’ll answer in that thread.'
    : '@mention me in this space and I’ll answer in that thread, or send me a direct message.'
  return `Hi! ${INTRO} ${use} Type ${GOOGLE_CHAT_HELP_COMMAND} to see the commands.`
}

/** The `/help` answer as a created message. */
export function googleChatHelp(opts: { unclaimed?: boolean } = {}): unknown {
  return googleChatCreatedMessage({ text: googleChatHelpText(opts) })
}

/** The welcome as a created message. */
export function googleChatWelcome(isDm: boolean): unknown {
  return googleChatCreatedMessage({ text: googleChatWelcomeText(isDm) })
}
