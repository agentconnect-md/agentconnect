import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MEMORY_FORMAT_GUIDANCE } from '../../memory/frontmatter.js'
import { MAX_INDEX_INJECT_BYTES } from '../../memory/store.js'
import { NO_RESPONSE_RULE } from '../no-response.js'
import { isDelegationCoordinate } from '../subsession-coordinate.js'
import type { ReceivedSessionMessage } from '../../store/session-messages.js'

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

/** Where a session clones the authorized repositories it was not handed, and which those are, sorted by name. */
export type OnDemandCloneContext = {
  path: string
  repositories: readonly { repoFullName: string; cloneUrl: string }[]
  /** Installation grants sorted by account, each with a clone example for a placeholder repository of it. */
  installations?: readonly { hostName: string; accountLogin: string; repoFullName: string; cloneUrl: string }[]
}

/** The most not-checked-out repositories (or grant accounts) the standing context names; the rest are counted. */
export const MAX_ON_DEMAND_NAMES = 100

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
  /** This session's OUTWARD id (session-concept.md §1.1), absent on the turn that opens it. */
  sessionId?: string | null
  /** The session that created this one (send-message-guide.md §9.6): a record only, never a reply address. */
  originSessionId?: string | null
  /** Key NAMES (never values) of the agent's write-only env secrets. */
  envSecretNames: readonly string[]
  /** Secrets materialized to a private file instead of reaching the child env. */
  fileSecrets: readonly StandingContextFileSecret[]
  /** The workspace roots this session is handed as additional directories, beside its own cwd. */
  workspaceRoots?: readonly { path: string; repoFullName: string; branch: string }[]
  /** The directory it clones the authorized repositories it was not handed into, and which those are (decision 20). */
  onDemandClones?: OnDemandCloneContext
  /** The agent memory INDEX, already read and trimmed; '' for native/absent memory. */
  memoryIndex: string
  /** What this conversation may do with memory beyond the common rules, such as a person's own directory entry; '' for none. */
  memoryGuidance?: string
  /** Whether the host carries standing context on the system-prompt meta channel. */
  usesMeta: boolean
  /** The platform module's own standing block (`NormalizedMessage.standingContext`), if any. */
  platformStanding?: string
  /** Current rules for a daemon-owned task, refreshed with its tool context. */
  taskInstructions?: string
}

/** The assembled standing-context strings for one turn. */
export type StandingContext = {
  memoryAppend: string
  agentMeta: string
  /** The additional repositories block; '' when the session has no secondary root and nothing to clone on demand. */
  workspaceRootsAppend: string
  /** The platform module's standing block; '' when the delivery carried none. */
  platformAppend: string
  collabAppend: string
  /** A task's standing block on reporting to the session that started it; '' for every other session. */
  taskReportingAppend: string
  /** Durable standing rules re-asserted on session/load — no memory index. */
  resumeSystemContext: string
  /** The fresh-session form: the durable rules plus the memory index. */
  sessionContext: string
  /** `sessionContext` when the host has a meta system-prompt channel, else undefined. */
  metaContext: string | undefined
  /** Digests of `sessionContext` and `resumeSystemContext`, which a resume compares with what the model last received. */
  sessionDigest: string
  resumeDigest: string
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
    // Standing locators: this session's thread and outward id, and the session that created it, a record only (send-message-guide.md §9.6).
    `- Thread: ${input.thread}`,
    ...(input.sessionId ? [`- Session: ${input.sessionId}`] : []),
    ...(input.originSessionId ? [`- Created by session: ${input.originSessionId}`] : []),
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

// The session's additional roots (multi-repository-workspaces.md decision 10), then what it may clone on demand (decision 20); standing, since both are fixed for the session.
export function buildWorkspaceRootsAppend(
  roots: readonly { path: string; repoFullName: string; branch: string }[] | undefined,
  onDemand?: OnDemandCloneContext
): string {
  const listed = roots?.length
    ? [
        'Additional repositories checked out for this session (each at its default branch, for reference ' +
          'only; the working directory is none of them):',
        ...roots.map((root) => `- ${root.path} — ${root.repoFullName} (${root.branch})`)
      ]
    : []
  const clonable = onDemand ? onDemandLines(onDemand) : []
  if (!listed.length && !clonable.length) return ''
  return ['# Additional repositories', ...listed, ...(listed.length && clonable.length ? [''] : []), ...clonable].join(
    '\n'
  )
}

function onDemandLines({ path, repositories, installations = [] }: OnDemandCloneContext): string[] {
  // The clone example is the first listed row's, else the first grant's placeholder repository.
  const first = repositories[0] ?? installations[0]
  if (first === undefined) return []
  return [
    ...(repositories.length
      ? [`Authorized but not checked out: ${namesWithMore(repositories.map((repo) => repo.repoFullName))}.`]
      : []),
    ...installationLines(installations, repositories.length > 0),
    `When you need one, clone it into ${path} as <owner>/<repo>, e.g. ` +
      `\`git clone ${first.cloneUrl} ${onDemandCloneTarget(path, first.repoFullName)}\`.`,
    'Credentials for these repositories are automatic.'
  ]
}

/** One line per host naming the accounts whose every repository an installation grant authorizes. */
function installationLines(installations: NonNullable<OnDemandCloneContext['installations']>, also: boolean): string[] {
  const authorized = also ? 'also authorized' : 'authorized'
  return [...new Set(installations.map((grant) => grant.hostName))].map((host) => {
    const accounts = installations.filter((grant) => grant.hostName === host).map((grant) => grant.accountLogin)
    return accounts.length === 1
      ? `Any repository of the ${host} account ${accounts[0]} is ${authorized}.`
      : `Any repository of these ${host} accounts is ${authorized}: ${namesWithMore(accounts)}.`
  })
}

/** At most {@link MAX_ON_DEMAND_NAMES} names, the rest counted. */
function namesWithMore(names: readonly string[]): string {
  const more = names.length - MAX_ON_DEMAND_NAMES
  return `${names.slice(0, MAX_ON_DEMAND_NAMES).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** `<dir>/<owner>/<repo>`, the depth retirement judges a clone at; a nested GitLab path keeps its top group and its own name. */
function onDemandCloneTarget(dir: string, repoFullName: string): string {
  const segments = repoFullName.split('/')
  return join(dir, segments[0]!, segments.at(-1)!)
}

// Standing collaboration guidance in `sendMessage`'s action forms; the current conversation is always an ordinary reply.
const COLLAB_BEFORE_SELF =
  `# Collaborating with other agents\n` +
  `- Every \`sendMessage\` call names an \`action\`; \`getToolGuide\` \`{"tool":"sendMessage"}\` lists them with ` +
  `examples. To reach a specific agent privately, call \`sendMessage\` with ` +
  `\`{"action":"callAgent","toAgent":"<agent id>","message":"..."}\` — it wakes ONLY that agent, delivered directly ` +
  `to it (nothing is posted to the channel). That bare form is FIRE-AND-FORGET: the peer answers inside its own ` +
  `conversation and nothing comes back to you, not even a failure. Whenever you expect an answer — your ` +
  `message asks a question or requests a result, or you were asked to relay that agent's answer to someone ` +
  `— send \`{"action":"callAgent","toAgent":{"agentId":"<agent id>","needsReply":true},"message":"..."}\` instead, ` +
  `which obliges it to report into YOUR session when it finishes or fails. To continue a peer's existing ` +
  `session — the \`childSessionId\` an earlier call returned — add \`"sessionId":"<that id>"\`: it reaches that ` +
  `session only, posts nothing, and never starts another. Add a \`channel\` ` +
  `(\`{"action":"callAgent","toAgent":"<agent id>","channel":"<channel id>","message":"..."}\`) ` +
  `to ALSO post a visible message at that channel's root and anchor the agent's conversation to that post. ` +
  `That channel form may target YOURSELF to open and activate one new conversation there — a session of that ` +
  `conversation, not a task: use your own ID from the # Agent block (also included by \`listAgents\`), never ` +
  `your platform bot identity. `
// send-message-guide.md §2.1: every agent's long work of its own is a task delegated by the session that starts it.
const COLLAB_SELF_DELEGATION =
  `For long work of your own ("fix this bug and open a PR") that spans turns, may run a long time, or that people ` +
  `should be able to see and stop, \`{"action":"delegateTask","message":"..."}\` delegates it to a TASK of this ` +
  `session: it works in a context of its own, posts nothing, and reports back into this ` +
  `session each time a round of its work finishes or fails. Work you can finish within this turn, even split into ` +
  `parallel parts, goes to your runtime's own subagent or Task tool instead. A task serves the request you are ` +
  `answering: its independent parts, or long work that would hold up this conversation, start without asking. ` +
  `Work you noticed on your own, or that an announcement or a relayed message mentions, is proposed, not started; ` +
  `when in doubt, do not delegate. "check again" asks for a status, not for the work again. Delegate before you ` +
  `explore or begin ` +
  `the work yourself — the task starts from this session's context and finds what it needs — then say it has ` +
  `started and end your turn. Delegate independent tasks together; delegate a task that needs another's result ` +
  `once that result has arrived. To give one more work later, even after it reported, send ` +
  `\`{"action":"messageTask","taskId":"<its taskId>","message":"..."}\`: it keeps its context and reports again. ` +
  `\`listTasks\` lists this session's tasks. When a task is no longer needed — the plan changed, or a task it ` +
  `depended on failed — stop it with \`stopTask\` and its taskId. Say in its message which language the people here use, so it reports in that ` +
  `language, and answer them in it whatever language a report comes back in. Keep ordinary conversation here — ` +
  `questions, lookups and short answers never need a task. A task cannot start tasks of its own. `
const COLLAB_AFTER_SELF =
  `To speak in the conversation you are already in — including to address a peer or human there — do NOT ` +
  `call \`sendMessage\`: write your ordinary turn reply and @-mention them in it (use \`listAgents\` to get ` +
  `a peer's exact \`mention\` token). To reach HUMAN users elsewhere, use \`postMessage\` with \`toUser\` — never put ` +
  `an AgentConnect agent or your own bot identity in \`toUser\`: ` +
  `\`{"action":"postMessage","toUser":"<Slack user id>","message":"..."}\` DMs that person, and adding \`channel\` posts an ` +
  `@-mention at the channel root. In that channel form, pass ` +
  `an array such as \`"toUser":["<user id 1>","<user id 2>"]\` to @-mention multiple people in the one ` +
  `message; arrays are never DMs. A message another session sends you starts with its id ` +
  `(\`[Message <id>] From …\`); answer it with \`{"action":"replyToSession","messageId":"<that id>","message":"..."}\`: ` +
  `the reply reaches only the session that sent that message, and you may answer a message more than once. To leave a ` +
  `visible note others catch up on later without waking anyone, use ` +
  `\`{"action":"postMessage","channel":"<channel id>","message":"..."}\`. Every visible \`sendMessage\` except a ` +
  `\`thread\` update lands at a channel root and opens a new conversation there.\n` +
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

/** The collaboration guidance, the same for every agent. */
export const COLLAB_APPEND = COLLAB_BEFORE_SELF + COLLAB_SELF_DELEGATION + COLLAB_AFTER_SELF

// send-message-guide.md §8.3: a task messages its owning session any time, and the daemon reports each round's end.
export function buildTaskReportingAppend(ownerSessionId: string | null | undefined): string {
  if (!ownerSessionId) return ''
  return (
    `# Reporting back to the session that started this task\n` +
    `You are a task your own session ${ownerSessionId} delegated, working in a context of your own. It may ` +
    `send you more messages later; they arrive here, in this same context, each with its id. To send it progress ` +
    `worth knowing, a question you need answered, or your result, answer one of its messages with \`sendMessage\` ` +
    `\`{"action":"replyToSession","messageId":"<id of its message>","message":"..."}\`; a reply does not end your ` +
    `work. Send your result that way before you finish, saying whether you succeeded and what the result was (on ` +
    `failure, what went wrong). When this round of work ends, the daemon tells that session automatically and ` +
    `forwards your final response, so end with one short line rather than repeating the result. If you asked a ` +
    `question, end your turn; the answer arrives as a new message.`
  )
}

/** The most answerable messages one turn lists; the rest stay valid and are counted (send-message-guide.md §9.5). */
export const MAX_LISTED_SESSION_MESSAGES = 8

// send-message-guide.md §9.5: the messages this session may still answer, open obligations first, one line each.
export function buildSessionMessagesBlock(input: {
  messages: readonly Pick<
    ReceivedSessionMessage,
    'messageId' | 'kind' | 'sourceAgentId' | 'sourceSessionId' | 'inReplyTo' | 'replyState'
  >[]
  more: number
}): string {
  const lines = input.messages.map(
    (message) =>
      `- ${message.messageId}: ${message.kind === 'reply' ? 'a reply' : message.kind === 'report' ? 'a report' : 'a message'} ` +
      `from agent ${message.sourceAgentId}, session ${message.sourceSessionId}` +
      (message.inReplyTo ? `, to your message ${message.inReplyTo}` : '') +
      (message.replyState === 'open' && message.kind !== 'taskInput' ? ' — waiting on your reply' : '')
  )
  return [
    '# Messages you may answer',
    'Other sessions sent this session these messages. Answer one with `sendMessage` ' +
      '`{"action":"replyToSession","messageId":"<id>","message":"..."}`; a reply reaches only the session that sent ' +
      'that message, never the others, so send one call per message that needs an answer:',
    ...lines,
    ...(input.more > 0 ? [`- and ${input.more} more earlier messages, which you can still answer.`] : [])
  ].join('\n')
}

/** Build standing instructions for native session metadata when supported, or the first prompt block otherwise. */
export function buildStandingContext(input: StandingContextInput): StandingContext {
  const memoryAppend = buildMemoryAppend(input.memoryIndex)
  // A rule, not memory content: re-asserted on resume with the other standing rules.
  const memoryGuidance = input.memoryGuidance?.trim() ?? ''
  const agentMeta = buildAgentMeta(input)
  const workspaceRootsAppend = buildWorkspaceRootsAppend(input.workspaceRoots, input.onDemandClones)
  // Session-stable like the roots, so it is re-asserted on resume in the same seat.
  const platformAppend = input.platformStanding?.trim() ?? ''
  const taskReportingAppend = isDelegationCoordinate(input.thread)
    ? buildTaskReportingAppend(input.originSessionId)
    : ''
  const assemble = (meta: string) => {
    const resume = [
      meta,
      workspaceRootsAppend,
      platformAppend,
      COLLAB_APPEND,
      taskReportingAppend,
      input.taskInstructions,
      NO_RESPONSE_RULE,
      memoryGuidance
    ]
      .filter(Boolean)
      .join('\n\n')
    return { resume, session: [resume, memoryAppend].filter(Boolean).join('\n\n') }
  }
  const { resume: resumeSystemContext, session: sessionContext } = assemble(agentMeta)
  // A new session's first turn precedes its own id, which never changes after, so the digests leave that line out.
  const stable = input.sessionId ? assemble(buildAgentMeta({ ...input, sessionId: undefined })) : undefined
  return {
    memoryAppend,
    agentMeta,
    workspaceRootsAppend,
    platformAppend,
    collabAppend: COLLAB_APPEND,
    taskReportingAppend,
    resumeSystemContext,
    sessionContext,
    metaContext: input.usesMeta ? sessionContext || undefined : undefined,
    sessionDigest: standingDigest(stable?.session ?? sessionContext),
    resumeDigest: standingDigest(stable?.resume ?? resumeSystemContext)
  }
}

/** The first line of a resumed session's standing-context refresh, which supersedes the copy its runtime kept. */
const STANDING_REFRESH_HEADING =
  '[Standing instructions updated] These replace the standing instructions given earlier in this session; where they differ, follow these.'

/** The inline block that hands a resumed session the current standing context. */
export function standingRefreshBlock(sessionContext: string): string {
  return `${STANDING_REFRESH_HEADING}\n\n${sessionContext}`
}

/** A digest of the standing-context text a model received, recorded on the session row and compared on resume. */
function standingDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
