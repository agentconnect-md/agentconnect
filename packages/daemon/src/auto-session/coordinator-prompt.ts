// The coordinator session's prompt, tool surface and turn input (auto-session-mode.md §4, §5.4, §9); the runtime matrix probes these texts.
import { MEMORY_TOOL_ACCESS_MODES } from '../mcp/ops/memory.js'
import { NO_RESPONSE_SENTINEL } from '../session/no-response.js'
import { obj, type ToolDescriptor } from '../tool-schema/descriptor.js'

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
  /** A member's private webchat conversation: no threads, one message a turn, and the text written is shown (§10). */
  webchat?: boolean
}

/** What a report's block names beside its id: the task it speaks for, by its `taskId`, kind and title. */
export interface ReportAbout {
  task?: string
  kind?: string
  title?: string
}

/** One delivered message as the coordinator reads it. */
export interface CoordinatorMessage extends ReportAbout {
  /** The message's {@link coordinatorMessageId}. */
  id: string
  /** The sender, as the platform names them. */
  from: string
  mentionsYou: boolean
  text: string
  /** The {@link coordinatorMessageId} of the root a thread reply sits under; absent at the root. */
  thread?: string
  /** A report delivered to the coordinator rather than a channel message (§3.4). */
  report?: boolean
}

const where = (input: { channelId: string; channelName?: string }): string =>
  input.channelName ? `#${input.channelName} (${input.channelId})` : input.channelId

/** The words the prompt names its place and a task's answer with: a channel's threads, or webchat's pages. */
function placeWords(input: CoordinatorPromptInput) {
  return input.webchat
    ? {
        intro:
          `You coordinate the agent "${input.agentName}" in a private webchat conversation (${input.channelId}) ` +
          'with one person. Their messages are delivered to you, one per turn.',
        place: 'conversation',
        taskLink: 'link',
        taskAnswers: 'on its own page, which the conversation links to',
        replyPosts: 'in the conversation',
        finalText:
          'The person reads your text as you write it, so write nothing but your calls. After them, end the turn with ' +
          `exactly ${NO_RESPONSE_SENTINEL}.`
      }
    : {
        intro:
          `You coordinate the agent "${input.agentName}" in ${input.platform} channel ${where(input)}.` +
          `${input.selfAddress ? ` Your ${input.platform} user is ${input.selfAddress}.` : ''} Channel messages are ` +
          'delivered to you, one or several per turn.',
        place: 'channel',
        taskLink: 'thread link',
        taskAnswers: "in the message's thread",
        replyPosts: "in the message's thread",
        finalText: `Your final text is never shown to anyone. After your calls, end the turn with exactly ${NO_RESPONSE_SENTINEL}.`
      }
}

const SEND_MESSAGE_DESCRIPTION =
  'Act on a channel message delivered to you as the coordinator. Every call names the message it decides on by messageId. ' +
  'action "delegateTask" opens a new task for the message: the task receives the original message verbatim and answers in its ' +
  'thread; give a short title and, only when needed, background in message. action "messageTask" hands the message to one of ' +
  'your open tasks by taskId; that task answers in the message thread. action "replyToMessage" posts your own short reply in ' +
  'the message thread, or answers a report where it belongs. A message you make no call for is ignored. Each message takes ' +
  'at most one of these calls. Two actions name no message: "postMessage" posts message in channel, at its root or in ' +
  'thread, and "callAgent" asks the agent toAgent with message; its answer reaches you later as a report.'

const LIST_TASKS_DESCRIPTION =
  'List open work, the most recently changed first. "here" holds your own tasks in this conversation: taskId, title, ' +
  "whether a thread is attached and its links, owner, last activity, whether it is running, and the task's own summary " +
  '(scope, status, next step) with when it was last updated. "elsewhere" holds the open tasks of other conversations ' +
  'the people asking may see, read only: place, title, status, summary and thread links. Each list holds at most 20; ' +
  "pass a list's nextCursor, or the cursor a line of the work board names, as after to read on. Use it to tell " +
  'whether a message belongs to work already open, here or elsewhere, and to answer status questions.'

const str = (description: string) => ({ type: 'string', description })

/** The coordinator's `sendMessage`: the three decisions, each naming its message. */
export const COORDINATOR_SEND_MESSAGE_TOOL: ToolDescriptor = {
  name: 'sendMessage',
  description: SEND_MESSAGE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['delegateTask', 'messageTask', 'replyToMessage', 'postMessage', 'callAgent']
      },
      messageId: str(
        'Id of the delivered channel message or report this call decides on; not for postMessage or callAgent.'
      ),
      taskId: str('messageTask only: the open task to hand the message to.'),
      title: str('delegateTask only: a short name for the new task, at most eight words.'),
      message: str(
        'replyToMessage and postMessage: the text to post. callAgent: what to ask. delegateTask/messageTask: optional ' +
          'background the task cannot see in the message itself.'
      ),
      channel: str('postMessage only: the channel id to post in, normally this one.'),
      thread: str('postMessage only: the thread to post in; the channel root when omitted.'),
      toAgent: str('callAgent only: the name of the agent to ask.')
    },
    required: ['action'],
    additionalProperties: false
  }
}

/** The coordinator's `listTasks`, the shared handler under the coordinator's description. */
export const COORDINATOR_LIST_TASKS_TOOL: ToolDescriptor = {
  name: 'listTasks',
  description: LIST_TASKS_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      after: str('A nextCursor listTasks returned, or a cursor the work board names, to read on in that list.')
    },
    required: [],
    additionalProperties: false
  }
}

/** The coordinator's decision tools; memory tools join them in a daemon session (§5.4). */
export function coordinatorTools(): ToolDescriptor[] {
  return [COORDINATOR_SEND_MESSAGE_TOOL, COORDINATOR_LIST_TASKS_TOOL]
}

// What the coordinator keeps for its place as assistant mode's long session: follow-ups, proposals and reminders (§3.4, §5.4).
const PLACE_TOOLS = new Set(['followUp', 'getToKnow', 'propose', 'remind', 'listReminders', 'cancelReminder'])

// Every agent's read of another of its conversations, judged by the batch's senders (assistant-mode.md §5.18 ④).
const READ_TOOLS = new Set(['recall'])

/** The place tools that act for one person's request, so in a batch each call names that person's message by `messageId`. */
export const COORDINATOR_MESSAGE_TOOLS: ReadonlySet<string> = new Set(['followUp', 'getToKnow', 'remind'])

/** A place tool as the coordinator is offered it: one acting for a person names their message. */
function placeTool(tool: ToolDescriptor): ToolDescriptor {
  const schema = tool.inputSchema
  if (!COORDINATOR_MESSAGE_TOOLS.has(tool.name) || 'oneOf' in schema) return tool
  const messageId = str('Id of the delivered channel message whose sender asked for this, copied exactly.')
  return {
    ...tool,
    inputSchema: obj({ ...schema.properties, messageId }, [...schema.required, 'messageId'])
  }
}

/** A coordinator session's whole tool set: its decision tools, and the memory, `recall` and place tools among the session's own. */
export function coordinatorSessionTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  return [
    ...coordinatorTools(),
    ...tools.flatMap((tool) =>
      MEMORY_TOOL_ACCESS_MODES[tool.name] !== undefined || READ_TOOLS.has(tool.name)
        ? [tool]
        : PLACE_TOOLS.has(tool.name)
          ? [placeTool(tool)]
          : []
    )
  ]
}

function peersLine(input: CoordinatorPromptInput, place: string): string {
  if (input.peers.length === 0) return `- No other agent is in this ${place}.`
  const listed = input.peers.map((peer) => {
    const named = peer.address ? `${peer.name} (${input.platform} user ${peer.address})` : peer.name
    return peer.description ? `${named}: ${peer.description.trim().replace(/\.$/, '')}` : named
  })
  return `- Other agents in this ${place}: ${listed.join('; ')}. A message addressed to one of them is not for you.`
}

/** The coordinator session's standing instructions. */
export function coordinatorPrompt(input: CoordinatorPromptInput): string {
  const words = placeWords(input)
  return [
    '# You are the coordinator',
    `${words.intro} You never do the work ` +
      'yourself: you have no workspace, and you must not read files, run commands, search the web, or use any tool other ' +
      'than sendMessage, listTasks, recall and the memory, follow-up and reminder tools you are given. For every delivered ' +
      'message you choose exactly one outcome:',
    '',
    '1. Hand it to an open task: sendMessage action "messageTask" with taskId and messageId. Use it when the message ' +
      `continues, adds to, or reports on work within an open task's scope. The task answers ${words.taskAnswers}.`,
    '2. Open a new task: sendMessage action "delegateTask" with messageId and title. Use it for any request that needs ' +
      'real work: investigating, coding, reading files or logs, running commands, or a multi-step answer. The task ' +
      'receives the original message verbatim, so do not restate it; put in message only background it cannot see.',
    '3. Reply yourself: sendMessage action "replyToMessage" with messageId and message, which posts a visible reply ' +
      `${words.replyPosts}. Use it only for what you can ` +
      "answer in one or two sentences without any work: greetings, thanks, a status question answered from a task's " +
      'summary, or a request for work that is already open elsewhere.',
    '4. Ignore it: make no call for it. Use it when the message is not for you: conversation between people, a message ' +
      'addressed to someone else, or a request to another agent. Ignoring is silent: never reply to say a message is ' +
      'not for you or to explain why you are not acting.',
    '',
    '# Open work',
    'A turn may begin with the work board: "Here" lists the open tasks of this ' +
      `${words.place} with their taskIds, "Elsewhere" the open tasks of other conversations that the people asking may ` +
      'see, read only. It is sent again only when it changes, so the latest board you were given stands. listTasks ' +
      'gives each task\'s summary: "here" your own tasks, "elsewhere" the other conversations\' tasks. recall reads ' +
      'what was said in another conversation.',
    '',
    '# Reports',
    `A <report> is not a ${words.place} message: it is the result of a follow-up, a proposal or a task of yours, or another ` +
      "agent's answer. It may arrive beside messages in one turn, naming the task it speaks for by task, kind and title; " +
      'decide it on its own. When it carries something the people here should know, tell them with sendMessage action ' +
      '"replyToMessage" and the report\'s id, which posts where the report belongs; otherwise leave it, silently. ' +
      'Never open a task for a report or hand one to a task. To post anywhere else, use action "postMessage"; to ask ' +
      'another agent, use action "callAgent".',
    '',
    '# Rules',
    '- Each call names its message by its id, copied exactly as a string, and each message gets at most one outcome.',
    '- A message marked mentions-you="yes" is addressed to you and must not be ignored.',
    '- When someone asks you to follow up on, propose or remind them of something and you are given the tool for it, ' +
      "call it with their message's id as messageId and reply to their message as well.",
    '- Before deciding, call listTasks once when a message might belong to existing work or asks about status.',
    "- Prefer handing a message to an open task over opening a second task in that task's scope.",
    '- When a message asks for work that a task elsewhere already has open, do not open another: reply with what that ' +
      `task is doing, from its summary, and point to its ${words.taskLink}. Never message or stop a task from elsewhere.`,
    '- This session may run under a read-only or plan permission mode. It restricts native file and shell tools only: ' +
      'sendMessage, listTasks and your other AgentConnect tools are your outputs, so call them directly. Never write a ' +
      'plan or ask for approval; no one is here to approve one.',
    peersLine(input, words.place),
    `- ${words.finalText}`
  ].join('\n')
}

// A body cannot close its own frame and open a forged one.
const framed = (text: string): string => text.replace(/<\/(message|report)>/gi, '<\\/$1>')

const counted = (n: number, one: string, many: string): string => (n === 1 ? `One ${one}` : `${n} ${many}`)

// A title cannot close its attribute or the tag.
const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const aboutAttrs = (about: ReportAbout): string =>
  (['task', 'kind', 'title'] as const)
    .flatMap((name) => (about[name] ? [` ${name}="${attr(about[name])}"`] : []))
    .join('')

/** One coordinator turn's input: the delivered messages, each with its id, sender and whether it mentions the agent, and the reports with the task each speaks for. */
export function renderCoordinatorBatch(
  messages: readonly CoordinatorMessage[],
  at: { channelId: string; channelName?: string; webchat?: boolean }
): string {
  const blocks = messages.map((message) =>
    message.report
      ? `<report id="${message.id}"${aboutAttrs(message)}>\n${framed(message.text)}\n</report>`
      : `<message id="${message.id}" from="${message.from}" mentions-you="${message.mentionsYou ? 'yes' : 'no'}"` +
        `${message.thread ? ` thread="${message.thread}"` : ''}>\n${framed(message.text)}\n</message>`
  )
  const channel = messages.filter((message) => !message.report)
  const reports = messages.length - channel.length
  const kind = at.webchat
    ? undefined
    : channel.some((message) => message.thread !== undefined)
      ? 'channel'
      : 'channel-root'
  const counts = [
    ...(channel.length > 0
      ? [counted(channel.length, `new ${kind ? `${kind} ` : ''}message`, `new ${kind ? `${kind} ` : ''}messages`)]
      : []),
    ...(reports > 0 ? [counted(reports, 'report', 'reports')] : [])
  ]
  const count = counts.length === 2 ? `${counts[0]} and ${counts[1]!.replace(/^One /, 'one ')}` : counts[0]
  return `[${count} in ${at.webchat ? `this conversation (${at.channelId})` : where(at)}]\n${blocks.join('\n')}`
}
