import { z, type ZodType } from 'zod'
import type { SessionContext } from './context.js'
import { parseArgs, requiredString, ToolArgumentError } from './args.js'
import {
  AGENT_TARGET,
  attachmentField,
  channelField,
  deliverSendMessage,
  integrationIdField,
  messageField,
  parseAgentTarget,
  SEND_MESSAGE_BRANCHES,
  USER_ARRAY_NEEDS_CHANNEL,
  platformField,
  sendMessageGuidePointer,
  threadField,
  USER_TARGETS,
  type MessagingDeps
} from './messaging.js'
import { START_TASK_GUIDE_TEXT } from './task-guide.js'

/** The operations `sendMessage` performs, one required `action` each (send-message-guide.md §3.1). */
export const SEND_MESSAGE_ACTIONS = ['callAgent', 'startTask', 'messageTask', 'replyToSession', 'postMessage'] as const
export type SendMessageAction = (typeof SEND_MESSAGE_ACTIONS)[number]

const isAction = (value: unknown): value is SendMessageAction =>
  typeof value === 'string' && (SEND_MESSAGE_ACTIONS as readonly string[]).includes(value)

/** Each action's target requirement and accepted keys, besides `action` and `message`. */
const ACTION_KEYS: Record<SendMessageAction, { requires: readonly string[]; accepts: readonly string[] }> = {
  callAgent: { requires: ['toAgent'], accepts: ['toAgent', 'channel', 'platform', 'integrationId', 'sessionId'] },
  startTask: { requires: [], accepts: [] },
  messageTask: { requires: ['taskId'], accepts: ['taskId'] },
  replyToSession: { requires: ['messageId'], accepts: ['messageId'] },
  postMessage: {
    requires: ['toUser|channel'],
    accepts: ['toUser', 'channel', 'thread', 'platform', 'integrationId', 'attachment']
  }
}

const action = <A extends SendMessageAction>(name: A) => z.literal(name, `argument action must be ${name}`)

/** Every action's runtime validator: the strict field types its arguments must satisfy once the keys check out. */
export const SEND_MESSAGE_ACTION_SCHEMAS: Record<SendMessageAction, ZodType> = {
  callAgent: z.strictObject({
    action: action('callAgent'),
    toAgent: AGENT_TARGET,
    channel: channelField,
    platform: platformField,
    integrationId: integrationIdField,
    sessionId: requiredString('sessionId').optional(),
    message: messageField
  }),
  startTask: z.strictObject({ action: action('startTask'), message: messageField }),
  messageTask: z.strictObject({
    action: action('messageTask'),
    taskId: requiredString('taskId'),
    message: messageField
  }),
  replyToSession: z.strictObject({
    action: action('replyToSession'),
    messageId: requiredString('messageId'),
    message: messageField
  }),
  postMessage: z.strictObject({
    action: action('postMessage'),
    toUser: USER_TARGETS.optional(),
    channel: channelField,
    thread: threadField,
    platform: platformField,
    integrationId: integrationIdField,
    attachment: attachmentField,
    message: messageField
  })
}

const OVERVIEW = '{"tool":"sendMessage"}'
const MISSING_ACTION =
  'missing required argument `action`. Nothing was sent and no agent was woken. Use an action listed by ' +
  'getToolGuide for this daemon. The complete tool supports callAgent, startTask, messageTask, replyToSession, ' +
  `and postMessage. Call getToolGuide ${OVERVIEW} to get the arguments and examples, then retry sendMessage with the ` +
  'appropriate action'
const UNKNOWN_ACTION =
  `\`action\` must be one of ${SEND_MESSAGE_ACTIONS.join(', ')}. Nothing was sent and no agent was woken. Call ` +
  `getToolGuide ${OVERVIEW} for the arguments and examples, then retry with a valid action`
const present = (value: unknown): boolean => value !== undefined && value !== null
const quoted = (keys: readonly string[]) => keys.map((key) => `\`${key}\``).join(', ')
const strip = (pointer: string) => pointer.replace(/\.$/, '')
/** A recognized action's argument error, closed with that action's guide (send-message-guide.md §3.5). */
const guided = (text: string, action: SendMessageAction) =>
  `${text}. Call getToolGuide {"tool":"sendMessage","action":"${action}"} for the required arguments, then retry`

/** The `startTask` call to make instead, with the `startTask` guide inline, never echoing the message (send-message-guide.md §3.5). */
const START_TASK_INSTEAD =
  'Retry as:\n  sendMessage {"action":"startTask","message":"<the same message>"}\nstartTask guide:\n' +
  START_TASK_GUIDE_TEXT
const TASK_ID_NEEDED = (unexpected: readonly string[]) =>
  'action `messageTask` requires `taskId`, the nonempty `taskId` a startTask call in this session returned' +
  (unexpected.length > 0 ? `, and does not accept ${quoted(unexpected)}` : '') +
  '. Nothing was sent, and a missing, null or empty `taskId` never starts a task. To start a new background task, ' +
  START_TASK_INSTEAD
/** §3.5: a reply names the message it answers, never a session; a missing, empty or session-addressed one is an argument error. */
const MESSAGE_ID_NEEDED = (unexpected: readonly string[]) =>
  'action `replyToSession` requires `messageId`' +
  (unexpected.length > 0 ? ` and does not accept ${quoted(unexpected)}` : '') +
  '. Nothing was sent. Reply with the id of the message you are answering, shown with that message. Call ' +
  'getToolGuide {"tool":"sendMessage","action":"replyToSession"} for the required arguments, then retry with a valid ' +
  'action and target'
const BAD_PEER_SESSION = guided(
  'action `callAgent` takes `sessionId` only as the nonempty id of an existing session of the agent in `toAgent`, ' +
    'such as the `childSessionId` an earlier callAgent returned. Nothing was sent and no agent was woken. Omit ' +
    '`sessionId` to call the agent without naming a session; a null or empty id never starts one',
  'callAgent'
)
const PEER_SESSION_WITH_CHANNEL = guided(
  'action `callAgent` takes `channel` or `sessionId`, not both: `sessionId` delivers into that existing session ' +
    'and posts nothing. Nothing was sent and no agent was woken',
  'callAgent'
)
const POST_SELECTOR_WITHOUT_CHANNEL = guided(
  'action `callAgent` takes `platform` and `integrationId` only with `channel`: they choose where its visible post ' +
    'lands, and a call without `channel` posts nothing. Nothing was sent and no agent was woken',
  'callAgent'
)
const SELF_SESSION =
  'action `callAgent` with `sessionId` reaches another agent’s session, never one of yours. Nothing was sent and no ' +
  'agent was woken. To message a background task of yours, call getToolGuide ' +
  '{"tool":"sendMessage","action":"messageTask"} and retry with action `messageTask` and its `taskId`'
const SELF_CALL =
  'action `callAgent` with your own agent id needs `channel`. Work of your own that needs no conversation is a ' +
  `background task. Nothing was sent and no agent was woken. ${START_TASK_INSTEAD}\nTo work visibly in a channel ` +
  'instead, keep callAgent and add `channel`'

/** The validated action and the target-shaped arguments its existing delivery path takes. */
export interface ValidatedSendMessage {
  action: SendMessageAction
  delivery: Record<string, unknown>
  /** `messageTask`: the task's handle (send-message-guide.md §8.1). */
  taskId?: string
  /** `callAgent` into an existing session of the target agent: its handle (send-message-guide.md §9.2). */
  peerSessionId?: string
}

/** Check a `sendMessage` call's action and argument combination before any lookup or effect (send-message-guide.md §3.3). */
export function validateSendMessageAction(ctx: SessionContext, args: Record<string, unknown>): ValidatedSendMessage {
  const named = args.action
  if (!present(named)) throw new ToolArgumentError([MISSING_ACTION])
  if (!isAction(named)) throw new ToolArgumentError([UNKNOWN_ACTION])
  const spec = ACTION_KEYS[named]
  const keys = Object.keys(args).filter((key) => key !== 'action' && key !== 'message')
  const unexpected = keys.filter((key) => !spec.accepts.includes(key))
  // §8.1: a missing, null or empty task id is an argument error that names startTask, never a start.
  if (named === 'messageTask' && (typeof args.taskId !== 'string' || args.taskId.trim() === ''))
    throw new ToolArgumentError([TASK_ID_NEEDED(unexpected)])
  // §9.4: a reply without a nonempty `messageId`, or addressed by `sessionId`, names nothing to answer.
  if (
    named === 'replyToSession' &&
    (typeof args.messageId !== 'string' || args.messageId.trim() === '' || keys.includes('sessionId'))
  )
    throw new ToolArgumentError([MESSAGE_ID_NEEDED(unexpected)])
  // §9.2: a supplied peer-session id is nonempty, never a null or empty stand-in for creation.
  if (named === 'callAgent' && keys.includes('sessionId')) {
    const id = args.sessionId
    if (typeof id !== 'string' || id.trim() === '') throw new ToolArgumentError([BAD_PEER_SESSION])
    if (present(args.channel)) throw new ToolArgumentError([PEER_SESSION_WITH_CHANNEL])
  }
  if (named === 'callAgent' && !present(args.channel) && (present(args.platform) || present(args.integrationId)))
    throw new ToolArgumentError([POST_SELECTOR_WITHOUT_CHANNEL])
  const missing = spec.requires.filter((key) => key.split('|').every((alt) => !present(args[alt])))
  if (unexpected.length > 0 || missing.length > 0) {
    const clauses = [
      ...(missing.length > 0
        ? [`requires ${missing.map((key) => quoted(key.split('|')).replace(', ', ' or ')).join(' and ')}`]
        : []),
      ...(unexpected.length > 0 ? [`does not accept ${quoted(unexpected)}`] : []),
      // The one stray key with a known home: §3.2 keeps `needsReply` nested, with no top-level alias.
      ...(named === 'callAgent' && unexpected.includes('needsReply')
        ? ['takes `needsReply` inside `toAgent` as {"agentId":"…","needsReply":true}']
        : []),
      ...(named === 'postMessage' && (unexpected.includes('needsReply') || unexpected.includes('toAgent'))
        ? [
            'gets no reply and starts no work: to have an agent work or answer you, use action `callAgent` with ' +
              '`toAgent` as {"agentId":"…","needsReply":true}'
          ]
        : []),
      ...(named === 'startTask' && unexpected.includes('taskId')
        ? ['sends more to an existing task only as action `messageTask` with its `taskId`']
        : [])
    ]
    throw new ToolArgumentError([
      `action \`${named}\` ${clauses.join(' and ')}. ${strip(sendMessageGuidePointer(named))}`
    ])
  }
  parseArgs(SEND_MESSAGE_ACTION_SCHEMAS[named], args)
  const target = named === 'callAgent' ? parseAgentTarget(args.toAgent) : undefined
  const { action: _validated, ...rest } = args
  if (named === 'postMessage') {
    // The existing branch rules, up front: `thread` only on a bare channel, and a `toUser` array only with one.
    parseArgs(present(args.toUser) ? SEND_MESSAGE_BRANCHES.toUser : SEND_MESSAGE_BRANCHES.channel, rest)
    if (Array.isArray(args.toUser) && !present(args.channel))
      throw new ToolArgumentError([`${USER_ARRAY_NEEDS_CHANNEL}. ${strip(sendMessageGuidePointer('postMessage'))}`])
  }
  if (named === 'startTask') return { action: named, delivery: { toAgent: ctx.agentId, message: args.message } }
  if (named === 'messageTask') return { action: named, delivery: {}, taskId: args.taskId as string }
  if (target?.toAgent === ctx.agentId && typeof args.sessionId === 'string') throw new ToolArgumentError([SELF_SESSION])
  if (target?.toAgent === ctx.agentId && !present(args.channel)) {
    throw new ToolArgumentError([SELF_CALL])
  }
  if (named === 'callAgent' && typeof args.sessionId === 'string') {
    const { sessionId, ...call } = rest
    return { action: named, delivery: call, peerSessionId: sessionId as string }
  }
  return { action: named, delivery: rest }
}

/** `sendMessage`: validate the action, then hand its target-shaped arguments to the existing delivery path. */
export async function sendMessage(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MessagingDeps
): Promise<unknown> {
  const validated = validateSendMessageAction(ctx, args)
  if (validated.taskId !== undefined) return await messageTask(ctx, validated.taskId, args, deps)
  if (validated.peerSessionId !== undefined) return await callPeerSession(ctx, validated.peerSessionId, args, deps)
  return await deliverSendMessage(ctx, validated.delivery, deps)
}

/** The guidance a delivered call into an existing peer session hands back when a reply was asked for. */
export const PEER_SESSION_CALLED =
  'Message delivered into that existing session, which keeps its context and its other callers. The agent will ' +
  'reply by waking this session in a later turn. End this turn and wait; do not retry or ask it to repeat the work.'

/** `callAgent` with `sessionId` (send-message-guide.md §9.2): postless, into that session or nowhere, with the agent-call receipt. */
async function callPeerSession(
  ctx: SessionContext,
  sessionId: string,
  args: Record<string, unknown>,
  deps: MessagingDeps
): Promise<unknown> {
  const { toAgent, needsReply } = parseAgentTarget(args.toAgent)
  const wake = await deps.messageAgent({
    callerAgentId: ctx.agentId,
    platform: ctx.platform,
    ...(ctx.integrationId !== undefined ? { callerIntegrationId: ctx.integrationId } : {}),
    ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
    callerChannel: ctx.channel,
    callerThread: ctx.thread,
    toAgentId: toAgent!,
    text: parseArgs(messageField, args.message),
    channel: ctx.channel,
    ...(needsReply ? { needsReply: true } : {}),
    targetSessionId: sessionId,
    ...(deps.callId !== undefined ? { submissionId: deps.callId } : {})
  })
  if (!wake.delivered) return { ok: true, wake }
  return {
    ok: true,
    wake,
    childSessionId: wake.targetSession,
    ...(needsReply
      ? {
          reply: { requested: true, state: 'awaiting' as const },
          nextAction: 'finish-turn-and-wait' as const,
          message: PEER_SESSION_CALLED
        }
      : {})
  }
}

/** The guidance a delivered task message hands back. */
export const TASK_MESSAGED =
  'Message delivered to the existing task, which keeps its earlier context; it runs once any work it has in hand ' +
  'is done. It reports back into this session when this round of its work ends. End this turn and wait; do not ' +
  'send the same message again.'

/** The `messageTask` receipt, in the `startTask` receipt's family (send-message-guide.md §8.6). */
async function messageTask(
  ctx: SessionContext,
  taskId: string,
  args: Record<string, unknown>,
  deps: MessagingDeps
): Promise<unknown> {
  if (!deps.continueSubsession) throw new Error('sendMessage: messaging a task is not available on this daemon')
  const wake = await deps.continueSubsession({
    callerAgentId: ctx.agentId,
    platform: ctx.platform,
    ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
    callerChannel: ctx.channel,
    callerThread: ctx.thread,
    sessionId: taskId,
    text: parseArgs(messageField, args.message),
    ...(deps.callId !== undefined ? { submissionId: deps.callId } : {})
  })
  if (!wake.delivered) return { ok: true, wake }
  return {
    ok: true,
    wake,
    taskId: wake.targetSession,
    reply: { requested: true, state: 'awaiting' as const },
    nextAction: 'finish-turn-and-wait' as const,
    message: TASK_MESSAGED
  }
}
