import type { Integration } from '../agents/agent-schema.js'
import type { MemoryPluginOperation } from '@agentconnect.md/protocol'
import type { JSONValue } from '@modelcontextprotocol/server'
import { SESSION_TITLE_TOOL_NAME } from './session-title-tool.js'

/**
 * A tool descriptor in MCP's `tools/list` shape: a name, a human/model-facing
 * description, and a JSON Schema for the arguments. The daemon owns these
 * definitions; the stdio bridge just relays them to the agent harness verbatim.
 */
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: ObjectToolSchema
}

type ToolProperties = Record<string, JSONValue>

interface ObjectToolSchema extends Record<string, JSONValue> {
  type: 'object'
  properties: ToolProperties
  required: string[]
  additionalProperties: false
}

const obj = (properties: ToolProperties, required: string[] = []): ObjectToolSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

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
 * `to.platform` (+ optional `to.integrationId`); the model never sees a token. The `platform`
 * enum is narrowed at build time to the platforms this agent actually has (absent when the
 * agent has no platform integration — pure A2A / reply still work).
 */
function buildSendMessageTool(platforms: string[], collaboration = true): ToolDescriptor {
  const platform = {
    type: 'string',
    ...(platforms.length > 0 ? { enum: platforms } : {}),
    description: 'Target platform for a visible channel post. Defaults to the current conversation’s platform.'
  }
  const agentTarget = {
    title: 'Peer agent target',
    description:
      'Wake exactly one AgentConnect peer directly. With no `channel` the wake is postless (nothing is left in any ' +
      'channel). Add a `channel` to ALSO post one visible message there and land the peer in that post’s thread.',
    ...obj(
      {
        toAgent: {
          description:
            'The peer to wake. Either the bare AgentConnect agent id, or an object ' +
            '`{"agentId":"<agent id>","needsReply":true}` when you need the peer to report back to you. Use ' +
            '`needsReply` for delegated work you will wait on: the peer’s session is opened with a standing ' +
            'instruction to reply into YOUR session when it finishes or fails, and you can poll it meanwhile with ' +
            '`viewSessionStatus` on the returned `childSessionId`.',
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
                      'When true, the woken session is told to report back into this session (done or failed) when ' +
                      'it completes. Defaults to false — a plain fire-and-forget wake.'
                  }
                },
                ['agentId']
              )
            }
          ]
        },
        channel: {
          type: 'string',
          minLength: 1,
          description:
            'Optional. When given, post a visible message to this channel and land the peer’s session in that post’s ' +
            'thread. Omit for a postless direct wake in the current conversation.'
        },
        thread: {
          type: 'string',
          description:
            'Optional. With `channel`: post into this thread and reuse it for the peer’s session; omit (or "") to ' +
            'post at channel root and anchor the peer to the new root message. Without `channel` (postless): omit ' +
            'for the current thread, use "" for channel root.'
        }
      },
      ['toAgent']
    )
  }
  const channelTarget = {
    title: 'Channel target',
    description:
      'Post one visible message to a platform channel, optionally addressing one human. A post at channel root ' +
      'opens a NEW session of your own on that post; only an explicit `thread` continues an existing conversation.',
    ...obj(
      {
        channel: {
          type: 'string',
          minLength: 1,
          description: 'Target channel / chat id (Slack `C0123ABC`, Telegram/Discord/Feishu chat id).'
        },
        platform,
        toUser: {
          type: 'string',
          minLength: 1,
          description: 'Optional platform member id to @mention / DM a human in the post (Slack only for now).'
        },
        thread: {
          type: 'string',
          description:
            'Optional thread / topic anchor. Omit (or use "") to post at channel root — which opens a new session ' +
            'on that post; pass an existing id to post into that thread instead.'
        },
        integrationId: {
          type: 'string',
          minLength: 1,
          description: 'Optional. Pick a specific bot when the agent has multiple integrations on the target platform.'
        }
      },
      ['channel']
    )
  }
  const sessionTarget = {
    title: 'Parent session target',
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
        }
      },
      ['sessionId']
    )
  }

  return {
    name: 'sendMessage',
    description: collaboration
      ? 'Send one message to exactly one target. Your own turn reply already reaches the conversation you are in, so ' +
        'use this tool for what that reply cannot do: reach a DIFFERENT conversation — another channel or thread, a ' +
        'session, or a peer agent — or @-mention a specific human with `toUser`, which may be right here. Choose one ' +
        'form:\n' +
        '- Peer agent (direct wake): `{"to":{"toAgent":"<agent id>"},"message":"..."}` is a postless wake. Add a ' +
        '`channel` (and optional `thread`) to also post a visible message and thread the peer’s reply there. Get the ' +
        'id from listAgents and send one call per peer; never substitute a platform member id. When the wake ' +
        'opens a session for the peer, the result carries its `childSessionId` — pass that to `viewSessionStatus` to ' +
        'check whether the peer is still working. Use ' +
        '`{"to":{"toAgent":{"agentId":"<agent id>","needsReply":true}},"message":"..."}` to also instruct that ' +
        'session to report back to you when it is done or has failed.\n' +
        '- Channel or human (visible post): `{"to":{"channel":"<channel id>"},"message":"..."}`. Add `toUser` only ' +
        'to address an actual human, or `platform` to use another connected platform. Without a `thread` this posts ' +
        'at channel root, which opens a NEW session of your own on that post — it never continues an existing ' +
        'conversation.\n' +
        '- Parent session (direct reply): `{"to":{"sessionId":"<Parent session>"},"message":"..."}`. Use the id ' +
        'from your `# Agent` block. Relay an answer back to whoever asked this way — never by posting it at their ' +
        'channel root.\n' +
        'Write `message` as CommonMark/GFM. The daemon supplies your identity; you cannot impersonate anyone or wake yourself.'
      : 'Post one visible message to exactly one platform channel or human. Your own turn reply already reaches the ' +
        'conversation you are in, so use this tool for what that reply cannot do: reach a DIFFERENT conversation — ' +
        'another channel, or another thread in this one — or @-mention a specific human with `toUser`, which may be ' +
        'right here. Use ' +
        '`{"to":{"channel":"<channel id>"},"message":"..."}` and add `toUser`, `platform`, `thread`, or ' +
        '`integrationId` only when needed. Without a `thread` this posts at channel root, which opens a NEW session ' +
        'of your own on that post. Peer-agent and parent-session delivery are disabled for this run. Write ' +
        '`message` as CommonMark/GFM. The daemon supplies your identity; you cannot impersonate anyone.',
    inputSchema: obj(
      {
        to: {
          type: 'object',
          description: 'Choose exactly one target branch. Fields from different branches cannot be mixed.',
          oneOf: collaboration ? [agentTarget, channelTarget, sessionTarget] : [channelTarget]
        },
        message: {
          type: 'string',
          minLength: 1,
          description: 'Message body, in standard Markdown (CommonMark/GFM).'
        }
      },
      ['to', 'message']
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
 * handled separately by {@link buildSendMessageTool}; per-platform file
 * downloads by {@link SLACK_FILE_TOOLS}/{@link TELEGRAM_FILE_TOOLS}.
 */
function buildReadTools(platforms: string[]): ToolDescriptor[] {
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
    }
  ]
}

/** Slack file-read helper, injected when an agent has a Slack integration. */
const SLACK_FILE_TOOLS: ToolDescriptor[] = [
  {
    name: 'readSlackFile',
    description:
      'Fetch the contents of a file shared in Slack, using the bot credentials. You do NOT have direct network access ' +
      "to Slack's private file URLs (they require the bot token) — use this tool instead of curl/fetch. Pass the file's " +
      '`url` (the `url_private` / `uri` from a shared attachment or resource link). Images are returned as viewable image ' +
      'content; text files as text. Supply `mimeType` when known for correct handling.',
    inputSchema: obj(
      {
        url: { type: 'string', description: "The file's url_private (or url_private_download) / resource-link uri." },
        mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. image/png or text/plain.' }
      },
      ['url']
    )
  }
]

/** Telegram file-read helper, injected when an agent has a Telegram integration. */
const TELEGRAM_FILE_TOOLS: ToolDescriptor[] = [
  {
    name: 'readTelegramFile',
    description:
      'Fetch the contents of a file shared in Telegram, using the bot credentials. You do NOT have direct network ' +
      "access to Telegram's file storage — use this tool instead of curl/fetch. Pass the file's `url` (the `file_id` " +
      'from a shared attachment or the `uri` of a resource link). Images are returned as viewable image content; text ' +
      'files as text. Supply `mimeType` when known for correct handling.',
    inputSchema: obj(
      {
        url: { type: 'string', description: "The shared file's Telegram file_id (or resource-link uri)." },
        mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. image/png or text/plain.' }
      },
      ['url']
    )
  }
]

/**
 * The agent's long-term memory tools — available to EVERY agent regardless of
 * integrations. Memory is a directory (`<agent-root>/memory/`) with a `MEMORY.md`
 * index (injected into the prompt each session) plus `<topic>.md` files the agent
 * reads on demand. Keep the index short; move detail into topic files.
 */
export const MEMORY_TOOLS: ToolDescriptor[] = [
  {
    name: 'readMemory',
    description:
      'Read one of your memory files. Omit `path` (or pass "MEMORY.md") to read the index; pass a topic file name ' +
      '(e.g. "deploys.md") to read that topic. The index is already shown to you at the start of each session (you ' +
      'do NOT need to read it first) — use this to pull the detail behind an index entry, or the current contents of ' +
      'a file before editing it.',
    inputSchema: obj({
      path: { type: 'string', description: 'Memory file name (e.g. "deploys.md"). Defaults to the MEMORY.md index.' }
    })
  },
  {
    name: 'writeMemory',
    description:
      'Save durable facts across sessions (conventions, decisions, who to ask, things you had to re-learn). Omit ' +
      '`path` to target the MEMORY.md index; pass a topic file name (e.g. "deploys.md") for a topic. Keep the INDEX ' +
      'short — a scannable list linking to topic files (e.g. "- [deploys](deploys.md) — how we ship"); put the detail ' +
      'in the topic files. Flat directory — no subfolders in the path.\n' +
      'Two modes:\n' +
      '• `content` — create a file or fully replace it.\n' +
      '• `oldString` + `newString` — targeted edit. Copy `oldString` verbatim from the injected memory-file boundary ' +
      'or a fresh `readMemory` result, never from surrounding session context (for example workspace or git status). ' +
      'It must occur exactly once; include enough file context to make it unique. If unsure, or retrying after a write ' +
      'or failed replace, call `readMemory` first. Pass `newString: ""` to delete. Prefer this mode for existing files ' +
      'so you do not resend the whole file. Provide exactly one mode.',
    inputSchema: obj({
      path: {
        type: 'string',
        description: 'Memory file name (e.g. "deploys.md"). Defaults to the MEMORY.md index. No subdirectories.'
      },
      content: {
        type: 'string',
        description: 'Full-write mode: the entire new file contents (Markdown). Replaces the file.'
      },
      oldString: {
        type: 'string',
        description: 'Edit mode: exact text to replace; must occur exactly once in the target memory file.'
      },
      newString: { type: 'string', description: 'Edit mode: the replacement text ("" to delete the matched text).' }
    })
  }
]

/** The memory tool names — used to strip them for a `native`-memory agent (which
 *  uses the runtime's own memory instead). */
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name))

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
  }
]

/**
 * Stable AgentConnect record tools for an external-memory provider. These names,
 * descriptions, and argument schemas are core-owned: raw plugin tools are never
 * copied into a model session. Optional write/read actions are projected only
 * when the reviewed manifest declares the corresponding capability.
 */
const EXTERNAL_MEMORY_TOOLS: Readonly<Record<'recall' | 'create' | 'get' | 'update' | 'delete', ToolDescriptor>> = {
  recall: {
    name: 'searchMemory',
    description:
      'Search your durable external memory for records relevant to a query. The daemon supplies your trusted agent scope automatically; do not put an agent or user id in the query.',
    inputSchema: obj(
      {
        query: { type: 'string', minLength: 1, description: 'What durable information to search for.' },
        topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Optional maximum result count.' },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 32768,
          description: 'Optional total text budget for results.'
        }
      },
      ['query']
    )
  },
  create: {
    name: 'saveMemory',
    description:
      'Save one durable memory record for future sessions. Store a concise, self-contained fact or decision; the daemon supplies your trusted agent scope automatically.',
    inputSchema: obj(
      {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 131072,
          description: 'The durable fact or decision to save.'
        },
        metadata: {
          type: 'object',
          description: 'Optional small JSON metadata object. Do not copy credentials or large payloads here.',
          additionalProperties: true
        }
      },
      ['text']
    )
  },
  get: {
    name: 'getMemory',
    description: 'Get one durable memory record by the opaque record id returned by searchMemory or saveMemory.',
    inputSchema: obj(
      { id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' } },
      ['id']
    )
  },
  update: {
    name: 'updateMemory',
    description:
      'Replace one durable memory record by id. Pass the version returned by searchMemory/getMemory when present so a concurrent edit fails instead of being overwritten.',
    inputSchema: obj(
      {
        id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 131072,
          description: 'Complete replacement text for the record.'
        },
        metadata: { type: 'object', description: 'Optional replacement JSON metadata.', additionalProperties: true },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Optional backend version/ETag from the record being edited.'
        }
      },
      ['id', 'text']
    )
  },
  delete: {
    name: 'deleteMemory',
    description:
      'Delete one durable memory record by id. Pass the version returned by searchMemory/getMemory when present so a backend that supports conditional delete can reject a stale request.',
    inputSchema: obj(
      {
        id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Optional backend version/ETag from the record being deleted.'
        }
      },
      ['id']
    )
  }
}

const EXTERNAL_MEMORY_TOOL_OPERATIONS = ['recall', 'create', 'get', 'update', 'delete'] as const

export function externalMemoryTools(capabilities: ReadonlySet<MemoryPluginOperation>): ToolDescriptor[] {
  return EXTERNAL_MEMORY_TOOL_OPERATIONS.filter((operation) => capabilities.has(operation)).map(
    (operation) => EXTERNAL_MEMORY_TOOLS[operation]
  )
}

export const EXTERNAL_MEMORY_TOOL_NAMES = new Set(
  EXTERNAL_MEMORY_TOOL_OPERATIONS.map((operation) => EXTERNAL_MEMORY_TOOLS[operation].name)
)

/**
 * Agent-collaboration tools — available to EVERY agent regardless of platform
 * (discovery is org-level, not platform- or channel-gated). `listAgents` asks the CP
 * which peers this agent may reach in its organization so it can find someone to work
 * with; channel membership is only an optional filter on that answer. Waking a peer is
 * no longer a separate tool: it is `sendMessage` with `to.toAgent` (session-concept §4).
 * The requesting agent's identity is injected by the daemon from the session context —
 * it is NOT a tool input.
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
  'List the other AI agents you can work with — their id, name, displayName, description, and status — so you ' +
  'can discover peers to collaborate with. By DEFAULT this lists every agent in your organization that you are ' +
  'allowed to reach, whether or not it shares a channel with you. This is the canonical meaning of "the agents ' +
  'here": whenever you are asked to greet, message, collaborate with, or delegate to the agents/peers around you, ' +
  'discover them with THIS tool — NOT `listChannelMembers` (which lists platform user/bot accounts, not ' +
  'AgentConnect agents). Then reach each one with `sendMessage` using ' +
  '`{"to":{"toAgent":"<agent id>"},"message":"..."}` (a direct, postless wake), rather than @mentioning member ids ' +
  'in a channel post. Pass `channel` only as a FILTER, to narrow the list to the agents present in that channel. ' +
  'Only agents you are allowed to reach are returned.'

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
      'Check whether a session YOU started is still working. Pass the `childSessionId` a `sendMessage` peer wake ' +
      'returned. Returns `{ sessionId, agentId, status, … }` where `status` is "in-progress" (queued or a turn is ' +
      'running), "done" (its last turn finished cleanly), or "failed" (its last turn ended in an error). This is ' +
      'scoped to YOUR children: sessions you did not start — including your own and unrelated agents’ — cannot be ' +
      'read, and asking for one is an error. `done` means the child ended its turn, not that it reported anything ' +
      'back; wake it with `needsReply` if you want its result delivered to you. Works for a peer on another machine ' +
      'too, where a transient "not reachable" error means retry, not that the session is gone. Poll sparingly, and ' +
      'prefer waiting for the child’s reply over a tight polling loop.',
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
  },
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
 * Formal GitHub PR review effect. The descriptor may remain attached to a
 * long-lived per-thread ACP session, but availability is not authorization:
 * execution resolves the daemon-private active hook turn and fails closed for
 * every ordinary/non-PR/policy-off turn. The target is intentionally absent.
 */
export const GITHUB_REVIEW_TOOLS: ToolDescriptor[] = [
  {
    name: 'submitGithubReview',
    description:
      'Submit the formal review for the active GitHub pull-request hook turn. The repository, pull request, and ' +
      'commit are fixed by trusted turn metadata and cannot be selected here. Use COMMENT for a formal non-blocking ' +
      'review, REQUEST_CHANGES for a failing review, or APPROVE for a passing review. This tool is unavailable ' +
      'outside an authorized active PR hook turn, and at most one review can be submitted per turn. The review body ' +
      'is the complete public response: once an attempt starts, only a definite not_submitted result preserves the ordinary-comment fallback.',
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
  }
]

export const ALL_TOOL_NAMES = [
  ...new Set(
    [
      ...SESSION_TOOLS,
      // platform-neutral tools — descriptors are built per-agent, but the names
      // are stable and belong in the permission auto-allow set.
      buildSendMessageTool([]),
      ...buildReadTools([]),
      ...SLACK_FILE_TOOLS,
      ...TELEGRAM_FILE_TOOLS,
      ...MEMORY_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...Object.values(EXTERNAL_MEMORY_TOOLS),
      ...COLLABORATION_TOOLS,
      ...GITHUB_REVIEW_TOOLS
    ].map((t) => t.name)
  )
]

/**
 * The default MCP tool set for an agent. Memory and collaboration tools are
 * always present; the session-title fallback is opt-in for whitelisted runtimes,
 * and platform tools are gated by the agent's integrations. The channel/user
 * read helpers are platform-neutral (one set, routed by a `platform` argument);
 * only the per-platform file-read tools are gated per platform.
 */
export function toolsForIntegrations(
  integrations: Integration[],
  options: { sessionTitle?: boolean; collaboration?: boolean; organizationKnowledge?: boolean } = {}
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
  const collaboration = options.collaboration !== false
  if (collaboration) add(COLLABORATION_TOOLS)
  // The unified `sendMessage` tool is ALWAYS present (session-concept §3): even a
  // memory-only agent with no platform integration can wake a peer (`toAgent`) or reply to
  // its origin (`sessionId`). The `platform` enum is narrowed to the agent's own platforms
  // so it can post to any of them (empty ⇒ no channel posting, only wake/reply).
  const platforms = [...new Set(integrations.map((i) => i.platform))]
  // In a collaboration-off evaluation treatment, preserve the ordinary visible
  // channel-send branch but remove peer/session targets. A platform-free agent then
  // has no meaningful send target and receives no sendMessage descriptor at all.
  if (collaboration || platforms.length > 0) add([buildSendMessageTool(platforms, collaboration)])
  // Platform read helpers only make sense once the agent has at least one integration.
  if (platforms.length > 0) {
    add(buildReadTools(platforms))
  }
  if (integrations.some((i) => i.platform === 'slack')) add(SLACK_FILE_TOOLS)
  if (integrations.some((i) => i.platform === 'telegram')) add(TELEGRAM_FILE_TOOLS)
  return tools
}
