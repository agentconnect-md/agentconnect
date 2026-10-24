// Core's first-run welcome for a bot added to a conversation (§7.4 `botAdds`): what it does, how to use it here, whether it is enabled here, and where to go next.
import type { Welcome } from './contract.js'

/** The public guide a welcome and a help reply point to. */
export const CHAT_PLATFORMS_GUIDE_URL = 'https://www.agentconnect.md/docs/connect-automate/chat-platforms'
/** Where a person without console access reaches us. */
export const SUPPORT_EMAIL = 'contact@agentconnect.md'

/** The welcome for one install; `name` is what the platform shows the bot as, so the greeting matches the app's listed name. */
export function buildWelcome(opts: { name: string; isDm: boolean; enabled: boolean; consoleUrl: string }): Welcome {
  const where = opts.isDm ? 'chat' : 'conversation'
  return {
    title: `Hi, I’m ${opts.name}`,
    lines: [
      'I’m an AI agent powered by AgentConnect. Give me a task and I work on it with the tools and access your organization connected.',
      opts.isDm
        ? 'Send me a task here. In a channel or group chat I’m in, @mention me and I answer in that thread.'
        : '@mention me with a task and I answer in that thread. Message me directly for work that is just yours.',
      ...(opts.enabled
        ? []
        : [
            `I’m not enabled in this ${where} yet. An admin of your AgentConnect organization turns me on here in the AgentConnect console.`
          ]),
      'Send help to see what I can do and the commands I understand.'
    ],
    links: [
      { title: 'Open AgentConnect', url: opts.consoleUrl },
      { title: 'Guide', url: CHAT_PLATFORMS_GUIDE_URL },
      { title: 'Contact us', url: `mailto:${SUPPORT_EMAIL}` }
    ]
  }
}
