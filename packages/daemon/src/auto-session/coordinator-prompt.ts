// The coordinator session's prompt, tool surface and turn input (auto-session-mode.md §4, §5.4, §9); the runtime matrix probes these texts.
import { READ_TASK_TOOL } from '../mcp/ops/assistant-subsessions.js'
import { MEMORY_TOOL_ACCESS_MODES } from '../mcp/ops/memory.js'
import { NO_RESPONSE_SENTINEL } from '../session/no-response.js'
import { obj, type ToolDescriptor } from '../tool-schema/descriptor.js'

export { COORDINATOR_MESSAGE_ID_PREFIX, coordinatorMessageId } from './message-id.js'

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
  /** A member's webchat conversation, shared if published: one message a turn, with streamed text. */
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

/** What was said in a thread before the coordinator was given any of it (§4.1). */
export interface CoordinatorThread {
  /** The {@link coordinatorMessageId} of the thread's root, as a message's `thread` names it. */
  id: string
  /** Its earlier messages, oldest first; `from` is `you` for this agent's own. */
  earlier: readonly { from: string; text: string }[]
  /** How many earlier messages the excerpt leaves out. */
  elided?: number
}

const where = (input: { channelId: string; channelName?: string }): string =>
  input.channelName ? `#${input.channelName} (${input.channelId})` : input.channelId

/** The words the prompt names its place and a task's answer with: a channel's threads, or a console conversation's. */
function placeWords(input: CoordinatorPromptInput) {
  return input.webchat
    ? {
        intro:
          `You coordinate the agent "${input.agentName}" in a webchat conversation (${input.channelId}). ` +
          'Its owner may share it with other organization members. Messages name their sender and are delivered ' +
          'to you, one per turn, at the conversation root or in a ' +
          'thread under a root message, which the message names.',
        place: 'conversation',
        taskLink: 'link',
        taskAnswers:
          'in its own thread: a message at the conversation root joins that thread, and a message in another thread ' +
          'brings that thread to the task',
        replyPosts: "in the message's thread",
        finalText:
          'The person reads your text as you write it: it is your reply, so write only what answers them, never your ' +
          `reasoning. When a call decided their message, write nothing but ${NO_RESPONSE_SENTINEL}.`
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
        finalText:
          'The text that ends your turn is posted as your reply to the message you made no call for, so it holds ' +
          'only that reply: never your reasoning, a note on what you did, or why you left a message. Once every ' +
          `message has its call, write nothing more, or exactly ${NO_RESPONSE_SENTINEL}.`
      }
}

const SEND_MESSAGE_DESCRIPTION =
  'Act on a channel message delivered to you as the coordinator. Every call names the message it decides on by messageId. ' +
  'action "delegateTask" opens a new task for the message: the task receives the original message verbatim and answers in its ' +
  'thread; give a short title and, only when needed, background in message. action "messageTask" hands the message to one of ' +
  'your open tasks by taskId; that task answers in the message thread. action "replyToMessage" posts your own short reply in ' +
  'the message thread, or answers a report where it belongs. A message you make no call for is answered by the text that ' +
  'ends your turn, so leave a message unanswered with ignoreMessage, not with this tool. Each message takes ' +
  'at most one of these calls. Two actions name no message: "postMessage" posts message in channel, at its root or in ' +
  'thread, and "callAgent" asks the agent toAgent with message; its answer reaches you later as a report.'

const LIST_TASKS_DESCRIPTION =
  'List open work, the most recently changed first. "here" holds your own tasks in this conversation: taskId, title, ' +
  "whether a thread is attached and its links, owner, last activity, whether it is running, and the task's own summary " +
  '(status first, then scope and next step) with when it was last updated. "elsewhere" holds the open tasks of other ' +
  'conversations the people asking may see, read only: id, place, title, status, summary and thread links. Entries ' +
  'also name the message a task was opened for and the pull requests it opened. Each list holds at most 20; ' +
  "pass a list's nextCursor, or the cursor a line of the work board names, as after to read on. Use it to tell " +
  'whether a message belongs to work already open, here or elsewhere, and to answer status questions.'

const str = (description: string) => ({ type: 'string', description })

/** The coordinator's `sendMessage` arguments besides `action`; each description names the actions it serves. */
const SEND_MESSAGE_FIELDS = {
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
}

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
      ...SEND_MESSAGE_FIELDS
    },
    required: ['action'],
    additionalProperties: false
  }
}

/** A blank or null advertised field is absent: some runtimes fill every field they leave unused with ''. */
export function withoutBlankCoordinatorFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        !Object.hasOwn(SEND_MESSAGE_FIELDS, key) ||
        (value !== null && (typeof value !== 'string' || value.trim() !== ''))
    )
  )
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

const IGNORE_MESSAGE_DESCRIPTION =
  'Leave a delivered channel message or report unanswered, as the coordinator. Call it for every message that is not ' +
  'for you: conversation between people, a message addressed to someone else, a request to another agent, or a ' +
  'report that tells the people here nothing new. Nothing is posted for that message, whatever you write afterwards. ' +
  'Without this call, the text that ends your turn is posted as your reply to the message. reason is kept in your ' +
  'own record and is never posted.'

/** The coordinator's `ignoreMessage`: the outcome that leaves a message unanswered, so the turn's text has nothing to answer (§4.2). */
export const COORDINATOR_IGNORE_MESSAGE_TOOL: ToolDescriptor = {
  name: 'ignoreMessage',
  description: IGNORE_MESSAGE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      messageId: str('Id of the delivered channel message or report to leave unanswered, copied exactly.'),
      reason: str('Why it is not for you, in a few words.')
    },
    required: ['messageId', 'reason'],
    additionalProperties: false
  }
}

/** The coordinator's decision tools and its read of one task; memory tools join them in a daemon session (§5.4). */
export function coordinatorTools(): ToolDescriptor[] {
  return [COORDINATOR_SEND_MESSAGE_TOOL, COORDINATOR_IGNORE_MESSAGE_TOOL, COORDINATOR_LIST_TASKS_TOOL, READ_TASK_TOOL]
}

// What the coordinator keeps for its place as assistant mode's long session: follow-ups, proposals and reminders (§3.4, §5.4).
const PLACE_TOOLS = new Set(['followUp', 'getToKnow', 'propose', 'remind', 'listReminders', 'cancelReminder'])

// Every agent's read of another of its conversations, judged by the batch's senders (assistant-mode.md §5.18 ④).
const READ_TOOLS = new Set(['recall'])

/** The place tools that act for one person's request, so in a batch each call names that person's message by `messageId`. */
export const COORDINATOR_MESSAGE_TOOLS: ReadonlySet<string> = new Set(['followUp', 'getToKnow', 'remind'])

/** A place tool as the coordinator is offered it: one acting for a person names their message, and an offer may name the one it answers. */
function placeTool(tool: ToolDescriptor): ToolDescriptor {
  const schema = tool.inputSchema
  if ('oneOf' in schema) return tool
  // A getting-to-know report round's proposals answer no message, so only an offer names one (assistant-mode.md §5.10).
  if (tool.name === 'propose') {
    const messageId = str('For an offered follow-up: id of the delivered channel message it answers, copied exactly.')
    return { ...tool, inputSchema: obj({ ...schema.properties, messageId }, schema.required) }
  }
  if (!COORDINATOR_MESSAGE_TOOLS.has(tool.name)) return tool
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
      'than sendMessage, ignoreMessage, listTasks, readTask, recall and the memory, follow-up and reminder tools you are given. For ' +
      'every delivered message you choose exactly one outcome:',
    '',
    '1. Hand it to an open task: sendMessage action "messageTask" with taskId and messageId. Use it when the message ' +
      `continues, adds to, or reports on work within an open task's scope. The task answers ${words.taskAnswers}.`,
    '2. Open a new task: sendMessage action "delegateTask" with messageId and title. Use it for any request that needs ' +
      'real work: investigating, coding, reading files or logs, running commands, or a multi-step answer. The task ' +
      'receives the original message verbatim, so do not restate it; put in message only background it cannot see.',
    `3. Reply yourself: write your reply as the text that ends your turn, which is posted ${words.replyPosts}. ` +
      'Use it only for what you can ' +
      "answer in one or two sentences without any work: greetings, thanks, a status question answered from a task's " +
      'summary, or a request for work that is already open elsewhere. Your text answers one message, so when a turn ' +
      'delivers several, reply to each with sendMessage action "replyToMessage", its messageId and message.',
    '4. Ignore it: call ignoreMessage with its messageId and a short reason. Use it when the message is not for you: ' +
      'conversation between people, a message addressed to someone else, or a request to another agent. Nothing is ' +
      'posted for an ignored message, and the reason stays in your own record. Never reply to say a message is not ' +
      'for you or to explain why you are not acting: without the call, what you write is posted as a reply.',
    '',
    '# Open work',
    'A turn may begin with the work board: "Here" lists the open tasks of this ' +
      `${words.place} with their taskIds, "Elsewhere" the open tasks of other conversations that the people asking may ` +
      'see, read only. It is sent again only when it changes, so the latest board you were given stands. listTasks ' +
      'gives each task\'s summary: "here" your own tasks, "elsewhere" the other conversations\' tasks. readTask ' +
      "reads one task's latest words, the message it was opened for and the pull requests it opened, without waking " +
      'it, when its summary does not answer a question. recall reads what was said in another conversation.',
    "A task's title names what it is doing now, which the task keeps current, and its summary's first sentence " +
      'states its current status.',
    'A task runs in one of two modes: work, which does what it is given, or watch, a follow-up, which checks ' +
      'something on its schedule and reports only when it changes. Both are messaged and stopped by their taskId; a ' +
      'follow-up shows "next" and the time of its next check, or "running" while a check runs.',
    '',
    '# Reports',
    `A <report> is not a ${words.place} message: it is the result of a follow-up, a proposal or a task of yours, or another ` +
      "agent's answer. It may arrive beside messages in one turn, naming the task it speaks for by task, kind and title; " +
      'decide it on its own. When it carries something the people here should know, tell them with sendMessage action ' +
      '"replyToMessage" and the report\'s id, which posts where the report belongs; your text never answers a report. ' +
      'Otherwise leave it with ignoreMessage. ' +
      'Never open a task for a report or hand one to a task. To post anywhere else, use action "postMessage"; to ask ' +
      'another agent, use action "callAgent".',
    '',
    '# Rules',
    '- Each call names its message by its id, copied exactly as a string, and each message gets at most one outcome.',
    '- A message marked mentions-you="yes" is addressed to you and must not be ignored.',
    '- A <thread> block holds what was said in a thread before you were given any of it; from="you" marks this ' +
      "agent's own words there. It is background for the message that names that thread, never a message to decide. " +
      'Read that message as part of its thread: what it asks about is what the thread is about, not your other work.',
    '- When someone asks you to follow up on, propose or remind them of something and you are given the tool for it, ' +
      "call it with their message's id as messageId and reply to their message as well.",
    '- Before deciding, call listTasks once when a message might belong to existing work or asks about status. The ' +
      'work board only names the tasks; what each has done so far is in its listTasks summary, so never answer a ' +
      'status question from the board alone.',
    "- Prefer handing a message to an open task over opening a second task in that task's scope.",
    '- A line like [attached: chart.png (image/png)] is all you see of a file. A task handed the message receives the ' +
      'file itself, so a message with an attachment that is for you goes to an open task or a new one; a reply of ' +
      'your own to it is refused.',
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
const framed = (text: string): string => text.replace(/<\/(message|report|thread|earlier)>/gi, '<\\/$1>')

const counted = (n: number, one: string, many: string): string => (n === 1 ? `One ${one}` : `${n} ${many}`)

// A title cannot close its attribute or the tag.
const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const aboutAttrs = (about: ReportAbout): string =>
  (['task', 'kind', 'title'] as const)
    .flatMap((name) => (about[name] ? [` ${name}="${attr(about[name])}"`] : []))
    .join('')

/** One thread's earlier messages, framed apart from the messages a turn decides. */
function renderCoordinatorThread(thread: CoordinatorThread): string {
  const elided = thread.elided ? ` earlier-elided="${thread.elided}"` : ''
  const rows = thread.earlier.map((row) => `<earlier from="${attr(row.from)}">\n${framed(row.text)}\n</earlier>`)
  return `<thread id="${thread.id}"${elided}>\n${rows.join('\n')}\n</thread>`
}

/** One coordinator turn's input: the delivered messages, each with its id, sender and whether it mentions the agent, the reports with the task each speaks for, and the threads it meets part-way. */
export function renderCoordinatorBatch(
  messages: readonly CoordinatorMessage[],
  at: { channelId: string; channelName?: string; webchat?: boolean },
  threads: readonly CoordinatorThread[] = []
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
  const heard = threads.filter((thread) => thread.earlier.length > 0).map(renderCoordinatorThread)
  return `[${count} in ${at.webchat ? `this conversation (${at.channelId})` : where(at)}]\n${[...heard, ...blocks].join('\n')}`
}
