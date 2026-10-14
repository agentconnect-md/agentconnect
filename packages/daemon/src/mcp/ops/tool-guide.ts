// `getToolGuide`: on-demand usage rules and runnable examples, so `sendMessage` keeps a short description (send-message-guide.md §3.4).
import { z } from 'zod'
import { isSubsessionCoordinate } from '../../session/subsession-coordinate.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { offersThreadUpdates } from '../../platforms/thread-keys.js'
import { offersDirectMessages, platformLabel } from '../../platforms/read-ports.js'
import { optionalEnum, parseArgs, requiredEnum } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'
import { SEND_MESSAGE_ACTIONS, type SendMessageAction } from './send-message-actions.js'

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

/** One runnable call: `arguments` is exactly what to pass to `sendMessage`. */
export interface GuideExample {
  use: string
  arguments: Record<string, unknown>
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
      purpose: 'Ask another AgentConnect agent to work, or work visibly as yourself in another channel.',
      required: ['action', 'toAgent', 'message'],
      optional: ['channel', 'sessionId'],
      rules: [
        '`toAgent` is an AgentConnect agent id from listAgents or an [agent-id] sender envelope, never a platform ' +
          'member id such as a Slack `U…` id. Pass the bare id, or {"agentId":"<id>","needsReply":true}.',
        'Set needsReply whenever you expect an answer, a result, or a completion notice — your message asks a ' +
          'question, requests a result, or someone asked you to relay the answer. The peer works in its own ' +
          'conversation, so without needsReply nothing comes back, not even a failure. A bare id asks for no report ' +
          'on this call; it does not forbid one or clear an earlier request.',
        'Without `channel` the call is postless: nothing is posted anywhere. It reaches a peer only; your own id ' +
          'without `channel` is refused — use messageSubsession for background work of your own.',
        'With `channel` it also posts one visible message at that channel’s root, @-mentions the target, and ' +
          `anchors the target to that post. Your own id (${ctx.agentId}) with \`channel\` opens and activates a ` +
          'visible conversation of your own there, where people can follow and respond; it is not a background ' +
          'sub-session.',
        'The target may continue in context it already has; a call does not promise a fresh session.',
        '`sessionId` names an existing session of that agent — the `childSessionId` an earlier callAgent returned, ' +
          'yours or one someone shared with you — and delivers into exactly that session: nothing is posted, it keeps ' +
          'its context and its other callers, and you become one more session it can reply to. It cannot be combined ' +
          'with `channel`, never names your own sessions (use messageSubsession for your sub-session), and never ' +
          'falls back to another session: an unknown id, another agent’s id, a background sub-session, or a ' +
          'conversation the people asking you may not read returns `wake.delivered: false` with `wake.reason: ' +
          '"session_not_found"`.',
        'Not accepted: `platform`, `integrationId`, `thread`, `attachment`, `toUser`.',
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
          use: 'Visible work by yourself in another channel (not a background sub-session)',
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
        }
      ]
    },
    messageSubsession: {
      action: 'messageSubsession',
      purpose: 'Start a background sub-session of your own for long work, or send more work to one you started.',
      required: ['action', 'message'],
      optional: ['sessionId'],
      rules: [
        'Without `sessionId` it starts a new, separate sub-session. With `sessionId` — the `childSessionId` a ' +
          'messageSubsession call in this conversation returned — it sends the message into that existing sub-session, ' +
          'which keeps its context, whether it is still running or already reported. A null or empty `sessionId` is ' +
          'refused; it never starts a new one.',
        'The daemon derives you from trusted context. Not accepted: `toAgent`, `channel`, `thread`, `platform`, ' +
          '`integrationId`, `attachment`, `needsReply`.',
        'Use it for long work ("fix this bug and open a PR"). A sub-session inherits this conversation’s context, ' +
          'posts nothing, and reports back into this conversation each time a round of its work finishes or fails — ' +
          'no needsReply needed. It can also send you progress or a question meanwhile; answer with messageSubsession ' +
          'and its id. Say it has started, end your turn, and do not do the work here too.',
        'A message to a sub-session that is still working waits for its next turn; it does not interrupt it. One ' +
          'that already finished starts a new round of work in the same context.',
        'Say in its task which language the people here use, so it reports in that language.',
        'Keep ordinary conversation here: questions, lookups and short answers never need a sub-session.',
        'Only the conversation that started a sub-session can message it. A sub-session cannot open sub-sessions of ' +
          'its own. Refusals arrive as `wake.delivered: false` with a `wake.reason` and `wake.message`: ' +
          '`subsession_not_found` (no sub-session of this conversation has that id), `subsession_nesting`, and ' +
          '`subsession_limit` (too many running at once; a finished one holds no slot).',
        'The result carries `childSessionId`, the handle for messageSubsession, viewSessionStatus and stopSubsession. ' +
          'It is not a session id for replyToSession.',
        'To work visibly as yourself in another channel instead, use callAgent with your own id and `channel`.'
      ],
      examples: [
        {
          use: 'Start background work',
          arguments: {
            action: 'messageSubsession',
            message: 'Investigate the flaky test in the background and report your findings.'
          }
        },
        {
          use: 'More work for a sub-session you started, running or finished',
          arguments: {
            action: 'messageSubsession',
            sessionId: '<childSessionId returned by messageSubsession>',
            message: 'Continue with the Windows failure and keep your earlier findings.'
          }
        }
      ]
    },
    replyToSession: {
      action: 'replyToSession',
      purpose: 'Reply directly into one session that called you (an origin).',
      required: ['action', 'sessionId', 'message'],
      optional: [],
      rules: [
        '`sessionId` is one origin’s session id: the `Parent session` line of your # Agent block, the session your ' +
          'instructions tell you to report to, or one listed under "Sessions you can reply to". A background ' +
          'sub-session’s origin is the conversation that opened it. Never pass a `childSessionId` handle here.',
        'Several sessions can call one conversation, and each stays one you can answer, whichever called last. A ' +
          'reply reaches only the session it names — it is never broadcast and never redirected — so answer each ' +
          'session that needs it with its own call.',
        'The message is injected into that session; nothing is posted on a platform, and that session’s own ' +
          'reply keeps its visible route. Never post the answer at the origin conversation’s channel root instead: ' +
          'that starts a separate conversation.',
        'A background sub-session can reply to its parent any time — progress, a question, or its result — and a ' +
          'reply does not end its work; the daemon reports the end of each round of work itself.',
        'Only `action`, `sessionId`, and `message` are accepted.',
        'The result is {delivered, targetSession?, reason?} with no `ok` wrapper. A session that never called you ' +
          'returns {delivered: false, reason: "not_authorized"}; other reasons report admission or routing ' +
          'refusals. After a delivered result, end your turn without repeating the message.'
      ],
      examples: [
        {
          use: 'Return a result to your origin',
          arguments: {
            action: 'replyToSession',
            sessionId: '<Parent session id from your # Agent block>',
            message: 'Review complete: two issues found.'
          }
        },
        {
          use: 'A sub-session’s question to its parent',
          arguments: {
            action: 'replyToSession',
            sessionId: '<Parent session id from your # Agent block>',
            message: 'The failure is isolated. Should the repair preserve the old configuration format?'
          }
        }
      ]
    },
    postMessage: {
      action: 'postMessage',
      purpose: 'Post to a person, a channel, or another existing thread.',
      required: ['action', 'message', 'toUser or channel'],
      optional: ['toUser', 'channel', 'thread', 'platform', 'integrationId', 'attachment'],
      rules: [
        'Direct message: one human member id in `toUser`, without `channel`.',
        'Mention people in a channel: `toUser` (one id or an array of unique ids) plus `channel` posts one message at ' +
          'the channel root that @-mentions all of them. An array is never a group DM and requires `channel`.',
        '`toUser` names HUMAN platform members only — never an AgentConnect agent or your own bot identity.',
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
        'Not accepted: `toAgent`, `sessionId`, `needsReply`. If a result says a send MAY have been delivered, do ' +
          'not retry it.'
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
    notes.messageSubsession =
      'Unavailable here: this session is itself a background sub-session. Do the work here, or report back with ' +
      'replyToSession and let your parent delegate.'
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
