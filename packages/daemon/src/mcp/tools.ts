import type { Integration } from '../agents/agent-schema.js'
import { obj, unionOf, type JsonValue, type ToolDescriptor } from '../tool-schema/descriptor.js'
import { SESSION_TITLE_TOOL_NAME } from './session-title-tool.js'
import {
  allAttachmentReadTools,
  allPortPlatforms,
  attachmentReadToolsFor,
  platformsWithPort,
  type PlatformToolPort
} from '../platforms/read-ports.js'
import { EXTERNAL_MEMORY_TOOL_NAMES, MEMORY_TOOLS } from '../memory/tools.js'
import { BROKER_PIPELINE_STATUSES } from '../gitlab/broker.js'

/**
 * Session metadata fallback tools. Opt-in via `toolsForIntegrations`'s
 * `sessionTitle` option; no production runtime opts in anymore — Codex was the
 * last, until codex-acp >= 1.1.3 started emitting native session_info_update
 * titles itself (issue #659). The descriptor and its MCP handler stay so warm
 * ACP sessions created under the old Codex whitelist keep working until they
 * cycle out.
 */
export const SESSION_TOOLS: ToolDescriptor[] = [
  {
    name: SESSION_TITLE_TOOL_NAME,
    description:
      'Set the user-facing title for this AgentConnect session. Before your first substantive answer, after you ' +
      'understand the first meaningful request (ignore greetings and acknowledgements), call this once with a ' +
      'concise, specific title of about 3-8 words or a similarly short phrase. Call it again only if the task focus ' +
      'materially changes. If the user asks what the title is, set the exact title you give them. Do not mention this ' +
      'housekeeping call in your response.',
    inputSchema: obj(
      {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'A concise, specific session title (maximum 80 characters).'
        }
      },
      ['title']
    )
  }
]

/**
 * The single unified send tool (session-concept §3). It merges the former
 * `sendPlatformMessage` (post to a platform channel/user) and `messageAgent` (wake a peer
 * agent) into one tool, and also carries SessionTarget replies. Sending is not bound to the
 * platform that triggered the session: an agent may post on its current platform OR any OTHER
 * platform it is connected to. The daemon holds every bot token and picks the connection from
 * `platform` (+ optional `integrationId`); the model never sees a token. The `platform`
 * enum is narrowed at build time to the platforms this agent actually has (absent when the
 * agent has no platform integration — pure A2A / reply still work).
 *
 * There is NO visible in-thread form (send-message-routing-rework.md §2.1/§2.2). To address
 * an agent or a human in the CURRENT thread, the agent writes an ordinary turn reply
 * containing the platform-native mention — that reply already has the right channel,
 * thread, transport scope, streaming lifecycle, and sender identity, so a second sending
 * tool would only create a competing delivery path. This tool is therefore for what the
 * ordinary reply cannot do: a postless agent call, a direct message, a channel-root post,
 * or a parent-session reply. A visible send is always at the channel ROOT.
 */
function buildSendMessageTool(platforms: string[]): ToolDescriptor {
  const platform = {
    type: 'string',
    ...(platforms.length > 0 ? { enum: platforms } : {}),
    description:
      'Target platform for a visible send. Defaults to the current conversation’s platform; a `toUser` DM (`toUser` ' +
      'without `channel`) defaults to Slack.'
  }
  const integrationId = {
    type: 'string',
    minLength: 1,
    description: 'Optional. Pick a specific bot when the agent has multiple integrations on the target platform.'
  }
  const message = {
    type: 'string',
    minLength: 1,
    description: 'Message body, in standard Markdown (CommonMark/GFM).'
  }
  const channel = {
    type: 'string',
    minLength: 1,
    description:
      'Channel-root form: the target channel / chat id (Slack `C0123ABC`, Telegram/Discord/Feishu chat id). The post ' +
      'always lands at the channel ROOT, which opens a new conversation there — to speak in the thread you are ' +
      'already in, just write your ordinary reply.'
  }
  const attachment = {
    type: 'string',
    minLength: 1,
    description:
      'Optional. Forward an IMAGE this conversation received, by its name exactly as the `[attached: …]` ' +
      'marker spells it — this is how a RECEIVED picture reaches another platform. Images only, and only the ' +
      'one retained per message: a document, or a second image on the same message, is listed in the marker ' +
      'but cannot be forwarded. The daemon posts the bytes itself with `message` as the caption. To send a ' +
      'file you PRODUCED, use `shareFile` (current conversation only). The copy sent may be smaller than ' +
      'the original.'
  }

  // Mode 1 — toAgent: wake one AgentConnect agent. Two forms: postless (no channel, peers
  // only) and channel root (channel, peers or self). There is no in-thread form — an ordinary
  // reply that mentions the peer is how you address it in the current thread (§2.1).
  const agentTarget = {
    title: 'toAgent — send to an agent',
    description:
      'Wake exactly one AgentConnect agent, with two forms: direct (`{"toAgent":"<id>","message":"..."}`) delivers ' +
      'to a peer with nothing posted anywhere; channel root ' +
      '(`{"toAgent":"<id>","channel":"<C>","message":"..."}`) also posts one visible message at the channel root, ' +
      '@-mentions the target in it, and anchors the target to that post. The channel-root form may target YOURSELF: ' +
      'use your own AgentConnect ID from the # Agent block (never your Slack `U…` bot identity) to open and activate ' +
      'one new conversation there. The direct form may not target yourself. To reach an agent in the thread you are ' +
      'ALREADY in, do not use this tool — @-mention it in your ordinary reply instead. Either form takes ' +
      '`needsReply` (see `toAgent`), and you need it whenever you expect an answer back: the peer answers in ITS ' +
      'OWN conversation, so without `needsReply` nothing comes back to you.',
    ...obj(
      {
        toAgent: {
          description:
            'The AgentConnect agent to wake. For a peer, use the BARE agent id only for fire-and-forget work whose ' +
            'outcome you never need; ' +
            'use `{"agentId":"<agent id>","needsReply":true}` whenever you expect anything back. Set `needsReply` ' +
            'if your `message` asks a question or requests a result, if you were asked to relay the peer’s answer ' +
            'to someone, or if you intend to act on the outcome — "reply to me", "tell me", "check X and report" ' +
            'all qualify. A woken peer answers inside ITS OWN conversation, so without `needsReply` its answer ' +
            'never reaches you or the humans waiting in yours, and you are not even told that it failed. With it, ' +
            'the peer’s session carries a standing instruction to reply into YOUR session when it finishes or ' +
            'fails. The result tells you to end the current turn and wait; use `viewSessionStatus` on the returned ' +
            '`childSessionId` only for optional diagnostics. To ' +
            'open a new channel-root conversation with YOURSELF, pass your own ID from the # Agent block together ' +
            'with `channel`; a self target without `channel` is rejected.',
          oneOf: [
            {
              type: 'string',
              minLength: 1,
              title: 'Agent id',
              description:
                'AgentConnect agent id from listAgents or the [agent-id] sender envelope. Never a platform ' +
                'member id such as Slack `U…`.'
            },
            {
              title: 'Agent id with delivery options',
              ...obj(
                {
                  agentId: {
                    type: 'string',
                    minLength: 1,
                    description:
                      'AgentConnect agent id from listAgents or the [agent-id] sender envelope. Never a ' +
                      'platform member id such as Slack `U…`.'
                  },
                  needsReply: {
                    type: 'boolean',
                    description:
                      'Set true whenever you expect an answer, a result, or a completion signal: the woken session ' +
                      'is told to report back into this session (done or failed) when it completes. Defaults to ' +
                      'false, which is fire-and-forget — the peer’s answer stays in its own conversation and you ' +
                      'learn nothing, not even that it failed.'
                  }
                },
                ['agentId']
              )
            }
          ]
        },
        channel,
        message
      },
      ['toAgent', 'message']
    )
  }

  // Mode 2 — toUser: reach one or more human platform members. DM stays singular (one string,
  // no channel); the channel-root send accepts either one id or an array and @-mentions
  // every named user in the one visible post.
  const userTarget = {
    title: 'toUser — send to platform users',
    description:
      'Reach HUMAN platform members (Slack only for now), never an AgentConnect agent or your own bot identity. ' +
      'The dm form takes exactly one id ' +
      '(`{"toUser":"<id>","message":"..."}`). The channel-root form accepts either one id or a non-empty id ' +
      'array; `{"toUser":["<id-1>","<id-2>"],"channel":"<C>","message":"..."}` posts one message at the channel ' +
      'root that @-mentions every listed user. To reach someone in the thread you are already in, @-mention them ' +
      'in your ordinary reply instead.',
    ...obj(
      {
        toUser: {
          description:
            'One HUMAN platform member id, or a non-empty array of unique human ids for a channel-root post. ' +
            'Do not put an AgentConnect agent or your own Slack bot `U…` identity here; use `toAgent` for agents. ' +
            'An array is not a group DM: it requires `channel` and @-mentions all listed users in one message.',
          oneOf: [
            {
              type: 'string',
              minLength: 1,
              description: 'One platform member id, such as Slack `U0123ABC`.'
            },
            {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1
              },
              description:
                'Platform member ids to @-mention together. Valid only when `channel` is also supplied; never a DM.'
            }
          ]
        },
        channel,
        platform,
        integrationId,
        attachment,
        message
      },
      ['toUser', 'message']
    )
  }

  // Bare channel post: publish a visible message without waking an agent or addressing a human.
  const channelTarget = {
    title: 'Channel post (no recipient)',
    description:
      'Publish one visible message at a platform channel’s ROOT without waking an agent or @-mentioning a human. ' +
      'This opens a NEW conversation of your own on that post — it never continues an existing thread.',
    ...obj(
      {
        channel,
        platform,
        integrationId,
        attachment,
        message
      },
      ['channel', 'message']
    )
  }

  // Separate reply branch: inject directly into the parent/origin session (session-concept §5.2).
  const sessionTarget = {
    title: 'Parent session reply',
    description:
      'Reply directly into the parent/origin session that woke this session. This is how an answer reaches the ' +
      'conversation that asked for it — posting it at that conversation’s channel ROOT instead would start a new one.',
    ...obj(
      {
        sessionId: {
          type: 'string',
          minLength: 1,
          description: 'The `Parent session` id from your `# Agent` block.'
        },
        correlationId: {
          type: 'string',
          minLength: 1,
          description:
            'Optional advanced override. Normally omit it so the daemon inherits reply correlation automatically.'
        },
        message
      },
      ['sessionId', 'message']
    )
  }

  return {
    name: 'sendMessage',
    description:
      'Send one message using exactly one target mode: an AgentConnect agent (`toAgent`), human users (`toUser`), a channel ' +
      'with no recipient, or the parent-session reply.\n' +
      'TO SPEAK IN THE CONVERSATION YOU ARE ALREADY IN — including to address a peer agent or a human there — do ' +
      'NOT use this tool. Write your ordinary turn reply and @-mention them in it (use `listAgents` to get an ' +
      'agent’s exact `mention` token); to put an IMAGE there, use `shareFile`. That reply already goes to the ' +
      'right thread as you. This tool is only for ' +
      'what it cannot do: reaching a DIFFERENT conversation, a direct message, a postless agent call, or a reply ' +
      'into the parent session.\n' +
      '- toAgent — wake exactly one AgentConnect agent (id from listAgents or your own # Agent ID; never a ' +
      'platform member id):\n' +
      '  • direct: `{"toAgent":"<agent id>","message":"..."}` — postless PEER wake: nothing is posted anywhere; ' +
      'this form cannot target yourself.\n' +
      '  • channel root: `{"toAgent":"<agent id>","channel":"<channel id>","message":"..."}` — also posts one ' +
      'visible message at that channel’s ROOT, @-mentions the target, and anchors it to that post. This form MAY ' +
      'target yourself: use your own # Agent ID to open and activate one new conversation there.\n' +
      '  Use `{"toAgent":{"agentId":"<agent id>","needsReply":true},"message":"..."}` WHENEVER you expect an answer ' +
      'back — your message asks a question or requests a result, or someone asked you to relay the peer’s answer. ' +
      'The peer replies in its own conversation, so without `needsReply` its answer never reaches you. Follow the ' +
      'returned `nextAction`; use `viewSessionStatus` only for optional diagnostics.\n' +
      '- toUser — reach HUMAN users (Slack only for now), never an AgentConnect agent or your own bot identity:\n' +
      '  • dm: `{"toUser":"<Slack user id>","message":"..."}` — direct message; do not set `channel`.\n' +
      '  • channel root: `{"toUser":["<user id 1>","<user id 2>"],"channel":"<channel id>","message":"..."}` — ' +
      'posts once at the channel root and @-mentions every listed user; a single id string also works.\n' +
      '- Channel (bare post, no recipient): `{"channel":"<channel id>","message":"..."}` — posts at the channel ' +
      'root without waking anyone or @-mentioning anyone; add `platform` or `integrationId` only when needed.\n' +
      '- attachment (with `toUser` or `channel`) — forward an image this conversation received: ' +
      '`{"channel":"<channel id>","attachment":"<file name>","message":"..."}`. The name is the one in the ' +
      '`[attached: …]` marker. This is the only way a RECEIVED image reaches another platform; for an image you ' +
      'produced, `shareFile` posts it into the current conversation.\n' +
      '- Parent session reply: `{"sessionId":"<Parent session>","message":"..."}` — relay an answer back to whoever ' +
      'asked this way, never by posting it at their channel root.\n' +
      'Every visible send lands at the channel ROOT and opens a NEW conversation of your own there. Write ' +
      '`message` as CommonMark/GFM. The daemon supplies your identity; you cannot impersonate anyone. A self ' +
      'wake is valid only in the explicit `toAgent` channel-root form above.',
    inputSchema: unionOf([agentTarget, userTarget, channelTarget, sessionTarget])
  }
}

/**
 * Channel/user READ helpers, injected when an agent has any platform integration.
 * Like {@link buildSendMessageTool}, these are platform-neutral: a
 * `platform` argument routes the read to ANY platform the agent is connected to
 * (so an agent handling a Telegram chat can discover Slack channel/user ids to
 * cross-post to). `platform` defaults to the current conversation's platform.
 * The enum is narrowed at build time to the agent's own platforms. Sending is
 * handled separately by {@link buildSendMessageTool}; per-platform credentialed
 * file downloads by whichever platforms declare that read port
 * ({@link attachmentReadToolsFor}).
 */
/**
 * `shareFile` — post a workspace image into the CURRENT conversation
 * (docs/designs/agent-authored-attachments.md §3). The one visible send that is NOT
 * `sendMessage`'s job: every `sendMessage` post lands at a channel ROOT, while this places
 * a file in the thread the agent is already answering. No coordinates by construction —
 * the daemon posts from the trusted active-turn context.
 */
function buildShareFileTool(): ToolDescriptor {
  return {
    name: 'shareFile',
    description:
      'Post an IMAGE from your workspace into THIS conversation — the thread you are answering right now. This is ' +
      'the only way to show someone a file you produced or downloaded: your ordinary reply is text-only, and ' +
      '`sendMessage` posts to channel roots, never here. `path` is relative to your workspace root; put files there ' +
      'first. Images only (PNG, JPEG, or WEBP — not GIF), decided from the file bytes, not the name. The optional ' +
      '`caption` is plain text (max 1000 chars; mention syntax is neutralized, though a bare Telegram @username ' +
      'may still notify); write everything else in your ordinary ' +
      'reply. The image posts immediately, so it may appear before your streamed reply finishes. If the result says ' +
      'the upload MAY have been delivered, do NOT retry — report that instead.',
    inputSchema: obj(
      {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Workspace-relative path to the image (e.g. `out/chart.png`). Absolute paths and `..` are rejected.'
        },
        caption: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          description: 'Optional short plain-text caption posted with the image.'
        }
      },
      ['path']
    )
  }
}

function buildReadTools(platforms: string[], currentPlatform?: string): ToolDescriptor[] {
  const platform = {
    type: 'string',
    enum: platforms,
    description:
      "The IM platform to target. Defaults to the current conversation's platform. Set it to another platform this " +
      'agent is connected to — e.g. list Slack channels while handling a Telegram chat.'
  }
  // Mirrors sendMessage: pick a specific bot when the agent has more than one
  // integration on the same platform. Defaults to the current session's bot, else the first.
  const integrationId = {
    type: 'string',
    description: 'Optional. Pick a specific bot when the agent has multiple integrations on the target platform.'
  }
  // Channel history has no target selector, so only the current session platform may enable it.
  const historyPlatform = currentPlatform ?? (platforms.length === 1 ? platforms[0] : undefined)
  const hasChannelHistory =
    historyPlatform !== undefined && platformsWithPort('channelHistory', [historyPlatform]).length > 0
  // Everything else routes by `platform`, so the gate is "any of this agent's platforms
  // declares the port" and the enum narrows to exactly those. No declarer ⇒ no tool.
  const portPlatform = (port: PlatformToolPort) => {
    const declaring = platformsWithPort(port, platforms)
    return declaring.length === 0 ? undefined : { ...platform, enum: declaring }
  }
  return [
    {
      name: 'getCurrentChannel',
      description:
        'Return the channel/chat (and thread/topic) THIS conversation is bound to, including its name when available.',
      inputSchema: obj({})
    },
    {
      name: 'listChannels',
      description:
        'List the channels/chats the bot can post to on a platform, each with its id and name. Pass `platform` to ' +
        'target one of the platforms this agent is connected to (defaults to the current one), and `integrationId` ' +
        'to choose a specific bot when the agent has several on that platform. Note: Telegram bots cannot enumerate ' +
        'their chats live, so there Telegram returns the chats this agent has already been active in (from history); ' +
        'the result `source` is "live" or "observed" accordingly. The observed fallback is suppressed when the agent ' +
        'has multiple bots on the platform (history is not attributable to one bot).',
      inputSchema: obj({ platform, integrationId })
    },
    ...(hasChannelHistory
      ? [
          {
            name: 'getChannelHistory',
            description:
              'Read one bounded page of messages from the channel bound to this conversation. This tool is ' +
              'intentionally limited to the current context channel and accepts no channel, platform, or ' +
              'integration selector. Results are newest-first; pass nextCursor as cursor to continue with older ' +
              'messages. This returns channel messages, not replies inside a thread.',
            inputSchema: obj({
              cursor: { type: 'string', description: 'Cursor returned by the previous page.' },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 200,
                description: 'Number of messages to request (max 200; the provider may return a smaller page).'
              },
              oldest: { type: 'string', description: 'Inclusive oldest message timestamp bound.' },
              latest: { type: 'string', description: 'Inclusive latest message timestamp bound.' }
            })
          }
        ]
      : []),
    {
      name: 'listKnownUsers',
      description:
        'List the users this agent has already interacted with on a platform (from past DMs/messages), each with ' +
        'their id and name when known. Use this to find a user id to DM on a platform that has no directory to ' +
        'search (Telegram/Discord). Pass `platform` to target a connected platform (defaults to the current one). ' +
        'Returns an empty list with a `note` when the agent has multiple bots on the platform, since observed history ' +
        'is not tracked per bot.',
      inputSchema: obj({ platform })
    },
    {
      name: 'listChannelMembers',
      description:
        'List the platform users and bot accounts in a channel/chat (id, name, is_bot) — the way to discover a HUMAN ' +
        'user id to @mention or DM. This is NOT how you find peer AI agents to collaborate with: it returns raw ' +
        'platform member accounts (including unrelated bots), not AgentConnect agents — use `listAgents` for ' +
        '"the agents in this channel". Pass `platform` to target another connected platform and `integrationId` to ' +
        'choose a specific bot; omit `channel` to use the current conversation (same platform only). Note: Telegram ' +
        'only exposes administrators for large groups.',
      inputSchema: obj({
        platform,
        integrationId,
        channel: {
          type: 'string',
          description:
            'Channel/chat id. Required when `platform` differs from the current conversation; defaults to the current channel otherwise.'
        }
      })
    },
    {
      name: 'getUserProfile',
      description:
        'Look up a user or bot by id on a platform, returning their display name, real name, and bot flag. Pass ' +
        '`platform` to target another connected platform, and `integrationId` to choose a specific bot when the ' +
        'agent has several on that platform.',
      inputSchema: obj(
        {
          platform,
          integrationId,
          user: { type: 'string', description: 'Platform user id (Slack U0123ABC, Telegram/Discord numeric id).' }
        },
        ['user']
      )
    },
    ...buildThreadHistoryTool(portPlatform('threadHistory'), integrationId),
    ...buildReactionTools(portPlatform('reactions'), integrationId),
    ...buildConversationCreateTool(portPlatform('conversationCreate'), integrationId),
    ...buildScheduleMessageTool(portPlatform('scheduledMessages'), integrationId),
    ...buildCanvasTools(portPlatform('canvas'), integrationId)
  ]
}

/** One property schema inside a tool's `inputSchema` — what the shared `platform` /
 *  `integrationId` selectors are, and what a port gate hands the builders below. */
type SchemaProp = Record<string, JsonValue>

/** The channel selector shared by every platform-routed tool below: the current
 *  conversation's channel by default, and required once `platform` names another one. */
const targetChannel = {
  type: 'string',
  description:
    'Channel/chat id. Defaults to this conversation’s channel; required when `platform` names a different platform.'
}

/** `getThreadHistory` — the same provider thread read the daemon already uses to rebuild
 *  mid-thread context, handed to the agent. Reads a thread the agent is NOT answering,
 *  which is the one thing the ordinary turn context cannot show it. */
function buildThreadHistoryTool(platform: SchemaProp | undefined, integrationId: SchemaProp): ToolDescriptor[] {
  if (!platform) return []
  return [
    {
      name: 'getThreadHistory',
      description:
        'Read one thread in full — its root message and every reply. Use it to catch up on a discussion you are not ' +
        'part of: `getChannelHistory` reports each message’s `threadTs` and `replyCount`, and this opens one of ' +
        'them. `thread` is the root message’s id (Slack thread_ts). Results are oldest-first; `truncated` is true ' +
        'when the thread is longer than `limit`. Your own status chrome is filtered out.',
      inputSchema: obj(
        {
          platform,
          integrationId,
          channel: targetChannel,
          thread: { type: 'string', description: 'Root message id of the thread (Slack thread_ts).' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum messages to return, oldest-first (default 100, max 200).'
          },
          oldest: { type: 'string', description: 'Inclusive oldest message timestamp bound.' },
          latest: { type: 'string', description: 'Inclusive latest message timestamp bound.' }
        },
        ['thread']
      )
    }
  ]
}

/** `addReaction` / `getReactions` — the emoji comes from the MODEL, which knows what platform
 *  it is on, unlike the turn-chrome `react` intent core names for it. */
function buildReactionTools(platform: SchemaProp | undefined, integrationId: SchemaProp): ToolDescriptor[] {
  if (!platform) return []
  const messageTs = { type: 'string', description: 'Id of the message to act on (Slack ts).' }
  return [
    {
      name: 'addReaction',
      description:
        'Put an emoji reaction on one message — the lightweight acknowledgement that needs no reply. `emoji` is the ' +
        'platform’s own name for it WITHOUT colons (`thumbsup`, `eyes`, `white_check_mark`). Reacting twice with ' +
        'the same emoji is not an error. This reacts as the bot, not under your agent identity.',
      inputSchema: obj(
        {
          platform,
          integrationId,
          channel: targetChannel,
          messageTs,
          emoji: { type: 'string', description: 'Emoji name without colons, e.g. `thumbsup`.' }
        },
        ['messageTs', 'emoji']
      )
    },
    {
      name: 'getReactions',
      description:
        'List the emoji reactions already on one message, each with its count and — where the platform reports them ' +
        '— the users who reacted. Use it to read a poll or a lightweight approval someone ran with emoji.',
      inputSchema: obj({ platform, integrationId, channel: targetChannel, messageTs }, ['messageTs'])
    }
  ]
}

/** `createConversation` — the one tool here that creates durable workspace state. */
function buildConversationCreateTool(platform: SchemaProp | undefined, integrationId: SchemaProp): ToolDescriptor[] {
  if (!platform) return []
  return [
    {
      name: 'createConversation',
      description:
        'Create a channel, or open the direct conversation with a set of people, and return its id for ' +
        '`sendMessage`. Two shapes: pass `name` for a channel (optionally `isPrivate`, and `users` to invite), or ' +
        'pass `users` ALONE for a direct message (one user) or group direct message (two or more). This makes ' +
        'workspace state that outlives the task and everyone can see, so only do it when someone asked for it — ' +
        'to reach people who already share a channel with you, post there instead.',
      inputSchema: obj({
        platform,
        integrationId,
        name: {
          type: 'string',
          description: 'Channel name (lowercase, hyphens). Omit to open a direct conversation with `users`.'
        },
        isPrivate: { type: 'boolean', description: 'Create the channel private. Only meaningful with `name`.' },
        users: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 100,
          description: 'Platform user ids: the invitees with `name`, or the conversation members without it.'
        }
      })
    }
  ]
}

/** `scheduleMessage` — a channel-root post the PLATFORM delivers later. Deliberately has no
 *  thread form, for the same reason `sendMessage` has none (send-message-routing-rework.md §2.2). */
function buildScheduleMessageTool(platform: SchemaProp | undefined, integrationId: SchemaProp): ToolDescriptor[] {
  if (!platform) return []
  return [
    {
      name: 'scheduleMessage',
      description:
        'Hand the platform a message to post at a FUTURE time. Nothing is posted now. Use it for something that ' +
        'must land at a wall-clock moment; for work that has to run later, an AgentConnect cron wakes you instead ' +
        'and can decide what to say then. `postAt` is an ISO-8601 instant WITH an offset (`2026-09-01T09:00:00+08:00`), ' +
        'at least 2 minutes out and at most 120 days. The post lands at the channel root under the bare bot ' +
        'identity — the platform will not carry your agent name or icon on it — and it opens no conversation you ' +
        'can be replied into; a reply reaches you as an ordinary new message.',
      inputSchema: obj(
        {
          platform,
          integrationId,
          channel: targetChannel,
          message: { type: 'string', minLength: 1, description: 'The message body, as CommonMark/GFM.' },
          postAt: { type: 'string', description: 'ISO-8601 instant with offset, e.g. `2026-09-01T09:00:00+08:00`.' }
        },
        ['message', 'postAt']
      )
    }
  ]
}

/** `createCanvas` / `readCanvas` / `updateCanvas` — the platform's own rich-text page, which
 *  outlives a message and can be edited in place (Slack Canvas). */
function buildCanvasTools(platform: SchemaProp | undefined, integrationId: SchemaProp): ToolDescriptor[] {
  if (!platform) return []
  const canvasId = { type: 'string', description: 'Id of the canvas (Slack F0123ABC).' }
  const markdownRules =
    'Markdown is the platform’s own dialect: headings `#`/`##`/`###` only, no headings or code blocks inside list ' +
    'items, `![](@U0123ABC)` for a user and `![](#C0123ABC)` for a channel, `:tada:` for emoji.'
  return [
    {
      name: 'createCanvas',
      description:
        'Create a canvas — a rich-text page the platform hosts, for something that outlives a message and gets ' +
        'edited rather than reposted: a running plan, a spec, a report the team keeps returning to. Returns its id ' +
        'and link; post the link yourself. Pass `channel` to tab it onto a conversation. ' +
        markdownRules,
      inputSchema: obj(
        {
          platform,
          integrationId,
          title: { type: 'string', minLength: 1, maxLength: 255, description: 'Canvas title.' },
          markdown: { type: 'string', minLength: 1, description: 'Canvas body.' },
          channel: { type: 'string', description: 'Optional conversation to tab the canvas onto.' }
        },
        ['title', 'markdown']
      )
    },
    {
      name: 'readCanvas',
      description:
        'Read a canvas back: its title, link, markdown body, and the section ids an anchored edit can target. ' +
        'Always call this immediately before `updateCanvas` — section ids CHANGE every time a canvas is edited, so ' +
        'one from an earlier turn is stale and must never be reused. Two limits worth knowing: only HEADING ' +
        'sections get an id, so an anchored edit can address a heading but not an arbitrary paragraph, and the body ' +
        'is absent (rather than empty) when the platform would not serve it — the canvas still exists.',
      inputSchema: obj({ platform, integrationId, canvasId }, ['canvasId'])
    },
    {
      name: 'updateCanvas',
      description:
        'Edit a canvas in place. Each change is one operation: `replace` with no `sectionId` rewrites the whole ' +
        'body, and `insert_before`/`insert_after`/`delete` need a `sectionId` from `readCanvas`. Every anchored ' +
        'edit needs a FRESH `readCanvas` first: section ids change on every edit, so reusing one from an earlier ' +
        'turn — or from before your own previous `updateCanvas` — targets the wrong place or fails. ' +
        markdownRules,
      inputSchema: obj(
        {
          platform,
          integrationId,
          canvasId,
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                operation: {
                  type: 'string',
                  enum: ['replace', 'insert_at_start', 'insert_at_end', 'insert_before', 'insert_after', 'delete']
                },
                sectionId: { type: 'string', description: 'Required by the anchored operations and by `delete`.' },
                markdown: { type: 'string', description: 'Required by everything except `delete`.' }
              },
              required: ['operation'],
              additionalProperties: false
            },
            description: 'The changes to apply, in order.'
          }
        },
        ['canvasId', 'edits']
      )
    }
  ]
}

export const KNOWLEDGE_TOOLS: ToolDescriptor[] = [
  {
    name: 'findKnowledge',
    description:
      'Search owner-approved organization knowledge on demand. Use this for shared conventions, architecture, runbooks, and decisions that may apply across agents. Results are revisioned Markdown; no organization content is injected automatically.',
    inputSchema: obj(
      {
        query: { type: 'string', minLength: 1, maxLength: 4096, description: 'What shared knowledge to find.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional result count (default 5).' },
        tags: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'Optional tags every result should match.'
        }
      },
      ['query']
    )
  },
  {
    name: 'listKnowledge',
    description:
      'List recent owner-approved organization knowledge (no query) to see what already exists before proposing new. Results are revisioned Markdown metadata; pair with findKnowledge to search by topic.',
    inputSchema: obj({
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Optional result count (default 10).' },
      tags: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 64 },
        description: 'Optional tags every result should match.'
      }
    })
  },
  {
    name: 'listOrgSkills',
    description:
      'List or search accepted organization skills (managed skill bundles) to see which already exist — so you update an existing one instead of proposing a duplicate. Returns metadata only (id, name, description, revision); omit `query` to list, or pass it to filter by name/description.',
    inputSchema: obj({
      query: { type: 'string', minLength: 1, maxLength: 4096, description: 'Optional filter over name/description.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Optional result count (default 20).' }
    })
  }
]

/**
 * Agent-collaboration tools — available to EVERY agent regardless of platform
 * (discovery is org-level, not platform- or channel-gated). `listAgents` asks the CP
 * which peers this agent may reach in its organization so it can find someone to work
 * with; channel membership is only an optional filter on that answer. Waking a peer is
 * no longer a separate tool: it is `sendMessage` with `toAgent` (session-concept §4).
 * The requesting agent's identity is injected by the daemon from the session context —
 * it is NOT a tool input. Fan-out is likewise not a separate tool: the orchestration
 * triple is retired, see {@link RETIRED_ORCHESTRATION_TOOLS}.
 */
const LIST_AGENTS_INPUT_SCHEMA = () =>
  obj({
    channel: {
      type: 'string',
      description:
        'OPTIONAL filter: only list agents present in this channel/chat. Omit to list every agent you can reach.'
    }
  })

const LIST_AGENTS_DESCRIPTION =
  'List the AI agents you can work with — INCLUDING YOURSELF — with their id, name, displayName, description, and ' +
  'status, so you ' +
  'can discover peers to collaborate with. By DEFAULT this lists every agent in your organization that you are ' +
  'allowed to reach, whether or not it shares a channel with you. This is the canonical meaning of "the agents ' +
  'here": whenever you are asked to greet, message, collaborate with, or delegate to the agents/peers around you, ' +
  'discover them with THIS tool — NOT `listChannelMembers` (which lists platform user/bot accounts, not ' +
  'AgentConnect agents). Then reach each PEER with `sendMessage` using ' +
  '`{"toAgent":"<agent id>","message":"..."}` (a direct, postless wake), rather than @mentioning member ids ' +
  'in a channel post. Pass `channel` only as a FILTER, to narrow the list to the agents present in that channel. ' +
  'Only agents you are allowed to reach are returned. Your own entry is included so you can use its agent id with ' +
  '`toAgent` + `channel` to open and activate a new channel-root conversation with yourself; a postless self-call ' +
  'is rejected.'

export const COLLABORATION_TOOLS: ToolDescriptor[] = [
  {
    name: 'listAgents',
    description: LIST_AGENTS_DESCRIPTION,
    inputSchema: LIST_AGENTS_INPUT_SCHEMA()
  },
  {
    // Kept so a session already warm with the old tool set (and prompts/skills that
    // learned the old name) keeps working; the daemon routes both names to one handler.
    name: 'listChannelAgents',
    description: `Deprecated alias of \`listAgents\` — prefer that name. ${LIST_AGENTS_DESCRIPTION}`,
    inputSchema: LIST_AGENTS_INPUT_SCHEMA()
  },
  {
    name: 'viewSessionStatus',
    description:
      'Read execution and reply-delivery state for a child session YOU started. Pass the `childSessionId` returned ' +
      'by `sendMessage`, then follow the returned `nextAction`. This is diagnostic only; it never returns the reply body.',
    inputSchema: obj(
      {
        sessionId: {
          type: 'string',
          minLength: 1,
          description: 'The `childSessionId` returned by the `sendMessage` call that started the session.'
        }
      },
      ['sessionId']
    )
  }
]

/**
 * RETIRED from the advertised tool surface — kept here, and still dispatchable by
 * `executeTool`, but injected into NO agent's tool set.
 *
 * Why: the send half duplicated `sendMessage`. A fan-out to N workers is N
 * `sendMessage({ toAgent: { agentId, needsReply: true } })` calls, and status lookup is
 * `viewSessionStatus`. Offering both made "give work to another agent" ambiguous, so the
 * orchestration triple is no longer offered.
 *
 * What is NOT retired: the daemon-side machinery behind these names — the durable
 * orchestration/subtask records, correlation recording on worker reports, and the one-shot
 * session-anchored DEADLINE WAKE (re-armed from the store on daemon startup). That deadline
 * is the one capability `sendMessage(needsReply)` cannot express today (it has no timeout),
 * and it is kept intact so `needsReply` can gain an optional deadline on top of it.
 *
 * These descriptors stay dispatchable and stay in {@link ALL_TOOL_NAMES} on purpose: an ACP
 * session that went warm with the old descriptors, and any orchestration record that is
 * still in flight, must keep resolving. Re-enabling is a one-line move back into
 * {@link COLLABORATION_TOOLS}.
 */
export const RETIRED_ORCHESTRATION_TOOLS: ToolDescriptor[] = [
  {
    name: 'startOrchestration',
    description:
      'Fan out a batch of subtasks to worker agents in one atomic step, then wait asynchronously. ' +
      'The daemon persists an orchestration record (all subtasks pending) BEFORE delivering, delivers each ' +
      'subtask to its worker (attaching a correlationId so their replies map back), and schedules a one-shot ' +
      'deadline that wakes THIS session when it fires. Returns { orchestrationId, delivered:[correlationId…], ' +
      'failed:[{correlationId, reason}…] }. This does NOT return the workers’ results — you are woken (by a ' +
      'worker reply or the deadline) and then call getOrchestration to read statuses/results and summarize. ' +
      'Tell each worker in its `text` to report back to you when done (their reply auto-carries the correlationId).',
    inputSchema: obj(
      {
        subtasks: {
          type: 'array',
          description: 'The subtasks to fan out, one per worker delivery.',
          items: obj(
            {
              toAgentId: { type: 'string', description: 'The worker agent id to deliver this subtask to.' },
              text: { type: 'string', description: 'The instruction delivered into the worker’s session.' }
            },
            ['toAgentId', 'text']
          )
        },
        deadlineMs: {
          type: 'number',
          description:
            'Optional deadline in milliseconds from now. When it elapses, your session is woken so you can ' +
            'summarize partial results; unreported subtasks are marked timed_out. Omit for no deadline.'
        },
        replyTarget: {
          type: 'string',
          description: 'Optional opaque marker for where you should post the final human-facing summary.'
        }
      },
      ['subtasks']
    )
  },
  {
    name: 'getOrchestration',
    description:
      'Read one of YOUR orchestrations — its subtasks with per-subtask status (pending/sending/delivered/' +
      'succeeded/worker_error/timed_out) and any collected results. Call this each time you are woken (by a ' +
      'worker report or the deadline) to judge whether all subtasks are in (N-of-N) or the deadline passed, ' +
      'then summarize. Only the orchestration’s owning main agent+session may read it.',
    inputSchema: obj(
      { orchestrationId: { type: 'string', description: 'The orchestrationId returned by startOrchestration.' } },
      ['orchestrationId']
    )
  },
  {
    name: 'cancelOrchestration',
    description:
      'Cancel one of YOUR orchestrations: cancels its pending deadline and writes a cancelled tombstone (the ' +
      'record is kept, not deleted). Already-delivered workers are not recalled — a late report from them after ' +
      'cancellation is ignored. Only the owning main agent+session may cancel.',
    inputSchema: obj(
      { orchestrationId: { type: 'string', description: 'The orchestrationId returned by startOrchestration.' } },
      ['orchestrationId']
    )
  }
]

/**
 * Formal code-host review effect (gitlab-com-integration.md §15). The descriptor
 * may remain attached to a long-lived per-thread ACP session, but availability is
 * not authorization: execution resolves the daemon-private active hook turn, routes
 * to that turn's code host, and fails closed for every ordinary/non-review turn.
 * The target is intentionally absent.
 */
export const GITHUB_REVIEW_TOOLS: ToolDescriptor[] = [
  {
    name: 'submitCodeReview',
    description:
      'Submit the formal review for the active pull-request or merge-request hook turn. The repository or project, ' +
      'the pull/merge request, and the commit are fixed by trusted turn metadata and cannot be selected here. Use ' +
      'COMMENT for a formal non-blocking review, REQUEST_CHANGES for a failing review, or APPROVE for a passing ' +
      'review; REQUEST_CHANGES requires verdict fail and APPROVE requires verdict pass. On GitLab, REQUEST_CHANGES ' +
      'is available only while the project service account is already a current reviewer — otherwise record the ' +
      'finding with COMMENT and verdict fail. This tool is unavailable outside an authorized active review hook ' +
      'turn, and at most one review can be submitted per turn. The review body is the complete public response: ' +
      'once an attempt starts, only a definite not_submitted result preserves the ordinary-comment fallback.',
    inputSchema: obj(
      {
        event: { type: 'string', enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] },
        verdict: { type: 'string', enum: ['pass', 'fail', 'neutral'] },
        body: {
          type: 'string',
          minLength: 1,
          description:
            'Complete, self-contained top-level public review summary. Required and non-empty for every event, including APPROVE.'
        },
        comments: {
          type: 'array',
          description: 'Optional inline review comments, submitted atomically with the top-level review.',
          items: obj(
            {
              path: { type: 'string' },
              body: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
              startLine: { type: 'integer', minimum: 1 },
              startSide: { type: 'string', enum: ['LEFT', 'RIGHT'] }
            },
            ['path', 'body', 'line', 'side']
          )
        }
      },
      ['event', 'verdict', 'body']
    )
  },
  {
    name: 'replyGithubReviewThreads',
    description:
      'Reply to every inline thread in the active batched GitHub review-comment turn. The authorized thread roots ' +
      'are fixed by signature-verified webhook metadata: supply exactly one non-empty reply for every root listed ' +
      'in the prompt, with no extra roots. This tool is unavailable outside that active batch and can be called at most once.',
    inputSchema: obj(
      {
        replies: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: obj(
            {
              threadRootCommentId: {
                type: 'string',
                pattern: '^[1-9][0-9]*$',
                description: 'Trusted decimal thread-root id copied from the active batch prompt.'
              },
              body: { type: 'string', minLength: 1, description: 'Complete public reply for this review thread.' }
            },
            ['threadRootCommentId', 'body']
          )
        }
      },
      ['replies']
    )
  }
]

/**
 * The provider-neutral code-host effect surface (gitlab-com-integration.md §14.2),
 * GitLab-backed today. Each tool maps to ONE allowlisted endpoint and method; the
 * project is resolved from trusted daemon state and the effect token never enters
 * the agent environment. Availability is not authorization: every call is refused
 * below its clamped capability, and read/comment/write are the §13.1 classes.
 */
export const CODE_HOST_EFFECT_TOOLS: ToolDescriptor[] = [
  {
    name: 'createCodeHostComment',
    description:
      'Post one comment on an issue or merge request in the code-host project this session is bound to. The project ' +
      'is fixed by trusted session state and cannot be selected here. Requires comment authority. Returns the ' +
      'created comment id, which is the only id `updateCodeHostComment` will accept later in this session.',
    inputSchema: obj(
      {
        subject: {
          type: 'string',
          enum: ['issue', 'merge_request'],
          description: 'Which subject family to comment on.'
        },
        iid: { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' },
        body: { type: 'string', minLength: 1, description: 'Complete Markdown comment body.' }
      },
      ['subject', 'iid', 'body']
    )
  },
  {
    name: 'updateCodeHostComment',
    description:
      'Rewrite a comment THIS session created through the broker. Any other comment is refused, so the single ' +
      'author of a brokered comment stays its only editor. Requires comment authority.',
    inputSchema: obj(
      {
        subject: { type: 'string', enum: ['issue', 'merge_request'] },
        iid: { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' },
        noteId: {
          type: 'string',
          pattern: '^[1-9][0-9]*$',
          description: 'The comment id returned by an earlier createCodeHostComment or replyCodeHostDiscussion call.'
        },
        body: { type: 'string', minLength: 1, description: 'The complete replacement body.' }
      },
      ['subject', 'iid', 'noteId', 'body']
    )
  },
  {
    name: 'readCodeHostDiscussions',
    description:
      'Read the discussion threads on an issue or merge request. Omit `discussionId` for a bounded list of the ' +
      'subject’s threads, or supply one to read that single thread. Read-only, so a read-level authorization is enough.',
    inputSchema: obj(
      {
        subject: { type: 'string', enum: ['issue', 'merge_request'] },
        iid: { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' },
        discussionId: { type: 'string', description: 'Read exactly this thread; omit to list the subject’s threads.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum threads to list (default 20).' }
      },
      ['subject', 'iid']
    )
  },
  {
    name: 'replyCodeHostDiscussion',
    description:
      'Add one reply to an existing discussion thread on an issue or merge request. Use this instead of a new ' +
      'top-level comment when answering in place. Requires comment authority.',
    inputSchema: obj(
      {
        subject: { type: 'string', enum: ['issue', 'merge_request'] },
        iid: { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' },
        discussionId: { type: 'string', description: 'The thread id from readCodeHostDiscussions.' },
        body: { type: 'string', minLength: 1, description: 'Complete Markdown reply body.' }
      },
      ['subject', 'iid', 'discussionId', 'body']
    )
  },
  {
    name: 'createCodeHostMergeRequest',
    description:
      'Open a merge request in this session’s project from an already-pushed branch. Only the fields below are ' +
      'settable — there is no arbitrary payload. Requires write authority.',
    inputSchema: obj(
      {
        sourceBranch: { type: 'string', minLength: 1, description: 'The branch holding the changes (already pushed).' },
        targetBranch: { type: 'string', minLength: 1, description: 'The branch to merge into.' },
        title: { type: 'string', minLength: 1, description: 'Merge-request title.' },
        description: { type: 'string', description: 'Merge-request description in Markdown.' },
        draft: { type: 'boolean', description: 'Open it as a draft (marks the title accordingly).' }
      },
      ['sourceBranch', 'targetBranch', 'title']
    )
  },
  {
    name: 'updateCodeHostMergeRequest',
    description:
      'Edit an existing merge request’s title, description, target branch, or draft state. Supply at least one of ' +
      'them; everything else is left untouched. Requires write authority.',
    inputSchema: obj(
      {
        iid: { type: 'integer', minimum: 1, description: 'The merge request’s project-scoped number (IID).' },
        title: { type: 'string', description: 'Replacement title.' },
        description: { type: 'string', description: 'Replacement description in Markdown.' },
        targetBranch: { type: 'string', description: 'Retarget the merge request at this branch.' },
        draft: { type: 'boolean', description: 'Set or clear draft state (requires `title` to re-mark it).' }
      },
      ['iid']
    )
  },
  {
    name: 'inspectCodeHostPipelines',
    description:
      'Inspect CI in this session’s project: list recent pipelines, read one pipeline, list a pipeline’s jobs, or ' +
      'read one job. Read-only, so a read-level authorization is enough. Results are bounded.',
    inputSchema: obj(
      {
        scope: {
          type: 'string',
          enum: ['pipelines', 'pipeline', 'pipeline_jobs', 'job'],
          description:
            '`pipelines` lists recent pipelines; `pipeline` and `pipeline_jobs` need `pipelineId`; `job` needs `jobId`.'
        },
        pipelineId: {
          type: 'string',
          pattern: '^[1-9][0-9]*$',
          description: 'Required for `pipeline`/`pipeline_jobs`.'
        },
        jobId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for `job`.' },
        ref: { type: 'string', description: 'Only for `pipelines`: filter by branch or tag.' },
        status: {
          type: 'string',
          enum: [...BROKER_PIPELINE_STATUSES],
          description: 'Only for `pipelines`: filter by pipeline status.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum entries to list (default 20).' }
      },
      ['scope']
    )
  },
  {
    name: 'controlCodeHostPipeline',
    description:
      'Retry or cancel a pipeline or a single job in this session’s project. Requires write authority; nothing else ' +
      'about the pipeline can be changed here.',
    inputSchema: obj(
      {
        action: {
          type: 'string',
          enum: ['retry_pipeline', 'cancel_pipeline', 'retry_job', 'cancel_job'],
          description: 'Pipeline actions need `pipelineId`; job actions need `jobId`.'
        },
        pipelineId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for the pipeline actions.' },
        jobId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for the job actions.' }
      },
      ['action']
    )
  }
]

export const ALL_TOOL_NAMES = [
  ...new Set(
    [
      ...SESSION_TOOLS,
      // platform-neutral tools — descriptors are built per-agent, but the names
      // are stable and belong in the permission auto-allow set.
      buildSendMessageTool([]),
      buildShareFileTool(),
      // Built against EVERY registered platform so every port gate opens: the auto-allow
      // set is about names, and a name some platform can inject must be listed even for
      // an agent that will never see it.
      ...buildReadTools(allPortPlatforms(), platformsWithPort('channelHistory').at(0)),
      // Every platform's credentialed attachment tool, whatever this agent has:
      // the auto-allow set is about NAMES, and a name a platform can inject must
      // be listed even for an agent that will never see it.
      ...allAttachmentReadTools(),
      ...MEMORY_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...COLLABORATION_TOOLS,
      // Retired from injection but still dispatched by `executeTool`, so the name stays
      // reserved (no evaluation tool may shadow it) and auto-allowed (a session warm with
      // the old descriptor, or an in-flight orchestration, must not start hitting approval).
      ...RETIRED_ORCHESTRATION_TOOLS,
      ...GITHUB_REVIEW_TOOLS,
      ...CODE_HOST_EFFECT_TOOLS
    ]
      .map((t) => t.name)
      // External-memory record tools: only their names are core knowledge here, the descriptors live in memory/.
      .concat([...EXTERNAL_MEMORY_TOOL_NAMES])
      // The pre-promotion review name: no longer injected, still dispatched for warm sessions.
      .concat(['submitGithubReview'])
  )
]

/**
 * The default MCP tool set for an agent. Memory and collaboration tools are
 * always present; the session-title fallback is opt-in for whitelisted runtimes,
 * and platform tools are gated by the agent's integrations. The channel/user
 * read helpers are platform-neutral (one set, routed by a `platform` argument);
 * only the per-platform file-read tools are gated per platform — and that gate
 * is a declared Layer-1 read port, not a platform name.
 */
export function toolsForIntegrations(
  integrations: Integration[],
  options: { sessionTitle?: boolean; organizationKnowledge?: boolean; currentPlatform?: string } = {}
): ToolDescriptor[] {
  const tools: ToolDescriptor[] = []
  const seen = new Set<string>()
  const add = (set: ToolDescriptor[]) => {
    for (const t of set) {
      if (seen.has(t.name)) continue
      seen.add(t.name)
      tools.push(t)
    }
  }
  if (options.sessionTitle) add(SESSION_TOOLS)
  add(MEMORY_TOOLS)
  if (options.organizationKnowledge) add(KNOWLEDGE_TOOLS)
  add(COLLABORATION_TOOLS)
  // The unified `sendMessage` tool is ALWAYS present (session-concept §3): even a
  // memory-only agent with no platform integration can wake a peer (`toAgent`) or reply to
  // its origin (`sessionId`). The `platform` enum is narrowed to the agent's own platforms
  // so it can post to any of them (empty ⇒ no channel posting, only wake/reply).
  const platforms = [...new Set(integrations.map((i) => i.platform))]
  add([buildSendMessageTool(platforms)])
  // Platform read helpers only make sense once the agent has at least one integration.
  if (platforms.length > 0) {
    add(buildReadTools(platforms, options.currentPlatform))
    // The current-conversation file share (docs/designs/agent-authored-attachments.md §3):
    // platform-gated like the read tools; sessions without a file-hosting gateway get a
    // clean refusal at call time (port probe / coordinate gates).
    add([buildShareFileTool()])
  }
  // Per-platform CREDENTIALED attachment reads. A platform contributes its own
  // descriptor by declaring the read port (`platforms/read-ports.ts`); core does
  // not know which platforms have one, or what they are called. Registry order,
  // not integration order, so an agent's tool list does not reshuffle because its
  // integrations happened to be stored the other way round.
  add(attachmentReadToolsFor(platforms))
  return tools
}
