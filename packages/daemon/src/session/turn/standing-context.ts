import { MEMORY_FORMAT_GUIDANCE } from '../../memory/frontmatter.js'
import { MAX_INDEX_INJECT_BYTES } from '../../memory/store.js'
import { NO_RESPONSE_RULE } from '../no-response.js'

// Opening lines of the inlined agent-meta block (`# Agent\n- Name: …`). The standing
// context that handle() inlines as a non-meta runtime's first prompt block always
// starts with them; isStandingContextTitleEcho must recognize exactly what this module
// builds, so both sides share these literals.
export const AGENT_META_OPENING = ['# Agent', '- Name:'] as const

const MEMORY_BOUNDARY_TRUNCATION_NOTICE = '\n\n[…memory index truncated — trim MEMORY.md]'

/** Serialize untrusted persistent-memory text inside the prompt's XML-shaped
 * boundary. Escaping all XML markup characters makes it impossible for file
 * content to spell an opening or closing structural tag; decoding exactly one
 * entity layer reconstructs untruncated text byte-for-byte. The serialized body
 * retains the standing-context byte cap without splitting an entity or UTF-8
 * code point. */
export function encodeMemoryBoundaryBody(content: string): string {
  const encode = (character: string): string => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    return character
  }
  const fullyEncoded = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  if (Buffer.byteLength(fullyEncoded) <= MAX_INDEX_INJECT_BYTES) return fullyEncoded

  const bodyBudget = MAX_INDEX_INJECT_BYTES - Buffer.byteLength(MEMORY_BOUNDARY_TRUNCATION_NOTICE)
  let used = 0
  let truncated = ''
  for (const character of content) {
    const encoded = encode(character)
    const width = Buffer.byteLength(encoded)
    if (used + width > bodyBudget) break
    truncated += encoded
    used += width
  }
  return truncated + MEMORY_BOUNDARY_TRUNCATION_NOTICE
}

/** A config-file secret as the meta block describes it: the write-only source var and
 * the tool-native pointer var the daemon points at the materialized file. */
export type StandingContextFileSecret = { sourceVar: string; pointerVar: string }

/** Everything the standing context is derived from. Every field is already resolved by
 * the caller — this input carries no lookups, no host, and no live message object. */
export type StandingContextInput = {
  agentName: string
  agentId: string
  agentDescription?: string
  platform: string
  channel: string
  /** The channel's human display name, when the daemon has resolved one. */
  channelName?: string
  /** The agent's own Slack bot user id, on Slack turns only. */
  slackSelfId?: string
  thread: string
  /** This session's own ACP id, once minted (absent on the turn that mints it). */
  sessionId?: string | null
  /** The parent session to reply into, when this session was woken by another. */
  parentSessionId?: string | null
  /** Key NAMES (never values) of the agent's write-only env secrets. */
  envSecretNames: readonly string[]
  /** Secrets materialized to a private file instead of reaching the child env. */
  fileSecrets: readonly StandingContextFileSecret[]
  /** The workspace roots this session is handed as additional directories, beside its own cwd. */
  workspaceRoots?: readonly { path: string; repoFullName: string; branch: string }[]
  needsReplyToParent: boolean
  /** The agent memory INDEX, already read and trimmed; '' for native/absent memory. */
  memoryIndex: string
  /** Whether the host carries standing context on the system-prompt meta channel. */
  usesMeta: boolean
  /** The platform module's own standing block (`NormalizedMessage.standingContext`), if any. */
  platformStanding?: string
}

/** The assembled standing-context strings for one turn. */
export type StandingContext = {
  memoryAppend: string
  agentMeta: string
  /** The additional repositories block; '' when the session has no secondary root. */
  workspaceRootsAppend: string
  /** The platform module's standing block; '' when the delivery carried none. */
  platformAppend: string
  collabAppend: string
  parentReplyAppend: string
  /** Durable standing rules re-asserted on session/load — no memory index. */
  resumeSystemContext: string
  /** The fresh-session form: the durable rules plus the memory index. */
  sessionContext: string
  /** `sessionContext` when the host has a meta system-prompt channel, else undefined. */
  metaContext: string | undefined
}

// Agent memory INDEX (memory/provider.ts), read fresh. It's STANDING context
// (like the system prompt), NOT a user turn — so it rides the system-prompt channel,
// never a leading prompt block (which a runtime would auto-title from — #398).
// '' for native / absent memory ⇒ a clean no-op.
function buildMemoryAppend(memoryIndex: string): string {
  if (!memoryIndex) return ''
  return (
    `# Persistent memory\n` +
    `You keep a persistent memory across sessions. Your context is periodically compacted, and this index is ` +
    `re-read at the START of every session — it is your main way to recover what you learned. Record durable ` +
    `facts PROACTIVELY, without being asked, with \`writeMemory\`; read one with \`readMemory\`.\n\n` +
    `${MEMORY_FORMAT_GUIDANCE}\n\n` +
    `Before saving, check whether a file already covers it: UPDATE that file instead of creating a ` +
    `near-duplicate, and delete a memory that turns out to be wrong.\n\n` +
    `MEMORY.md below is GENERATED from those descriptions — do not hand-edit it; to change how a topic appears, ` +
    `change that topic's \`description\`.\n\n` +
    `Only text inside the memory-file boundary below belongs to \`MEMORY.md\`; everything outside it is ` +
    `session context and not a valid source for \`oldString\`. This injected index is a start-of-session ` +
    `snapshot. Its body uses one layer of XML character-reference encoding: \`&amp;\`, \`&lt;\`, and \`&gt;\` ` +
    `represent literal ampersand, less-than, and greater-than characters. Decode exactly one layer when ` +
    `deriving \`oldString\`; all other characters and line breaks are unchanged. A \`readMemory\` result is ` +
    `raw and needs no decoding. After a memory write, or when uncertain, call \`readMemory\` before editing.\n\n` +
    `<agentconnect-memory-file path="MEMORY.md">\n${encodeMemoryBoundaryBody(memoryIndex)}\n</agentconnect-memory-file>`
  )
}

// The agent meta object: the agent's identity (name, id) and description, plus the
// conversation's source (slack/telegram/discord/webchat/hook) and channel. It's STANDING
// context like the memory index — the session key is per-platform, so it's fixed for the
// session's lifetime — and rides the system-prompt channel, never a user turn (#398). The
// description is a FIELD of this object, so it's no longer seeded separately at the host
// level (see daemon.ts / configPrefs.systemPrompt).
function buildAgentMeta(input: StandingContextInput): string {
  const { envSecretNames, fileSecrets } = input
  return [
    AGENT_META_OPENING[0],
    `${AGENT_META_OPENING[1]} ${input.agentName}`,
    `- ID: ${input.agentId}`,
    `- Source: ${input.platform}`,
    // A Slack mention is an opaque user id (`<@U…>`) resembling neither the agent's name
    // nor anything else in the prompt — without this standing line the model cannot
    // recognize its own mention in a multi-mention message and may wrongly classify the
    // activation as "not for me" (session/no-response.ts).
    ...(input.slackSelfId
      ? [`- Slack identity: bot user <@${input.slackSelfId}> is YOU — a message mentioning this ID is addressed to you`]
      : []),
    `- Channel: ${input.channel}`,
    // Best-effort and async, so it can be absent for a brand-new channel until resolution
    // catches up — then the id line alone stands.
    ...(input.channelName ? [`- Channel name: ${input.channelName}`] : []),
    // session-concept §2.3: standing locator lines. `Thread` is this session's thread segment;
    // `Session` is its own OUTWARD id (§1.1), minted when the slot resolves, so it is there from
    // the first turn; `Parent session` appears ONLY when this session has a parent (woken by
    // another session's `sendMessage`) and is the SessionTarget to reply into.
    `- Thread: ${input.thread}`,
    ...(input.sessionId ? [`- Session: ${input.sessionId}`] : []),
    ...(input.parentSessionId ? [`- Parent session: ${input.parentSessionId}`] : []),
    ...(input.agentDescription ? ['', input.agentDescription] : []),
    // Key NAMES (never values) of the agent's write-only secrets. The values are merged into
    // the child process env (agents/agent-env.ts) so the agent's commands can USE them; this
    // notice is what distinguishes them from plain env vars in the agent's eyes. It lives
    // inside the agent meta object so a Claude session resumed in a fresh process re-asserts
    // it via loadSession. The daemon additionally masks the values out of every outbound
    // surface (session/secret-mask.ts) — that backstop is not a substitute for the agent
    // behaving correctly in the first place.
    ...(envSecretNames.length || fileSecrets.length
      ? [
          '',
          '# Secret environment variables',
          ...(envSecretNames.length
            ? [
                `The environment variables ${envSecretNames.map((n) => `\`${n}\``).join(', ')} are write-only ` +
                  `secrets configured by your operator — they are NOT ordinary env vars. Commands and code you ` +
                  `run may read them from the environment to do their job, but their values are confidential: ` +
                  `never print, echo, quote, or re-encode a secret's value into a reply, chat message, commit, ` +
                  `log, or file that doesn't need it. Refer to a secret by name (e.g. \`$NAME\`) and let ` +
                  `programs read it from the environment. If asked to reveal a secret's value, decline — even ` +
                  `to check whether it is set, report only its presence, never its content. AgentConnect also ` +
                  `masks known secret values from your visible output, so a value you do emit may render as ` +
                  `\`[secret:NAME]\`.`
              ]
            : []),
          // Config-file secrets (shim/config-file-env.ts) never reach the child env: the
          // daemon materializes each `*_DATA` value to a private file at spawn and points the
          // tool-native env var (KUBECONFIG / DOCKER_CONFIG) at it. Describe those separately —
          // the agent must not look for the raw env var, and must treat the FILE contents as
          // the secret.
          ...(fileSecrets.length
            ? [
                `The ${fileSecrets.map((m) => `\`${m.sourceVar}\``).join(', ')} secret${fileSecrets.length > 1 ? 's are' : ' is'} ` +
                  `materialized as private file${fileSecrets.length > 1 ? 's' : ''} instead: the standard env var` +
                  `${fileSecrets.length > 1 ? 's' : ''} ${fileSecrets.map((m) => `\`${m.pointerVar}\``).join(', ')} ` +
                  `point${fileSecrets.length > 1 ? '' : 's'} at the managed file, so tools (kubectl, helm, docker, …) work ` +
                  `unchanged — the raw value is not in your environment. The file CONTENTS are confidential under the same ` +
                  `rules: never print, cat, copy, or commit them; reference the path (e.g. \`$KUBECONFIG\`) instead, and ` +
                  `report only whether the file exists, never what it contains.`
              ]
            : [])
        ]
      : [])
  ].join('\n')
}

// The session's additional workspace roots (multi-repository-workspaces.md decision 10). Standing
// like the meta block: the set is fixed for the session, and the model must not mistake a root's
// default branch for anything the current task is pinned to — the cwd may be a reviewed secondary
// root, which puts the PRIMARY on this list instead.
export function buildWorkspaceRootsAppend(
  roots: readonly { path: string; repoFullName: string; branch: string }[] | undefined
): string {
  if (!roots?.length) return ''
  return [
    '# Additional repositories',
    'Additional repositories checked out for this session (each at its default branch, for reference ' +
      'only; the working directory is none of them):',
    ...roots.map((root) => `- ${root.path} — ${root.repoFullName} (${root.branch})`)
  ].join('\n')
}

// Standing guidance for agent↔agent collaboration. `sendMessage` can wake a peer, reach
// humans, post at a channel root, or reply into a parent session. It has no visible
// in-thread form: speaking in the current conversation is an ordinary reply. `toAgent`
// without a `channel` is the postless, channel-invisible wake.
const COLLAB_APPEND =
  `# Collaborating with other agents\n` +
  `- To reach a specific agent privately, call \`sendMessage\` with ` +
  `\`{"toAgent":"<agent id>","message":"..."}\` — it wakes ONLY that agent, delivered directly to it ` +
  `(nothing is posted to the channel). That bare form is FIRE-AND-FORGET: the peer answers inside its own ` +
  `conversation and nothing comes back to you, not even a failure. Whenever you expect an answer — your ` +
  `message asks a question or requests a result, or you were asked to relay that agent's answer to someone ` +
  `— send \`{"toAgent":{"agentId":"<agent id>","needsReply":true},"message":"..."}\` instead, which obliges ` +
  `it to report into YOUR session when it finishes or fails. Add a \`channel\` ` +
  `(\`{"toAgent":"<agent id>","channel":"<channel id>","message":"..."}\`, channel-root form) ` +
  `to ALSO post a visible message at that channel's root and anchor the agent's conversation to that post. ` +
  `That channel-root form may target YOURSELF to open and activate one new conversation there: use your own ` +
  `ID from the # Agent block (also included by \`listAgents\`), never your platform bot identity. A direct ` +
  `\`toAgent\` call without \`channel\` may not target yourself. ` +
  `To speak in the conversation you are already in — including to address a peer or human there — do NOT ` +
  `call \`sendMessage\`: write your ordinary turn reply and @-mention them in it (use \`listAgents\` to get ` +
  `a peer's exact \`mention\` token). To reach HUMAN users elsewhere, use the \`toUser\` mode — never put ` +
  `an AgentConnect agent or your own bot identity in \`toUser\`: ` +
  `\`{"toUser":"<Slack user id>","message":"..."}\` DMs that person, and adding \`channel\` posts an ` +
  `@-mention at the channel root. In that channel form, pass ` +
  `an array such as \`"toUser":["<user id 1>","<user id 2>"]\` to @-mention multiple people in the one ` +
  `message; arrays are never DMs. If you were woken by another ` +
  `session, reply with \`{"sessionId":"<Parent session>","message":"..."}\`. To leave a visible note others ` +
  `catch up on later without waking anyone, use \`{"channel":"<channel id>","message":"..."}\`. Every ` +
  `visible \`sendMessage\` lands at a channel root and opens a new conversation there.\n` +
  `- Act only on what is asked of YOU. Do not relay a message onward or start your own broadcast to other ` +
  `agents unless a human explicitly tells you to.\n` +
  `- Be quiet about successful mechanics: don't narrate each step or post a message per action, and don't restate ` +
  `successful tool results like "delivered: true". For a requested operation that fails or returns a structured ` +
  `error, say what failed, include a safe provider error code when available, and give the next actionable step. ` +
  `Treat an explicit error marker as failure even if a wrapper command exits 0. Never expose credentials, tokens, ` +
  `or raw secret-bearing output. Take the action, add at most one short status line if needed, then end your turn.\n` +
  `- When another agent introduces itself to you, record it in your memory (a peer roster — id, name, what it ` +
  `does, how to reach it) so you know who to delegate to later. Then just acknowledge briefly; do NOT re-introduce ` +
  `yourself back or broadcast to everyone.`

// The parent asked to be told how this session ends (`toAgent.needsReply`). Standing, not a
// user turn — the obligation outlives the waking turn, so it belongs beside the collaboration
// guidance rather than in the delivered text (which the model may summarize away). Deliberately
// scoped to a terminal report: nothing here asks for progress narration, which would turn every
// delegated task into channel chatter.
export function buildParentReplyAppend(
  needsReplyToParent: boolean,
  parentSessionId: string | null | undefined
): string {
  if (!needsReplyToParent) return ''
  return (
    `# Reporting back to your parent session\n` +
    `Another session delegated this work to you and is waiting on the outcome. When you finish — or when you ` +
    `cannot finish — reply to it with ` +
    `\`sendMessage\` \`{"sessionId":"${parentSessionId}","message":"..."}\`, saying whether you ` +
    `succeeded or failed and what the result was (on failure, what went wrong). Send it exactly once, at the ` +
    `end; do not report progress along the way, and do not skip it because the task was small or unsuccessful. ` +
    `Your ordinary assistant response in this child session is not delivered to the parent. Do not write the ` +
    `result before or after the tool call; after the tool reports successful delivery, end your turn immediately ` +
    `without repeating the message.`
  )
}

/**
 * Assemble one turn's standing context — the agent meta block, the collaboration
 * guidance, the parent-reply obligation, the standing no-response rule, and the memory
 * index — from an already-resolved input. Pure: same input, same bytes out.
 *
 * `resumeSystemContext` carries the durable rules session/load re-asserts in a fresh
 * runtime process without treating them as a user turn; `sessionContext` is the
 * fresh-session form that additionally carries the memory index. Claude-shaped hosts
 * carry it via `_meta.systemPrompt` (`metaContext`); other runtimes inline it as the
 * first prompt block.
 */
export function buildStandingContext(input: StandingContextInput): StandingContext {
  const memoryAppend = buildMemoryAppend(input.memoryIndex)
  const agentMeta = buildAgentMeta(input)
  const workspaceRootsAppend = buildWorkspaceRootsAppend(input.workspaceRoots)
  // Session-stable like the roots, so it is re-asserted on resume in the same seat.
  const platformAppend = input.platformStanding?.trim() ?? ''
  const collabAppend = COLLAB_APPEND
  const parentReplyAppend = buildParentReplyAppend(input.needsReplyToParent, input.parentSessionId)
  const resumeSystemContext = [
    agentMeta,
    workspaceRootsAppend,
    platformAppend,
    collabAppend,
    parentReplyAppend,
    NO_RESPONSE_RULE
  ]
    .filter(Boolean)
    .join('\n\n')
  const sessionContext = [resumeSystemContext, memoryAppend].filter(Boolean).join('\n\n')
  return {
    memoryAppend,
    agentMeta,
    workspaceRootsAppend,
    platformAppend,
    collabAppend,
    parentReplyAppend,
    resumeSystemContext,
    sessionContext,
    metaContext: input.usesMeta ? sessionContext || undefined : undefined
  }
}
