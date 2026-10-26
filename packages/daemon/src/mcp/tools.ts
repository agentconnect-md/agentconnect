import type { Integration } from '../agents/agent-schema.js'
import { obj, type JsonValue, type ToolDescriptor } from '../tool-schema/descriptor.js'
import {
  allAttachmentReadTools,
  allPortPlatforms,
  allSessionToolDescriptors,
  declaresPort,
  attachmentReadToolsFor,
  sessionToolsFor,
  type PlatformToolPort
} from '../platforms/read-ports.js'
import { EXTERNAL_MEMORY_TOOL_NAMES, MEMORY_TOOLS } from '../memory/tools.js'
import { BROKER_PIPELINE_STATUSES } from '../gitlab/broker.js'
import { RECALL_TOOL } from './recall-tool.js'
import { FOLLOW_UP_TOOL, PROPOSE_TOOL, RECORD_CHECK_TOOL } from './ops/assistant-items.js'
import { ASSISTANT_REMINDER_TOOLS } from './ops/assistant-reminders.js'
import { LIST_TASKS_TOOL, STOP_TASK_TOOL } from './ops/assistant-subsessions.js'
import { CODE_HOST_RESEARCH_TOOLS } from './ops/code-host-research.js'
import { GETTING_TO_KNOW_TOOL } from './ops/getting-to-know.js'
import { SEND_MESSAGE_ACTIONS } from './ops/send-message-actions.js'
import { GET_TOOL_GUIDE_TOOL } from './ops/tool-guide.js'

/** The one send tool (send-message-guide.md §3.2): a required `action`, one flat schema, and the details in `getToolGuide`; `platform` narrows to the agent's own platforms. */
function buildSendMessageTool(platforms: string[]): ToolDescriptor {
  const agentId = { type: 'string', minLength: 1, description: 'AgentConnect agent id, never a platform member id.' }
  return {
    name: 'sendMessage',
    description:
      'Send outside your current conversation. Required action: callAgent asks a peer to work ' +
      '(sessionId continues an existing peer session); calling yourself needs channel and starts visible work ' +
      'there. delegateTask hands work that spans turns or runs long, which people should see and stop, to a task of ' +
      'this session: call it before exploring, say so, end your turn. Work that fits this turn stays here. Ask ' +
      'the person before delegating live-environment changes; "check again" is no approval. messageTask sends ' +
      'a task more (taskId); listTasks lists them, stopTask stops one. replyToSession answers a message another ' +
      'session sent you, by its ' +
      'messageId; replies are not broadcast. postMessage reaches a person, channel, or another thread; it starts no ' +
      'work and gets no reply. For your current conversation, write your ordinary reply. To get a peer’s result, ' +
      'use toAgent: {agentId: "...", needsReply: true}. Call getToolGuide {"tool":"sendMessage"} for arguments and ' +
      'examples. Calls without action fail without sending anything.',
    inputSchema: obj(
      {
        action: { type: 'string', enum: [...SEND_MESSAGE_ACTIONS] },
        message: { type: 'string', minLength: 1, description: 'Message body in Markdown.' },
        toAgent: {
          description: 'callAgent only: the agent to call.',
          oneOf: [
            agentId,
            obj(
              {
                agentId,
                needsReply: {
                  oneOf: [
                    { type: 'boolean' },
                    { type: 'string', pattern: '^(?:[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])$' }
                  ],
                  description: 'True whenever you expect a result or completion notice back.'
                }
              },
              ['agentId']
            )
          ]
        },
        toUser: {
          description: 'Human platform member id(s); an array requires channel.',
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
          ]
        },
        channel: { type: 'string', minLength: 1, description: 'Destination channel or chat.' },
        thread: { type: 'string', minLength: 1, description: 'Existing thread root, for a bare-channel postMessage.' },
        sessionId: {
          type: 'string',
          minLength: 1,
          description: 'callAgent only: that agent’s existing session (a childSessionId), instead of channel.'
        },
        taskId: { type: 'string', minLength: 1, description: 'messageTask only: the taskId delegateTask returned.' },
        messageId: {
          type: 'string',
          minLength: 1,
          description: 'replyToSession only: the id of the message you answer, shown with that message.'
        },
        attachment: { type: 'string', minLength: 1, description: 'Received image name from an [attached: …] marker.' },
        platform: {
          type: 'string',
          ...(platforms.length > 0 ? { enum: platforms } : {}),
          description:
            "postMessage, or callAgent with channel: the destination's platform; defaults to this conversation's."
        },
        integrationId: { type: 'string', minLength: 1, description: 'Bot to use when several integrations apply.' }
      },
      ['action', 'message']
    )
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
 * ({@link attachmentReadToolsFor}). The port-gated tools (thread history, reactions,
 * bookmarks, lists, canvases, …) are the opposite: platform-shaped, so they carry no
 * `platform` selector and are injected only into a session ON a declaring platform.
 */
/**
 * `shareFile` — post a workspace file into the CURRENT conversation
 * (docs/designs/agent-authored-attachments.md §3). The one visible send that is NOT
 * `sendMessage`'s job: every `sendMessage` post lands at a channel ROOT, while this places
 * a file in the thread the agent is already answering. No coordinates by construction —
 * the daemon posts from the trusted active-turn context.
 */
function buildShareFileTool(): ToolDescriptor {
  return {
    name: 'shareFile',
    description:
      'Post a FILE from your workspace into THIS conversation — the thread you are answering right now. This is ' +
      'the only way to hand someone a file you produced or downloaded: your ordinary reply is text-only, and ' +
      '`sendMessage` posts to channel roots, never here. `path` is relative to your workspace root; put files there ' +
      'first (generated files: save under `outputs/` — images under `outputs/images/` — with a unique name, copying ' +
      'any result that lives outside the workspace). Any file type: PNG, JPEG, WEBP and GIF post as images (decided ' +
      'from the file bytes, not the name; the console also shows a self-contained static SVG inline, and offers a ' +
      'GIF as a download); everything else (PDF, CSV, XLSX, DOCX, ZIP, text, …) posts as a downloadable file named ' +
      'after the path. Some platforms host only images and say so. The optional ' +
      '`caption` is plain text (max 1000 chars; mention syntax is neutralized, though a bare Telegram @username ' +
      'may still notify); write everything else in your ordinary reply. Do not repeat the file as Markdown or paste ' +
      'download links after a successful share — the post has its own view and download actions. ' +
      'The file posts immediately, so it may appear before your streamed reply finishes. If the result says ' +
      'the upload MAY have been delivered, do NOT retry — report that instead.',
    inputSchema: obj(
      {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Workspace-relative path to the file (e.g. `out/chart.png`, `outputs/report.pdf`). Absolute paths and ' +
            '`..` are rejected.'
        },
        caption: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          description: 'Optional short plain-text caption posted with the file.'
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
  // Mirrors sendMessage: pick a specific bot when the agent has more than one integration on the same platform. Defaults to the current session's bot, else a human's answer, else the first (#1965 Gap A).
  const integrationId = {
    type: 'string',
    description:
      'Optional. Pick a specific bot when the agent has multiple integrations on the target platform. Omit it and ' +
      'the bot is the one that owns this conversation; on another platform where the agent has several and none ' +
      'owns this conversation, a human is asked which one to act as.'
  }
  // The port-gated tools below act on THIS session's platform only, so their bot selector
  // never crosses platforms: another bot of this agent on the same platform, nothing else.
  const sameBotSelector = {
    type: 'string',
    description:
      'Optional. Pick another of this agent’s bots on this platform when it has several. Omit it and the bot is ' +
      'the one that owns this conversation; where none of them does, a human is asked which one to act as.'
  }
  // Port-gated tools have no platform selector: a session on a platform that declares the port
  // gets the tool, any other session does not — cross-platform reach of a platform-shaped
  // capability was never asked for, and it cost every other session the descriptors.
  const sessionPlatform = currentPlatform ?? (platforms.length === 1 ? platforms[0] : undefined)
  const offered = (port: PlatformToolPort) => sessionPlatform !== undefined && declaresPort(sessionPlatform, port)
  return [
    {
      name: 'getCurrentChannel',
      description:
        'Return the channel/chat (and thread/topic) THIS conversation is bound to, including its name when available, ' +
        "and the channel's own topic and description text where the platform keeps them.",
      inputSchema: obj({})
    },
    {
      name: 'listChannels',
      description:
        'List the channels/chats the bot can post to on a platform, each with its id and name — on Slack every ' +
        'public channel of the workspace plus the private ones the bot was invited to, with `joined` saying ' +
        'whether the bot is in each. To join a public channel it is not in, read or post there: the person ' +
        'asking is asked whether the bot may join, and it joins on their yes. Pass `platform` to ' +
        'target one of the platforms this agent is connected to (defaults to the current one), and `integrationId` ' +
        'to choose a specific bot when the agent has several on that platform. Note: Telegram bots cannot enumerate ' +
        'their chats live, so there Telegram returns the chats this agent has already been active in (from history); ' +
        'the result `source` is "live" or "observed" accordingly. That history belongs to one bot at a time: the bot ' +
        '`integrationId` names, else the one that owns this conversation, else — a platform where this agent has ' +
        'several bots and none of them owns this conversation — one a human is asked to choose; with no answer the ' +
        'fallback is suppressed and the result carries a `note`. A result scoped to one bot names it back as ' +
        '`integrationId`: pass that id to sendMessage/listChannelMembers/getUserProfile, or the ids it returned may ' +
        'not be reachable by the bot those calls pick.',
      inputSchema: obj({ platform, integrationId })
    },
    ...(offered('channelHistory')
      ? [
          {
            name: 'getChannelHistory',
            description:
              'Read one bounded page of messages from a channel on this platform: the channel bound to this ' +
              'conversation by default, or the one `channel` names. Another conversation is readable only when ' +
              'the person asking may see it: a public channel (if the bot is not in it, the person asking is asked ' +
              'first whether it may join), a private channel or group DM they are in, or their own direct ' +
              'message with you; through another of your bots, as the chat account they linked for that ' +
              "bot's workspace, else only what the console shows that person. A run no " +
              'person started reads only public channels. Anything else is refused ' +
              'with one answer that never says whether it exists. A result from a private conversation carries ' +
              '`privateSource`: when you use it, say where it came from in one short clause. Results are ' +
              'newest-first; pass nextCursor as cursor to continue with older messages. This returns channel ' +
              'messages, not replies inside a thread: each carries `threadTs` and `replyCount`, and ' +
              '`getThreadHistory` opens one.',
            inputSchema: obj({
              integrationId: sameBotSelector,
              channel: targetChannel,
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
        'That history belongs to one bot at a time: the bot that owns this conversation, else — a platform where ' +
        'this agent has several bots and none of them owns this conversation — one a human is asked to choose; with ' +
        'no answer the result is an empty list with a `note`. A result scoped to one bot names it back as ' +
        '`integrationId`: pass that id to sendMessage/listChannels/getUserProfile, or the ids it returned may not be ' +
        'reachable by the bot those calls pick.',
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
    ...buildThreadHistoryTool(offered('threadHistory'), sameBotSelector),
    ...buildReactionTools(offered('reactions'), sameBotSelector),
    ...buildMessageDeleteTool(offered('messageDelete'), sameBotSelector),
    ...buildConversationCreateTool(offered('conversationCreate'), sameBotSelector),
    ...buildSearchTool(offered('publicMessageSearch')),
    ...buildBookmarkTools(offered('bookmarks'), sameBotSelector),
    ...buildListTools(offered('lists'), sameBotSelector),
    ...buildScheduleMessageTool(offered('scheduledMessages'), sameBotSelector),
    ...buildCanvasTools(offered('canvas'), sameBotSelector)
  ]
}

/** One property schema inside a tool's `inputSchema` — what the shared `platform` /
 *  `integrationId` selectors are, and what a port gate hands the builders below. */
type SchemaProp = Record<string, JsonValue>

/** The channel selector shared by the port-gated tools below: the current conversation's
 *  channel by default, and required once `integrationId` names another bot. */
const targetChannel = {
  type: 'string',
  description:
    'Channel/chat id. Defaults to this conversation’s channel; required when `integrationId` names another bot.'
}

/** `getThreadHistory` — the same provider thread read the daemon already uses to rebuild
 *  mid-thread context, handed to the agent. Reads a thread the agent is NOT answering,
 *  which is the one thing the ordinary turn context cannot show it. */
function buildThreadHistoryTool(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
  return [
    {
      name: 'getThreadHistory',
      description:
        'Read one thread in full — its root message and every reply. Use it to catch up on a discussion you are not ' +
        'part of: `getChannelHistory` reports each message’s `threadTs` and `replyCount`, and this opens one of ' +
        'them. `thread` is the root message’s id (Slack thread_ts). A thread in another conversation is readable ' +
        'under the same rule as `getChannelHistory`: only when the person asking may see that conversation (if the ' +
        'bot is not in a public channel, the person asking is asked first whether it may join), with ' +
        '`privateSource` on a result from a private one. Results are ' +
        'oldest-first; `truncated` is true when the thread is longer than `limit`. Your own status chrome is ' +
        'filtered out.',
      inputSchema: obj(
        {
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
function buildReactionTools(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
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
      inputSchema: obj({ integrationId, channel: targetChannel, messageTs }, ['messageTs'])
    }
  ]
}

/** `deleteMessage` — take one message back off the platform. Deliberately its own port and not
 *  part of the reactions pair: it destroys something a reader may already have seen. */
function buildMessageDeleteTool(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
  return [
    {
      name: 'deleteMessage',
      description:
        'Remove one message from the conversation. Normally the bot may only delete its OWN messages, and a ' +
        'platform bounds how long that stays possible (Telegram: 48 hours; an admin bot in a group may also ' +
        'delete others’ messages). A refusal is reported as `deleted: false`, not an error, so check the result. ' +
        'Deletion is not undoable and anyone watching may already have read the message — prefer posting a ' +
        'correction unless removing it is what was actually asked for.',
      inputSchema: obj(
        {
          integrationId,
          channel: targetChannel,
          messageTs: { type: 'string', description: 'Id of the message to delete (Telegram message_id, Slack ts).' }
        },
        ['messageTs']
      )
    }
  ]
}

/**
 * `listBookmarks` / `addBookmark` / `removeBookmark` — the links pinned at the top of a
 * conversation. Small, durable, and visible to everyone in the channel, which is why the write
 * says so: a bookmark outlives the task the way a canvas does, not the way a reply does.
 */
function buildBookmarkTools(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
  const channel = {
    type: 'string',
    description:
      'Channel id. Defaults to the conversation you are in — but REQUIRED when `integrationId` names ' +
      'another bot, since this conversation’s id means nothing there.'
  }
  return [
    {
      name: 'listBookmarks',
      description:
        'List the links pinned at the top of a conversation, each with its id, title and URL. Read this before ' +
        'changing anything: `removeBookmark` needs an id, and it is also how you tell whether the link you were ' +
        'about to pin is already there.',
      inputSchema: obj({ integrationId, channel })
    },
    {
      name: 'addBookmark',
      description:
        'Pin a link at the top of a conversation, where everyone in it will see it and it stays until someone ' +
        'removes it. That permanence is the point and the caution: pin a thing the channel will want again — a ' +
        'dashboard, a runbook, the PR everyone is waiting on — not a link that matters only to the task in hand. ' +
        'Slack allows 100 per channel.',
      inputSchema: obj(
        {
          integrationId,
          channel,
          title: { type: 'string', minLength: 1, description: 'Short label shown on the bookmark.' },
          link: { type: 'string', minLength: 1, description: 'The URL to pin.' },
          emoji: { type: 'string', description: 'Optional emoji shortcode, e.g. `:books:`.' }
        },
        ['title', 'link']
      )
    },
    {
      name: 'removeBookmark',
      description:
        'Unpin a link, by the `id` from `listBookmarks`. Removing one someone else pinned is a visible change to ' +
        'a shared channel — do it when asked, not as tidying.',
      inputSchema: obj(
        {
          integrationId,
          channel,
          bookmarkId: { type: 'string', minLength: 1, description: 'Bookmark id from `listBookmarks`.' }
        },
        ['bookmarkId']
      )
    }
  ]
}

/**
 * `readList` / `addListItem` / `updateListItem` — the platform's structured lists.
 *
 * The read carries the COLUMNS, not because it is convenient but because a write is impossible
 * without them: a value is addressed by `columnId` and keyed by that column's type, and the
 * platform publishes no schema endpoint. Same shape as the canvas section ids.
 */
function buildListTools(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
  const listId = { type: 'string', minLength: 1, description: 'List id (a Slack List `F…` id).' }
  const fields = {
    type: 'array',
    minItems: 1,
    description:
      'Values to write. Each entry is `{ columnId, type, value }` taken straight from `readList`: use its ' +
      '`columns` verbatim — the `type` it reports is already the key a write must use, which is not always the ' +
      'name the column displays (a text column is written as `rich_text`). Skip any column marked `readOnly`; ' +
      'the platform computes those. `value` matches the type — `rich_text` a rich-text block array, `user` an ' +
      'array of user ids, `date` an array like ["2026-08-31"], `select` an array of option ids, `number` an ' +
      'array of numbers, `checkbox` a boolean, `message` an array of message permalinks.',
    items: {
      type: 'object',
      properties: {
        columnId: { type: 'string', minLength: 1, description: 'Column id from `readList`.' },
        type: { type: 'string', minLength: 1, description: 'Column type from `readList`.' },
        value: { description: 'The value, shaped by the column type.' }
      },
      required: ['columnId', 'type', 'value'],
      additionalProperties: false
    }
  }
  return [
    {
      name: 'readList',
      description:
        'Read one page of a structured list: its rows AND its columns. Always read before writing — a write ' +
        'addresses a value by column id and keys it by the `type` this reports, and there is no other way to ' +
        'learn either. The columns include ones no row has filled in yet, and mark the ones the platform ' +
        'computes as `readOnly`. Page with `cursor`.',
      inputSchema: obj(
        {
          integrationId,
          listId,
          cursor: { type: 'string', description: 'Cursor from a previous page.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows per page.' }
        },
        ['listId']
      )
    },
    {
      name: 'addListItem',
      description:
        'Append a row to a list. Get `columns` from `readList` first; a column id this list does not have is ' +
        'refused rather than guessed at. The row is visible to everyone with access to the list.',
      inputSchema: obj({ integrationId, listId, fields }, ['listId', 'fields'])
    },
    {
      name: 'updateListItem',
      description:
        'Change fields on an existing row. `itemId` comes from `readList`, and so do the column ids — only the ' +
        'columns you name are touched, the rest of the row is left alone.',
      inputSchema: obj(
        {
          integrationId,
          listId,
          itemId: { type: 'string', minLength: 1, description: 'Row id from `readList`.' },
          fields
        },
        ['listId', 'itemId', 'fields']
      )
    }
  ]
}

/**
 * `searchPublicMessages` — workspace-wide relevance search over PUBLIC channels, which is the whole
 * of what Slack's Real-time Search API gives a bot token.
 *
 * An earlier revision bound it to the current conversation. Measurement against a real
 * workspace killed that: `search:read.private` / `.im` / `.mpim` ARE grantable to a bot
 * (Slack's scope reference says otherwise and is wrong), but no combination of `channel_types`
 * — including omitting it — returns private or DM content, even for a private channel the bot
 * belongs to. Binding to the conversation therefore returned an empty list in exactly the
 * places an agent is most often talked to. Neither `context_channel_id` nor `channel_types`
 * filters, so no narrowing can be promised at all: the honest tool is the one the API
 * implements, described exactly.
 */
function buildSearchTool(enabled: boolean): ToolDescriptor[] {
  if (!enabled) return []
  return [
    {
      name: 'searchPublicMessages',
      description:
        'Search the workspace’s PUBLIC channels — the way to answer "what was decided about X" or "has anyone hit ' +
        'this before" across conversations you are not part of. Ranked by relevance, not recency. Each hit carries ' +
        'its channel, author, text, timestamp and permalink. ' +
        'The name is the first limit: private channels and DMs are never searched, INCLUDING the conversation you ' +
        'are in right now, so this cannot look through the discussion you are having. Two more follow from it. ' +
        'Hits may sit in channels you were never added to — they are public, so `getThreadHistory` opens them for ' +
        'whoever may see that channel (if the bot is not in it, the person asking is asked first whether it may join; ' +
        'if they decline, answer from the hit’s own text and permalink). And the ' +
        'search is authorized by the message that started this turn, so a scheduled run, a turn another agent ' +
        'woke, or a channel message that did not address you cannot search, and will say so. Page with `cursor`. ' +
        'Slack does not permit these results to be stored or copied, so AgentConnect keeps none of them in ' +
        'its own transcript and the same restraint applies to you: answer from them, but do not copy them into ' +
        'memory, a canvas, or a file. Search again if you need them later.',
      inputSchema: obj(
        {
          query: { type: 'string', minLength: 1, description: 'What to look for, in the user’s own words.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Hits per page (max 20, default 20).' },
          cursor: { type: 'string', description: 'Cursor from a previous page.' },
          includeBots: { type: 'boolean', description: 'Include messages written by bots (default false).' },
          after: { type: 'string', description: 'Only messages after this ISO-8601 instant.' },
          before: { type: 'string', description: 'Only messages before this ISO-8601 instant.' }
        },
        ['query']
      )
    }
  ]
}

/** `createConversation` — the one tool here that creates durable workspace state. */
function buildConversationCreateTool(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
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
function buildScheduleMessageTool(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
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
function buildCanvasTools(offered: boolean, integrationId: SchemaProp): ToolDescriptor[] {
  if (!offered) return []
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
      inputSchema: obj({ integrationId, canvasId }, ['canvasId'])
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

export const DECISION_TOOLS: ToolDescriptor[] = [
  {
    name: 'listDecisions',
    description:
      'Browse saved Decisions available to this agent. Returns names, IDs, models, and complete questions. ' +
      'Read the instructions to construct state for evaluateDecision. Continue with nextCursor when present.',
    inputSchema: obj({
      query: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional name filter.' },
      cursor: {
        type: 'string',
        format: 'uuid',
        description: 'nextCursor from the previous page; keep the same query.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Maximum results (default 10); pages are also byte bounded.'
      }
    })
  },
  {
    name: 'evaluateDecision',
    description:
      'Evaluate a saved Decision on this agent’s daemon using its configured model and provider. Supply the JSON ' +
      'state referenced by the Decision instructions, including any needed history; no conversation is added automatically. ' +
      'Returns a typed answer with probabilities or an unavailable reason. The result does not authorize or execute actions.',
    inputSchema: obj(
      {
        decisionId: { type: 'string', format: 'uuid', description: 'Saved Decision ID from listDecisions.' },
        state: {
          type: 'object',
          additionalProperties: true,
          description: 'Input data and relevant context for the question; total provider request is limited to 32 KiB.'
        }
      },
      ['decisionId', 'state']
    )
  }
]

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

// Collaboration tools for every agent: `listAgents` finds org peers; calling one, or fanning out to N, is `sendMessage` `callAgent`.
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
  '`{"action":"callAgent","toAgent":"<agent id>","message":"..."}` (a direct, postless call), rather than ' +
  '@mentioning member ids in a channel post. Pass `channel` only as a FILTER, to narrow the list to the agents ' +
  'present in that channel. Only agents you are allowed to reach are returned. Your own entry is included so you ' +
  'can use its agent id in `callAgent` with `channel` to open and activate a new channel-root conversation with ' +
  'yourself; to hand long work of your own to a task, use `delegateTask` instead (see `getToolGuide`).'

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
      'Read execution and reply-delivery state for a task or session YOU started. Pass the `taskId` a delegateTask ' +
      'returned, or the `childSessionId` a callAgent returned as `sessionId`, then follow the returned `nextAction`. ' +
      'This is diagnostic only; it never returns the reply body.',
    inputSchema: obj({
      taskId: { type: 'string', minLength: 1, description: 'The `taskId` a `sendMessage` delegateTask returned.' },
      sessionId: {
        type: 'string',
        minLength: 1,
        description: 'The `childSessionId` a `sendMessage` callAgent returned.'
      }
    })
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
          description:
            'Optional inline review comments, submitted atomically with the top-level review. On GitHub, use lines ' +
            'in the pull request diff and keep each range within one hunk. After invalid_input with not_submitted, ' +
            'correct the positions or move the findings into body, then call this tool again.',
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
      // platform-neutral tools — descriptors are built per-agent, but the names
      // are stable and belong in the permission auto-allow set.
      buildSendMessageTool([]),
      GET_TOOL_GUIDE_TOOL,
      buildShareFileTool(),
      // Built once per registered platform AS the session platform so every port gate opens:
      // the auto-allow set is about names, and a name some platform can inject must be listed
      // even for an agent that will never see it.
      ...allPortPlatforms().flatMap((platform) => buildReadTools(allPortPlatforms(), platform)),
      // Every platform's credentialed attachment tool, whatever this agent has:
      // the auto-allow set is about NAMES, and a name a platform can inject must
      // be listed even for an agent that will never see it.
      ...allAttachmentReadTools(),
      // Every platform's session-scoped tool family, for the same reason.
      ...allSessionToolDescriptors(),
      ...MEMORY_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...DECISION_TOOLS,
      ...COLLABORATION_TOOLS,
      ...GITHUB_REVIEW_TOOLS,
      ...CODE_HOST_EFFECT_TOOLS,
      ...CODE_HOST_RESEARCH_TOOLS,
      RECALL_TOOL,
      FOLLOW_UP_TOOL,
      GETTING_TO_KNOW_TOOL,
      RECORD_CHECK_TOOL,
      PROPOSE_TOOL,
      ...ASSISTANT_REMINDER_TOOLS,
      LIST_TASKS_TOOL,
      STOP_TASK_TOOL
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
 * always present; platform tools are gated by the agent's integrations. The channel/user
 * read helpers are platform-neutral (one set, routed by a `platform` argument);
 * only the per-platform file-read tools are gated per platform — and that gate
 * is a declared Layer-1 read port, not a platform name.
 */
export function toolsForIntegrations(
  integrations: Integration[],
  options: {
    organizationKnowledge?: boolean
    decisions?: boolean
    currentPlatform?: string
    /** The console can show shared images, so a session with no IM integration still gets `shareFile`. */
    consoleImages?: boolean
  } = {}
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
  add(MEMORY_TOOLS)
  if (options.organizationKnowledge) add(KNOWLEDGE_TOOLS)
  if (options.decisions) add(DECISION_TOOLS)
  add(COLLABORATION_TOOLS)
  // Every agent's cross-place recall, under the read rule (assistant-mode.md §5.4 ③, §5.5).
  add([RECALL_TOOL])
  // `sendMessage` and its guide are ALWAYS present: postless calls, tasks and origin replies need no platform (send-message-guide.md §3.2).
  const platforms = [...new Set(integrations.map((i) => i.platform))]
  add([buildSendMessageTool(platforms), GET_TOOL_GUIDE_TOOL])
  // Platform read helpers only make sense once the agent has at least one integration.
  if (platforms.length > 0) {
    add(buildReadTools(platforms, options.currentPlatform))
    // The current-conversation file share (docs/designs/agent-authored-attachments.md §3):
    // platform-gated like the read tools; sessions without a file-hosting gateway get a
    // clean refusal at call time (port probe / coordinate gates).
    add([buildShareFileTool()])
  }
  // A console turn's output capability, not the integration count, decides; execution re-checks the active turn.
  if (options.consoleImages) add([buildShareFileTool()])
  // Per-platform CREDENTIALED attachment reads. A platform contributes its own
  // descriptor by declaring the read port (`platforms/read-ports.ts`); core does
  // not know which platforms have one, or what they are called. Registry order,
  // not integration order, so an agent's tool list does not reshuffle because its
  // integrations happened to be stored the other way round.
  add(attachmentReadToolsFor(platforms))
  // The session platform's OWN tool family (`sessionTools`): platform-shaped tools that exist
  // only where the session is, so a Linear-connected agent's Slack sessions carry none of them.
  const sessionPlatform = options.currentPlatform ?? (platforms.length === 1 ? platforms[0] : undefined)
  add([...(sessionToolsFor(sessionPlatform)?.descriptors ?? [])])
  return tools
}
