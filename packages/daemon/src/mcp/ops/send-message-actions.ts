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

/** The operations `sendMessage` performs, one required `action` each (send-message-guide.md §3.1). */
export const SEND_MESSAGE_ACTIONS = ['callAgent', 'messageSubsession', 'replyToSession', 'postMessage'] as const
export type SendMessageAction = (typeof SEND_MESSAGE_ACTIONS)[number]

const isAction = (value: unknown): value is SendMessageAction =>
  typeof value === 'string' && (SEND_MESSAGE_ACTIONS as readonly string[]).includes(value)

/** Each action's target requirement and accepted keys, besides `action` and `message`. */
const ACTION_KEYS: Record<SendMessageAction, { requires: readonly string[]; accepts: readonly string[] }> = {
  callAgent: { requires: ['toAgent'], accepts: ['toAgent', 'channel'] },
  messageSubsession: { requires: [], accepts: [] },
  replyToSession: { requires: ['sessionId'], accepts: ['sessionId'] },
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
    message: messageField
  }),
  messageSubsession: z.strictObject({ action: action('messageSubsession'), message: messageField }),
  replyToSession: z.strictObject({
    action: action('replyToSession'),
    sessionId: requiredString('sessionId'),
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
  'getToolGuide for this daemon. The complete tool supports callAgent, messageSubsession, replyToSession, and ' +
  `postMessage. Call getToolGuide ${OVERVIEW} to get the arguments and examples, then retry sendMessage with the ` +
  'appropriate action'
const UNKNOWN_ACTION =
  `\`action\` must be one of ${SEND_MESSAGE_ACTIONS.join(', ')}. Nothing was sent and no agent was woken. Call ` +
  `getToolGuide ${OVERVIEW} for the arguments and examples, then retry with a valid action`
const NO_CONTINUATION =
  'action `messageSubsession` does not accept `sessionId`: this daemon cannot send into an existing sub-session. ' +
  'Nothing was sent. Omit `sessionId` only to start a separate new background sub-session; otherwise wait for the ' +
  'existing one to report'
const SELF_CALL =
  'action `callAgent` without `channel` cannot target yourself. Nothing was sent and no agent was woken. For ' +
  'background work of your own, call getToolGuide {"tool":"sendMessage","action":"messageSubsession"} and retry ' +
  'with action `messageSubsession` and `message` only'

const present = (value: unknown): boolean => value !== undefined && value !== null
const quoted = (keys: readonly string[]) => keys.map((key) => `\`${key}\``).join(', ')
const strip = (pointer: string) => pointer.replace(/\.$/, '')

/** The validated action and the target-shaped arguments its existing delivery path takes. */
export interface ValidatedSendMessage {
  action: SendMessageAction
  delivery: Record<string, unknown>
}

/** Check a `sendMessage` call's action and argument combination before any lookup or effect (send-message-guide.md §3.3). */
export function validateSendMessageAction(ctx: SessionContext, args: Record<string, unknown>): ValidatedSendMessage {
  const named = args.action
  if (!present(named)) throw new ToolArgumentError([MISSING_ACTION])
  if (!isAction(named)) throw new ToolArgumentError([UNKNOWN_ACTION])
  const spec = ACTION_KEYS[named]
  const keys = Object.keys(args).filter((key) => key !== 'action' && key !== 'message')
  if (named === 'messageSubsession' && keys.includes('sessionId')) throw new ToolArgumentError([NO_CONTINUATION])
  const unexpected = keys.filter((key) => !spec.accepts.includes(key))
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
    if (Array.isArray(args.toUser) && !present(args.channel)) throw new ToolArgumentError([USER_ARRAY_NEEDS_CHANNEL])
  }
  if (named === 'messageSubsession') return { action: named, delivery: { toAgent: ctx.agentId, message: args.message } }
  if (target?.toAgent === ctx.agentId && !present(args.channel)) {
    throw new ToolArgumentError([SELF_CALL])
  }
  return { action: named, delivery: rest }
}

/** `sendMessage`: validate the action, then hand its target-shaped arguments to the existing delivery path. */
export async function sendMessage(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MessagingDeps
): Promise<unknown> {
  return await deliverSendMessage(ctx, validateSendMessageAction(ctx, args).delivery, deps)
}
