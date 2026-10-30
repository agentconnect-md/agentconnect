// The coordinator session's prompt, tool surface and turn input (auto-session-mode.md §4, §5.4, §9); the runtime matrix probes these texts.
import { MEMORY_TOOL_ACCESS_MODES } from '../mcp/ops/memory.js'
import { NO_RESPONSE_SENTINEL } from '../session/no-response.js'
import type { ToolDescriptor } from '../tool-schema/descriptor.js'

/** A delivered message's id is its platform id behind this prefix, so a bare timestamp is never read as a number (§4.3). */
export const COORDINATOR_MESSAGE_ID_PREFIX = 'msg-'

/** The id the coordinator names a delivered platform message by. */
export function coordinatorMessageId(platformMessageId: string): string {
  return `${COORDINATOR_MESSAGE_ID_PREFIX}${platformMessageId}`
}

/** Another agent in the conversation, listed so a message for it is recognized as not this agent's (§9). */
export interface CoordinatorPeer {
  name: string
  /** How the platform mentions it, when known. */
  address?: string
  description?: string
}

/** What the coordinator's standing instructions name. */
export interface CoordinatorPromptInput {
  agentName: string
  /** The platform's display name, such as Slack. */
  platform: string
  channelId: string
  channelName?: string
  /** How the platform mentions this agent, when known. */
  selfAddress?: string
  peers: readonly CoordinatorPeer[]
}

/** One delivered message as the coordinator reads it. */
export interface CoordinatorMessage {
  /** The message's {@link coordinatorMessageId}. */
  id: string
  /** The sender, as the platform names them. */
  from: string
  mentionsYou: boolean
  text: string
  /** The {@link coordinatorMessageId} of the root a thread reply sits under; absent at the root. */
  thread?: string
}

const where = (input: { channelId: string; channelName?: string }): string =>
  input.channelName ? `#${input.channelName} (${input.channelId})` : input.channelId

const SEND_MESSAGE_DESCRIPTION =
  'Act on a channel message delivered to you as the coordinator. Every call names the message it decides on by messageId. ' +
  'action "delegateTask" opens a new task for the message: the task receives the original message verbatim and answers in its ' +
  'thread; give a short title and, only when needed, background in message. action "messageTask" hands the message to one of ' +
  'your open tasks by taskId; that task answers in the message thread. action "replyToMessage" posts your own short reply in ' +
  'the message thread. A message you make no call for is ignored. Each message takes at most one of these calls.'

const LIST_TASKS_DESCRIPTION =
  "List your open tasks: id, title, whether a thread is attached, owner, last activity, whether it is running, and the task's " +
  'own summary (scope, status, next step) with when it was last updated. Use it to tell whether a message belongs to existing ' +
  'work and to answer status questions.'

const str = (description: string) => ({ type: 'string', description })

/** The coordinator's `sendMessage`: the three decisions, each naming its message. */
export const COORDINATOR_SEND_MESSAGE_TOOL: ToolDescriptor = {
  name: 'sendMessage',
  description: SEND_MESSAGE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['delegateTask', 'messageTask', 'replyToMessage'] },
      messageId: str('Id of the delivered channel message this call decides on.'),
      taskId: str('messageTask only: the open task to hand the message to.'),
      title: str('delegateTask only: a short name for the new task, at most eight words.'),
      message: str(
        'replyToMessage: the reply text. delegateTask/messageTask: optional background the task cannot see in the message itself.'
      )
    },
    required: ['action', 'messageId'],
    additionalProperties: false
  }
}

/** The coordinator's `listTasks`, the shared handler under the coordinator's description. */
export const COORDINATOR_LIST_TASKS_TOOL: ToolDescriptor = {
  name: 'listTasks',
  description: LIST_TASKS_DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
}

/** The coordinator's decision tools; memory tools join them in a daemon session (§5.4). */
export function coordinatorTools(): ToolDescriptor[] {
  return [COORDINATOR_SEND_MESSAGE_TOOL, COORDINATOR_LIST_TASKS_TOOL]
}

/** A coordinator session's whole tool set: its decision tools and the memory tools among the session's own. */
export function coordinatorSessionTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  return [...coordinatorTools(), ...tools.filter((tool) => MEMORY_TOOL_ACCESS_MODES[tool.name] !== undefined)]
}

function peersLine(input: CoordinatorPromptInput): string {
  if (input.peers.length === 0) return '- No other agent is in this channel.'
  const listed = input.peers.map((peer) => {
    const named = peer.address ? `${peer.name} (${input.platform} user ${peer.address})` : peer.name
    return peer.description ? `${named}: ${peer.description.trim().replace(/\.$/, '')}` : named
  })
  return `- Other agents in this channel: ${listed.join('; ')}. A message addressed to one of them is not for you.`
}

/** The coordinator session's standing instructions. */
export function coordinatorPrompt(input: CoordinatorPromptInput): string {
  const self = input.selfAddress ? ` Your ${input.platform} user is ${input.selfAddress}.` : ''
  return [
    '# You are the coordinator',
    `You coordinate the agent "${input.agentName}" in ${input.platform} channel ${where(input)}.${self} Channel ` +
      'messages are delivered to you, one or several per turn. You never do the work ' +
      'yourself: you have no workspace, and you must not read files, run commands, search the web, or use any tool other ' +
      'than sendMessage and listTasks. For every delivered message you choose exactly one outcome:',
    '',
    '1. Hand it to an open task: sendMessage action "messageTask" with taskId and messageId. Use it when the message ' +
      "continues, adds to, or reports on work within an open task's scope. The task answers in the message's thread.",
    '2. Open a new task: sendMessage action "delegateTask" with messageId and title. Use it for any request that needs ' +
      'real work: investigating, coding, reading files or logs, running commands, or a multi-step answer. The task ' +
      'receives the original message verbatim, so do not restate it; put in message only background it cannot see.',
    '3. Reply yourself: sendMessage action "replyToMessage" with messageId and message, which posts a visible reply in ' +
      "the message's thread. Use it only for what you can " +
      "answer in one or two sentences without any work: greetings, thanks, or a status question answered from a task's summary.",
    '4. Ignore it: make no call for it. Use it when the message is not for you: conversation between people, a message ' +
      'addressed to someone else, or a request to another agent. Ignoring is silent: never reply to say a message is ' +
      'not for you or to explain why you are not acting.',
    '',
    '# Rules',
    '- Each call names its message by its id, copied exactly as a string, and each message gets at most one outcome.',
    '- A message marked mentions-you="yes" is addressed to you and must not be ignored.',
    '- Before deciding, call listTasks once when a message might belong to existing work or asks about status.',
    "- Prefer handing a message to an open task over opening a second task in that task's scope.",
    peersLine(input),
    `- Your final text is never shown to anyone. After your calls, end the turn with exactly ${NO_RESPONSE_SENTINEL}.`
  ].join('\n')
}

// A body cannot close its own frame and open a forged one.
const framed = (text: string): string => text.replace(/<\/message>/gi, '<\\/message>')

/** One coordinator turn's input: the delivered messages, each with its id, sender and whether it mentions the agent. */
export function renderCoordinatorBatch(
  messages: readonly CoordinatorMessage[],
  at: { channelId: string; channelName?: string }
): string {
  const blocks = messages.map(
    (message) =>
      `<message id="${message.id}" from="${message.from}" mentions-you="${message.mentionsYou ? 'yes' : 'no'}"` +
      `${message.thread ? ` thread="${message.thread}"` : ''}>\n${framed(message.text)}\n</message>`
  )
  const kind = messages.some((message) => message.thread !== undefined) ? 'channel' : 'channel-root'
  const count = messages.length === 1 ? `One new ${kind} message` : `${messages.length} new ${kind} messages`
  return `[${count} in ${where(at)}]\n${blocks.join('\n')}`
}
