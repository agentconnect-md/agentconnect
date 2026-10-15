// `getToolGuide`: on-demand usage rules and runnable examples, so `sendMessage` keeps a short description (send-message-guide.md §3.4).
import { z } from 'zod'
import { isPatrolCoordinate, isSubsessionCoordinate, isTaskCoordinate } from '../../session/subsession-coordinate.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { offersThreadUpdates } from '../../platforms/thread-keys.js'
import { offersDirectMessages, platformLabel } from '../../platforms/read-ports.js'
import { optionalEnum, parseArgs, requiredEnum } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'
import { SEND_MESSAGE_ACTIONS, type SendMessageAction } from './send-message-actions.js'
import { DELEGATE_TASK_GUIDE, MESSAGE_TASK_GUIDE, type GuideExample } from './task-guide.js'

export type { GuideExample }

/** The tools a guide documents; the entry point is shared so other tools can join later. */
export const GUIDED_TOOLS = ['sendMessage'] as const

export const GET_TOOL_GUIDE_ARGS = z.strictObject({
  tool: requiredEnum('tool', GUIDED_TOOLS),
  action: optionalEnum('action', SEND_MESSAGE_ACTIONS)
})

export const GET_TOOL_GUIDE_TOOL: ToolDescriptor = {
  name: 'getToolGuide',
  description:
    'Read the rules and runnable examples for an AgentConnect tool. Use it before an unfamiliar sendMessage call ' +
    'or after a sendMessage argument error, then retry. Omit action for an overview of every action.',
  inputSchema: obj(
    {
      tool: { type: 'string', enum: [...GUIDED_TOOLS] },
      action: { type: 'string', enum: [...SEND_MESSAGE_ACTIONS], description: 'One sendMessage action, in full.' }
    },
    ['tool']
  )
}

interface ActionGuide {
  action: SendMessageAction
  purpose: string
  required: string[]
  optional: string[]
  rules: string[]
  examples: GuideExample[]
}

/** Every action's complete rules, with this session's own agent id in the examples that need it. */
function actionGuides(ctx: SessionContext): Record<SendMessageAction, ActionGuide> {
  return {
    callAgent: {
      action: 'callAgent',
      purpose:
        'Ask another AgentConnect agent to work or to answer you — the only action that does — or work visibly as ' +
        'yourself in another channel.',
      required: ['action', 'toAgent', 'message'],
      optional: ['channel', 'platform', 'integrationId', 'sessionId'],
      rules: [
        '`toAgent` is an AgentConnect agent id from listAgents or an [agent-id] sender envelope, never a platform ' +
          'member id such as a Slack `U…` id. Pass the bare id, or {"agentId":"<id>","needsReply":true}.',
        'Set needsReply whenever you expect an answer, a result, or a completion notice — your message asks a ' +
          'question, requests a result, or someone asked you to relay the answer. The peer works in its own ' +
          'conversation, so without needsReply nothing comes back, not even a failure. A bare id asks for no report ' +
          'on this call; it does not forbid one or clear an earlier request.',
        'Without `channel` the call is postless: nothing is posted anywhere. It reaches a peer only; your own id ' +
          'without `channel` is refused — work of your own that needs no conversation is a delegated task: use ' +
          'delegateTask.',
        'With `channel` it also posts one visible message at that channel’s root, @-mentions the target, and ' +
          `anchors the target to that post. Your own id (${ctx.agentId}) with \`channel\` opens and activates a ` +
          'visible conversation of your own there, where people can follow and respond. That session belongs to the ' +
          'conversation, not to you: it is not a task, so messageTask and stopTask do not reach it.',
        '`platform` and `integrationId` go only with `channel` and choose where it is, as for postMessage: ' +
          '`platform` defaults to the current conversation’s platform, so name it for a channel on another of your ' +
          'platforms (for example a Slack channel while you answer in webchat); `integrationId` picks a bot when ' +
          'several apply. The target is woken on that platform.',
        'The target may continue in context it already has; a call does not promise a fresh session.',
        '`sessionId` names an existing session of that agent — the `childSessionId` an earlier callAgent returned, ' +
          'yours or one someone shared with you — and delivers into exactly that session: nothing is posted, and it keeps ' +
          'its context and its other callers. Every call, even a repeat into the same session, is a new message it ' +
          'answers by that message’s id. It cannot be combined ' +
          'with `channel`, never names your own sessions (use messageTask for your task), and never ' +
          'falls back to another session: an unknown id, another agent’s id, a task, or a ' +
          'conversation the people asking you may not read returns `wake.delivered: false` with `wake.reason: ' +
          '"session_not_found"`.',
        'Not accepted: `thread`, `attachment`, `toUser`.',
        'The result is {ok, wake: {delivered, targetSession, reason?}, post?, childSessionId?, reply?, nextAction?}. ' +
          '`ok` alone is not delivery: read `wake.delivered` and `wake.reason`. When the result says ' +
          '`nextAction: finish-turn-and-wait`, end your turn; the reply arrives in a later turn. `viewSessionStatus` ' +
          'with `childSessionId` is for optional diagnostics only.',
        'To address an agent in the conversation you are already in, @-mention it in your ordinary reply instead ' +
          '(listAgents gives its `mention` token).'
      ],
      examples: [
        {
          use: 'Delegate and get the result back',
          arguments: {
            action: 'callAgent',
            toAgent: { agentId: '<agent-id>', needsReply: true },
            message: 'Review this change and report your findings.'
          }
        },
        {
          use: 'Fire-and-forget request whose outcome you never need',
          arguments: { action: 'callAgent', toAgent: '<agent-id>', message: 'FYI: the deploy window moved to 3pm.' }
        },
        {
          use: 'Visible work by yourself in another channel (a session of that conversation, not a task)',
          arguments: {
            action: 'callAgent',
            toAgent: ctx.agentId,
            channel: '<project-channel-id>',
            message: 'Investigate this project’s failing build here and discuss the findings in this conversation.'
          }
        },
        {
          use: 'Continue an existing session of a peer, reporting back to you',
          arguments: {
            action: 'callAgent',
            toAgent: { agentId: '<agent-id>', needsReply: true },
            sessionId: '<childSessionId an earlier callAgent returned>',
            message: 'Continue the discussion here and check the Windows behavior as well.'
          }
        },
        {
          use: 'Visible call to a peer in a channel, reporting back to you',
          arguments: {
            action: 'callAgent',
            toAgent: { agentId: '<agent-id>', needsReply: true },
            channel: '<channel-id>',
            message: 'Please triage the alert posted here and tell me what you find.'
          }
        },
        {
          use: 'Visible call to a peer in a channel on another of your platforms',
          arguments: {
            action: 'callAgent',
            toAgent: { agentId: '<agent-id>', needsReply: true },
            channel: '<slack-channel-id>',
            platform: 'slack',
            message: 'Please compute this here and tell me the result.'
          }
        }
      ]
    },
    delegateTask: DELEGATE_TASK_GUIDE,
    messageTask: MESSAGE_TASK_GUIDE,
    replyToSession: {
      action: 'replyToSession',
      purpose: 'Answer a message another session sent you, by its message id.',
      required: ['action', 'messageId', 'message'],
      optional: [],
      rules: [
        'Every message another session sends you starts with a header like `[Message <id>] From …` that names its ' +
          'id, its agent and its session; one that waits on your reply ends with the exact call. Pass that id as ' +
          '`messageId`. Messages you may still answer are also listed under "Messages you may answer".',
        'The reply goes only to the session that sent that message — never broadcast, never redirected — whichever ' +
          'message woke you last. Answer each message that needs it with its own call. A reply needs no session id: ' +
          'the message already names its sender.',
        'You may answer one message more than once, for example progress and then a result; the first delivered ' +
          'reply settles its request. A reply is itself a message, which its recipient can answer in turn.',
        'The message is injected into that session; nothing is posted on a platform, and that session’s own reply ' +
          'keeps its visible route. Never post the answer at that conversation’s channel root instead: that starts ' +
          'a separate conversation.',
        'A task delegated with delegateTask answers the messages of the session that started it any time — progress, a ' +
          'question, or its result — and a reply does not end its work; the daemon reports the end of each round of ' +
          'work itself. An approved proposal or a patrol replies once, at the end, and that reply settles it.',
        'Only `action`, `messageId`, and `message` are accepted; `sessionId`, `taskId` and `childSessionId` are not ' +
          'message ids.',
        'The result is {delivered, targetSession?, inReplyTo, reason?} with no `ok` wrapper. An id that names no ' +
          'message you received returns {delivered: false, reason: "message_not_found"}; other reasons report ' +
          'admission or routing refusals. After a delivered result, end your turn without repeating the message.'
      ],
      examples: [
        {
          use: 'Return the result a request asked for',
          arguments: {
            action: 'replyToSession',
            messageId: '<id of the request message>',
            message: 'Review complete: two issues found.'
          }
        },
        {
          use: 'A task’s question to the session that started it',
          arguments: {
            action: 'replyToSession',
            messageId: '<id of the instruction message>',
            message: 'The failure is isolated. Should the repair preserve the old configuration format?'
          }
        }
      ]
    },
    postMessage: {
      action: 'postMessage',
      purpose:
        'Post to a person, a channel, or another existing thread. It starts no work and nothing replies to you: to ' +
        'have another agent work or answer, use callAgent (with needsReply for its result); to work in a channel ' +
        'yourself, use callAgent with your own id and `channel`.',
      required: ['action', 'message', 'toUser or channel'],
      optional: ['toUser', 'channel', 'thread', 'platform', 'integrationId', 'attachment'],
      rules: [
        'Direct message: one human member id in `toUser`, without `channel`.',
        'Mention people in a channel: `toUser` (one id or an array of unique ids) plus `channel` posts one message at ' +
          'the channel root that @-mentions all of them. An array is never a group DM and requires `channel`.',
        '`toUser` names HUMAN platform members only — never an AgentConnect agent or your own bot identity. An ' +
          'agent’s bot, in `toUser` or as a mention in `message`, is refused because a post never wakes an agent: ' +
          'call that agent with callAgent instead.',
        'Bare `channel`: a root post that wakes and mentions nobody. It may seed your own idle context there but ' +
          'starts no model turn.',
        'Update an existing thread: `channel` plus `thread` (the thread root id, e.g. `threadTs` from ' +
          'getChannelHistory) posts inside it; agents already in that thread see it. `thread` is only for a bare ' +
          '`channel` post and never for the thread you are answering — that is your ordinary reply.',
        '`attachment` (with `toUser` or `channel`) forwards an image this conversation received, by its name in the ' +
          '`[attached: …]` marker, with `message` as the caption. Images only; for a file you produced use shareFile.',
        '`platform` defaults to the current conversation’s platform (a DM defaults to a platform that can open ' +
          'one); `integrationId` picks a bot when several apply. `channel` may be an id or an unambiguous name.',
        'A post reaches only where the people asking you could post themselves; on Slack the person asking confirms ' +
          'before the bot joins a channel it is not in. A post into a conversation shared with another ' +
          'organization comes back as a draft awaiting an internal member’s approval: say so and do not send it again.',
        'Not accepted: `toAgent`, `sessionId`, `messageId`, `needsReply`. A post has no reply, so anything that needs ' +
          'an answer is a callAgent with needsReply. If a result says a send MAY have been delivered, do not retry it.'
      ],
      examples: [
        {
          use: 'Direct message a person',
          arguments: { action: 'postMessage', toUser: '<user-id>', message: 'The deploy window moved to 3pm.' }
        },
        {
          use: 'Post at a channel root',
          arguments: { action: 'postMessage', channel: '<channel-id>', message: 'The review is complete.' }
        },
        {
          use: 'Mention people in one channel post',
          arguments: {
            action: 'postMessage',
            toUser: ['<user-id-1>', '<user-id-2>'],
            channel: '<channel-id>',
            message: 'Please review the release notes.'
          }
        },
        {
          use: 'Update an existing thread you are not answering',
          arguments: {
            action: 'postMessage',
            channel: '<channel-id>',
            thread: '<thread-root-id>',
            message: 'The hotfix is deployed to production.'
          }
        },
        {
          use: 'Forward a received image',
          arguments: {
            action: 'postMessage',
            channel: '<channel-id>',
            attachment: '<file name from the [attached: …] marker>',
            message: 'The screenshot from the report.'
          }
        }
      ]
    }
  }
}

/** Availability notes from trusted session context; execution still decides every call. */
function availability(ctx: SessionContext): Partial<Record<SendMessageAction, string>> {
  const platforms = [...new Set((ctx.integrations ?? []).map((integration) => integration.platform))]
  const notes: Partial<Record<SendMessageAction, string>> = {}
  if (isSubsessionCoordinate(ctx.thread)) {
    const unavailable =
      'Unavailable here: this session is itself a task, a patrol or an approved proposal and cannot delegate or ' +
      'message tasks. Do the work here, or report back with replyToSession and let the session that started it decide.'
    notes.delegateTask = unavailable
    notes.messageTask = unavailable
  }
  if (isTaskCoordinate(ctx.thread) || isPatrolCoordinate(ctx.thread)) {
    notes.replyToSession =
      'This session runs an approved proposal or a patrol: answer the message that started it once, at the end; ' +
      'that reply settles this work.'
  }
  if (platforms.length === 0) {
    notes.postMessage = 'Unavailable here: this agent has no platform integration to post with.'
    notes.callAgent = 'Postless calls only: this agent has no platform integration, so `channel` cannot post.'
  } else {
    const labels = (filter: (platform: string) => boolean) => platforms.filter(filter).map(platformLabel)
    const dm = labels(offersDirectMessages)
    const threads = labels(offersThreadUpdates)
    notes.postMessage =
      `Platforms: ${platforms.map(platformLabel).join(', ')}. Direct messages: ${dm.join(', ') || 'none'}. ` +
      `Thread updates: ${threads.join(', ') || 'none'}.`
    notes.callAgent =
      `Channel platforms: ${platforms.map(platformLabel).join(', ')}.` +
      (platforms.includes(ctx.platform)
        ? ''
        : ' This conversation’s platform has none of your bots, so a call with `channel` must name `platform`.')
  }
  return notes
}

/** The whole guide for one action, or the overview of every action with one minimal example each. */
export function sendMessageGuide(ctx: SessionContext, action?: SendMessageAction): Record<string, unknown> {
  const guides = actionGuides(ctx)
  const notes = availability(ctx)
  if (action !== undefined) {
    const guide = guides[action]
    return { tool: 'sendMessage', ...guide, ...(notes[action] ? { availability: notes[action] } : {}) }
  }
  return {
    tool: 'sendMessage',
    rules: [
      'Every call names one `action` and a `message` (Markdown). Calls without `action` fail without sending anything.',
      'For the conversation you are in now, write your ordinary reply instead; sendMessage reaches other places.',
      'To have another agent work or answer you, use callAgent, with needsReply when you want its result. ' +
        'postMessage starts no work and nothing replies to it, even when it mentions an agent’s bot.',
      'The daemon supplies your identity; you cannot send as anyone else.'
    ],
    actions: SEND_MESSAGE_ACTIONS.map((name) => ({
      action: name,
      purpose: guides[name].purpose,
      required: guides[name].required,
      optional: guides[name].optional,
      example: guides[name].examples[0]!.arguments,
      ...(notes[name] ? { availability: notes[name] } : {})
    })),
    next: 'Call getToolGuide {"tool":"sendMessage","action":"<action>"} for one action’s complete rules and examples.'
  }
}

export const getToolGuide: ToolHandler<unknown> = (ctx, args) =>
  sendMessageGuide(ctx, parseArgs(GET_TOOL_GUIDE_ARGS, args).action)
