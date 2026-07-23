import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk'
import { LocalStore, sessionKey } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { prepareWorkspace } from '../workspace/workspace-manager.js'
import { memoryKindOf, type MemoryProvider } from '../agents/memory-provider.js'
import { agentChildEnv } from '../agents/agent-env.js'
import { planConfigFiles } from '../agents/config-file-env.js'
import { recalledMemoryBlock, recallQueryFromBlocks, sanitizeRecallRecords } from '../agents/memory-recall.js'
import type { AcpHost } from '../acp/acp-host.js'
import type { Agent } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { Attachment, NormalizedMessage } from '../messages/normalized.js'
import { buildAttachmentBlocks, attachmentMention } from './attachment-block.js'
import { EXPLICIT_MENTION_REMINDER, NO_RESPONSE_RULE, NO_RESPONSE_REMINDER } from './no-response.js'

/** Metadata-only semantic lifecycle for one provider-neutral recall attempt. Query
 * and recalled record bodies deliberately stay out of this observer contract. */
export type MemoryRecallLifecycleEvent =
  | {
      kind: 'requested'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      topK: number
      maxBytes: number
      timeoutMs: number
    }
  | {
      kind: 'completed'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      recordCount: number
      injectedBytes: number
    }
  | {
      kind: 'failed'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      errorName: string
      timedOut: boolean
      aborted: boolean
    }

// Cap on transcript entries replayed as catch-up context in one prompt (§8.5),
// so a long-quiet thread / large backfilled history can't blow up the prompt.
const MAX_REPLAY_ENTRIES = 50

/** Slack's canonical timestamp is decimal seconds with microsecond precision. Keep
 * comparison string-safe (Number cannot represent every microsecond at today's epoch). */
function slackTsMicros(ts: string): bigint | null {
  const m = /^(\d+)\.(\d{1,6})$/.exec(ts)
  if (!m) return null
  return BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!.padEnd(6, '0'))
}

function compareSlackTs(a: string, b: string): number {
  const am = slackTsMicros(a)
  const bm = slackTsMicros(b)
  // Legacy synthetic coordinates (notably pre-fix anchored cron UUIDs) sort
  // before real Slack timestamps. A real follow-up must never look older than
  // the synthetic cursor that created its thread.
  if (am === null && bm === null) return a.localeCompare(b)
  if (am === null) return -1
  if (bm === null) return 1
  return am < bm ? -1 : am > bm ? 1 : 0
}

function slackTsForWallClock(ms: number): string {
  const whole = Math.floor(ms / 1_000)
  return `${whole}.${String(Math.floor(ms % 1_000) * 1_000).padStart(6, '0')}`
}

// Re-inject the compact response-choice reminder every this many turns, so the
// rule stays salient on a long-running session (esp. non-Claude runtimes, where the full
// rule rides only the first — eventually compacted — prompt block).
const REMINDER_EVERY_TURNS = 12
// A turn whose tokens-in-context fell below this fraction of the previous turn's is treated
// as a context compaction (ACP has no explicit compaction event — only usage numbers), which
// also triggers an immediate reminder re-injection.
const COMPACTION_DROP_RATIO = 0.5

// Opening lines of the inlined agent-meta block (`# Agent\n- Name: …`). The standing
// context that handle() inlines as a non-meta runtime's first prompt block always
// starts with them; isStandingContextTitleEcho must recognize exactly what handle()
// builds, so both sides share these literals.
const AGENT_META_OPENING = ['# Agent', '- Name:'] as const

/**
 * True when a runtime-pushed session title is actually an echo of the inlined
 * standing context. codex-acp >= 1.1.3 derives a fallback title for an untitled
 * session from the raw prompt text — ALL text blocks of the first `session/prompt`
 * (or the first user message replayed by `session/load`) joined with collapsed
 * whitespace and no length bound. For runtimes without a system-prompt meta
 * channel that prompt STARTS with the standing-context block, so the pushed
 * "title" would surface internal agent/memory context in the console, CP
 * metadata, and Slack thread titles. Recognize the echo so the daemon can drop
 * it instead of persisting it (issue #659).
 */
export function isStandingContextTitleEcho(title: string): boolean {
  return title.replace(/\s+/g, ' ').trimStart().startsWith(AGENT_META_OPENING.join(' '))
}

function interrupted(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'session initialization interrupted')
}

/** Await one initialization seam with a turn-scoped abort fence. The underlying I/O may
 *  finish later, but its continuation cannot resume SessionManager.handle after abort. */
function abortable<T>(start: () => PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(start)
  if (signal.aborted) return Promise.reject(interrupted(signal))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(interrupted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(start)
      .then(
        (result) => {
          cleanup()
          resolve(result)
        },
        (err) => {
          cleanup()
          reject(err)
        }
      )
  })
}

export class SessionManager {
  constructor(
    private deps: {
      store: LocalStore
      hostFor: (agentId: string) => Promise<AcpHost>
      agentById: (id: string) => LoadedAgent | undefined
      /** The agent memory provider — seeds the memory dir and supplies the index
       *  injected at the start of a fresh session. */
      memory: MemoryProvider
      /** Fail-open recall diagnostics. Must never include query/record/plugin body text. */
      onMemoryRecallError?: (agentId: string, error: unknown) => void
      /** Exact final reference bytes after provider-neutral validation/rendering. */
      onMemoryRecallInjected?: (agentId: string, bytes: number) => void
      /** Metadata-only evaluation/telemetry seam for recall. Observer failures
       *  are contained so they cannot change prompt assembly or fail-open policy. */
      onMemoryRecallEvent?: (agentId: string, event: MemoryRecallLifecycleEvent) => void
      /** Evaluation treatment control. Defaults on for all production callers. */
      memoryEnabled?: boolean
      /** Evaluation treatment control. Defaults on for all production callers. */
      collaborationEnabled?: boolean
      /** Whether this runtime needs AgentConnect's model-authored title fallback.
       *  Native-title runtimes (for example Claude) leave this false. */
      usesSessionTitleTool?: (agent: Agent) => boolean
      /** The runtime-definition env (daemon config `runtimes[].env`) for an agent's
       *  runtime. The spawn path detects config-file pointer-var conflicts over
       *  `{...runtimeEnv, ...agentEnv}` — supply the same base here so the
       *  standing-context description agrees with what actually materialized.
       *  Omitted (e.g. tests) ⇒ agent-level env only. */
      runtimeEnvFor?: (runtimeId: string) => Record<string, string>
      /**
       * Build the default MCP servers to inject for a brand-new ACP session,
       * given its platform binding. Omitted (or returning []) means no tools —
       * e.g. the `chat` CLI, which has no daemon control socket.
       */
      mcpServersFor?: (ctx: {
        agent: Agent
        platform: string
        channel: string
        thread: string
        integrationId?: string
        isDm: boolean
      }) => McpServer[]
      /**
       * Download an inbound attachment's bytes (§9.2) — resolved by the daemon
       * to the owning SlackConnection's bot-token fetch. Omitted in the `chat`
       * CLI / tests, where attachments degrade to baseline resource_link blocks.
       */
      downloadAttachment?: (agentId: string, att: Attachment) => Promise<Buffer | null>
      /** Inline cap (bytes) for attachments; files over it become resource_link. */
      attachmentMaxBytes?: number
      /**
       * Pull the real Slack thread history for a mid-thread @ (§8.4/§9.2). Used to
       * backfill the transcript on first activation in a thread the daemon never
       * saw (e.g. a restart, or a thread the bot is mentioned into cold). The daemon
       * is responsible for relabeling THIS agent's own past bot frames to its
       * agentId (so the §8.5 own-message filter still suppresses them) and folding
       * any attachment mention into `text`.
       */
      fetchThreadHistory?: (
        agentId: string,
        channel: string,
        threadTs: string,
        cutoffTs?: string,
        afterTs?: string | null
      ) => Promise<{ sender: string; ts: string; text: string }[]>
    }
  ) {}

  // Per-session (sessionKey) bookkeeping for response-choice reminder re-injection.
  // In-memory and best-effort: after a daemon restart, the first observed turn of an
  // existing session re-injects immediately. `turnsSinceReminder` counts turns since the
  // last (re)injection; `lastContextUsed` is the previous turn's tokens-in-context, used
  // to spot a compaction drop.
  private readonly turnsSinceReminder = new Map<string, number>()
  private readonly lastContextUsed = new Map<string, number>()

  threadOwner(channel: string, thread: string): string | null {
    const owners = this.deps.store.openSessionAgents(channel, thread)
    // 2+ live owners actively share the thread → ambiguous, fall through to
    // mention-gating (§8.2). Exactly one → thread continuity.
    if (owners.length > 0) return owners.length === 1 ? owners[0]! : null
    // No OPEN session: a follow-up reply in a thread whose session was TTL-`closed`
    // after idle (§7.3) would otherwise route nowhere and be silently dropped. Revive
    // the sole agent that previously owned this thread — SessionManager.handle then
    // recreates/resumes its ACP session. Still gated at exactly one, and the `!stop`
    // mute check downstream (onInbound) keeps a muted thread suppressed regardless.
    const dormant = this.deps.store.closedSessionAgents(channel, thread)
    return dormant.length === 1 ? dormant[0]! : null
  }

  async handle(
    agentId: string,
    msg: NormalizedMessage,
    signal?: AbortSignal,
    integrationId?: string,
    /** session-concept §2.3/§5.3: the origin (parent) session's stable id, present only when
     *  THIS turn was woken by another session's `sendMessage`. Surfaced to the agent as the
     *  `Parent session` line of the `# Agent` block — the SessionTarget it replies into. */
    originSessionId?: string
  ): Promise<{
    sessionId: string
    blocks: ContentBlock[]
    created: boolean
    skipped?: boolean
    /** Bounded normalized text actually delivered this activation, before memory. */
    captureInput?: string
    /** Stable provider-neutral post-turn identity. */
    turnId?: string
  }> {
    const agent = this.deps.agentById(agentId)
    if (!agent) throw new Error(`unknown agent ${agentId}`)
    const usesSessionTitleTool = this.deps.usesSessionTitleTool?.(agent) ?? false
    const memoryEnabled = this.deps.memoryEnabled !== false
    const currentMemoryProvider = memoryEnabled ? memoryKindOf(agent) : 'none'
    // Seed the agent's memory file at its ROOT dir (outside the workspace) if absent,
    // so the prompt injection below and the `updateMemory` tool always have a file.
    if (memoryEnabled) this.deps.memory.ensure({ agentId }, agent.name)
    const { thread, ts: coordTs } = transcriptCoords(msg)
    // webchat's msgId is stable per-conversation, so transcriptCoords yields the SAME ts
    // for every turn — the transcript's (channel,thread,ts) unique index would then dedup
    // every follow-up user message (only the first turn is ever recorded). Stamp each
    // webchat turn with a fresh strictly-monotonic ts (shared with the reply recording in
    // daemon.ts, so the user message and its reply never collide on the same ms) — the
    // whole conversation is recorded, and thread stays stable → one session.
    const ts = msg.platform === 'webchat' ? monotonicTs() : coordTs
    const key = sessionKey(msg.platform, msg.channel, thread, agentId)

    // record the triggering message in the transcript (with an attachment mention
    // so later catch-up replay notes shared files even though bytes aren't stored)
    const mention = attachmentMention(msg.attachments)
    this.deps.store.appendTranscript({
      channel: msg.channel,
      thread,
      ts,
      sender: msg.sender.id,
      // This message was delivered TO this agent (handle() runs for `agentId`), so tag the
      // recipient — the console session view scopes to what THIS agent received + produced.
      recipient: agentId,
      kind: 'text',
      text: mention ? `${msg.text}\n${mention}`.trim() : msg.text
    })

    let rec = this.deps.store.getSession(key)
    if (rec) {
      const persistedMemoryProvider = rec.memoryProvider ?? 'managed'
      if (persistedMemoryProvider !== currentMemoryProvider) {
        rec = {
          ...rec,
          acpSessionId: null,
          memoryProvider: currentMemoryProvider,
          state: rec.state === 'closed' ? 'closed' : 'idle',
          lastDeliveredTs: null,
          updatedAt: Date.now()
        }
        this.deps.store.upsertSession(rec)
      } else if (rec.memoryProvider == null) {
        rec = { ...rec, memoryProvider: currentMemoryProvider }
        this.deps.store.upsertSession(rec)
      }
    }
    // Durable parent link (§5.3): prefer the origin persisted on the session (present on EVERY
    // turn of a spawned session) over this turn's wake origin (only the one agent-call turn that
    // first spawns the session carries it). This value both drives the `Parent session` line and,
    // once persisted, is what authorizes SessionTarget replies to the parent on later
    // human-triggered turns that have no per-turn CallMeta.
    const effectiveOriginSessionId = rec?.originSessionId ?? originSessionId
    // Prepare the workspace (clone/pull + skill install) BEFORE acquiring the host,
    // so `npx skills` lands the enabled skills before the runtime process spawns —
    // runtimes that discover project skills at process init must see them (design §6).
    // The resolved ACP cwd is reused by both the new-session and resume paths below.
    const cwd = await abortable(() => prepareWorkspace(agent), signal)
    const host = await abortable(() => this.deps.hostFor(agentId), signal)
    // The sticky per-session effort override rides session `_meta` on new/load so the
    // `ultracode` sentinel (rejected by the `thought_level` select) takes effect;
    // select-based effort/model/fast overrides layer on afterward at turn start.
    const effortOverride = this.deps.store.getEffortOverride(key)

    // Agent memory INDEX (agents/memory-provider.ts), read fresh. It's STANDING
    // context (like the system prompt), NOT a user turn — so it rides the system-prompt
    // channel, never a leading prompt block (which a runtime would auto-title from — #398).
    // '' for native / absent memory ⇒ a clean no-op. Applied only when THIS call creates
    // a fresh session (a resumed session already carries it from its first turn).
    // Routed to exactly one place: Claude carries it via `_meta.systemPrompt` (metaContext,
    // passed to newSession); other runtimes get it folded into the inline system block below.
    const memoryIndex = memoryEnabled
      ? (await abortable(() => this.deps.memory.standingContextAtSessionStart({ agentId }), signal)).trim()
      : ''
    const memoryAppend = memoryIndex
      ? `# Persistent memory\n` +
        `You keep a persistent memory across sessions. Your context is periodically ` +
        `compacted, and this index is re-read at the START of every session — it is your main way to recover ` +
        `what you learned, so keep it current and self-sufficient. Record durable facts PROACTIVELY, without ` +
        `being asked — conventions, decisions, who to ask, project/channel context, and anything you had to ` +
        `re-learn: revise this index or a topic file with \`writeMemory\` as you go. Read a linked topic with ` +
        `\`readMemory\` when it is relevant. Keep the index short — a scannable list that links to topic files.\n\n` +
        `Only text inside the memory-file boundary below belongs to \`MEMORY.md\`; everything outside it is ` +
        `session context and not a valid source for \`oldString\`. This injected index is a start-of-session ` +
        `snapshot; after a memory write, or when uncertain, call \`readMemory\` before editing.\n\n` +
        `<agentconnect-memory-file path="MEMORY.md">\n${memoryIndex}\n</agentconnect-memory-file>`
      : ''

    // The agent meta object: the agent's identity (name, id) and description, plus the
    // conversation's source (slack/telegram/discord/webchat/hook) and channel. It's
    // STANDING context like the memory index — the session key is per-platform, so it's
    // fixed for the session's lifetime — and rides the system-prompt channel, never a
    // user turn (#398). The description is a FIELD of this object, so it's no longer
    // seeded separately at the host level (see daemon.ts / configPrefs.systemPrompt).
    // The channel's human display name, if the daemon has resolved one (Slack bulk
    // refresh / ChannelNameResolver, cached in `display_names`). Async + best-effort, so
    // it can be absent for a brand-new channel until resolution catches up — then the id
    // line alone stands. Stored bare for a group/channel, `@name` for a DM (same value
    // the console labels with), surfaced as-is.
    const channelName = this.deps.store.getDisplayNames([msg.channel]).get(msg.channel)
    // Key NAMES (never values) of the agent's write-only secrets. The values are merged
    // into the child process env (agents/agent-env.ts) so the agent's commands can USE
    // them; this notice is what distinguishes them from plain env vars in the agent's
    // eyes. It lives inside the agent meta object so a Claude session resumed in a fresh
    // process re-asserts it via loadSession. The daemon additionally masks the values
    // out of every outbound surface (session/secret-mask.ts) — that backstop is not a
    // substitute for the agent behaving correctly in the first place.
    const secretNames = (agent.runtimeOverrides?.secrets ?? []).map((s) => s.name)
    // Config-file secrets (agents/config-file-env.ts) never reach the child env:
    // the daemon materializes each `*_DATA` value to a private file at spawn and
    // points the tool-native env var (KUBECONFIG / DOCKER_CONFIG) at it. Describe
    // those separately — the agent must not look for the raw env var, and must
    // treat the FILE contents as the secret. planConfigFiles over the same
    // `{...runtimeEnv, ...agentEnv}` merge the spawn path uses keeps the two in
    // agreement: a pointer var set explicitly ANYWHERE (agent env or the
    // runtime definition) wins there too, leaving the secret a plain env var.
    const fileSecrets = planConfigFiles({
      ...this.deps.runtimeEnvFor?.(agent.runtime),
      ...agentChildEnv(agent)
    }).materialize.filter((m) => secretNames.includes(m.sourceVar))
    const fileSecretNames = new Set(fileSecrets.map((m) => m.sourceVar))
    const envSecretNames = secretNames.filter((n) => !fileSecretNames.has(n))
    const agentMeta = [
      AGENT_META_OPENING[0],
      `${AGENT_META_OPENING[1]} ${agent.name}`,
      `- ID: ${agent.id}`,
      `- Source: ${msg.platform}`,
      `- Channel: ${msg.channel}`,
      ...(channelName ? [`- Channel name: ${channelName}`] : []),
      // session-concept §2.3: standing locator lines. `Thread` is this session's thread
      // segment; `Session` is its own stable id (only once minted — a brand-new session
      // mints its acpSessionId AFTER this block is composed, so it appears from the next
      // turn / on resume); `Parent session` appears ONLY when this session has a parent
      // (woken by another session's `sendMessage`) and is the SessionTarget to reply into.
      `- Thread: ${thread}`,
      ...(rec?.acpSessionId ? [`- Session: ${rec.acpSessionId}`] : []),
      ...(effectiveOriginSessionId ? [`- Parent session: ${effectiveOriginSessionId}`] : []),
      ...(agent.description ? ['', agent.description] : []),
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
            ...(fileSecrets.length
              ? [
                  `The ${fileSecrets.map((m) => `\`${m.sourceVar}\``).join(', ')} secret${fileSecrets.length > 1 ? 's are' : ' is'} ` +
                    `materialized as private file${fileSecrets.length > 1 ? 's' : ''} instead: the standard env var` +
                    `${fileSecrets.length > 1 ? 's' : ''} ${fileSecrets.map((m) => `\`${m.convention.pointerVar}\``).join(', ')} ` +
                    `point${fileSecrets.length > 1 ? '' : 's'} at the managed file, so tools (kubectl, helm, docker, …) work ` +
                    `unchanged — the raw value is not in your environment. The file CONTENTS are confidential under the same ` +
                    `rules: never print, cat, copy, or commit them; reference the path (e.g. \`$KUBECONFIG\`) instead, and ` +
                    `report only whether the file exists, never what it contains.`
                ]
              : [])
          ]
        : []),
      ...(usesSessionTitleTool
        ? [
            '',
            '# Session naming',
            'Before sending your first substantive answer, after you understand the first meaningful user request ' +
              '(not a greeting or acknowledgement), call `setSessionTitle` with a concise, specific title. Call it ' +
              'again only if the task focus materially changes. Do not mention this housekeeping action.'
          ]
        : [])
    ].join('\n')

    // Standing guidance for agent↔agent collaboration. `sendMessage` with `to.toAgent` is the
    // explicit attention/wake primitive, delivered directly to that agent. Adding a `channel`
    // also posts a visible message and threads the woken agent's reply there; `to.toAgent` alone
    // is a postless, channel-invisible wake.
    const collabAppend =
      this.deps.collaborationEnabled === false
        ? ''
        : `# Collaborating with other agents\n` +
          `- To reach a specific agent privately, call \`sendMessage\` with ` +
          `\`{"to":{"toAgent":"<agent id>"},"message":"..."}\` — it wakes ONLY that agent, delivered directly to it ` +
          `(nothing is posted to the channel). Add a \`channel\` (\`{"to":{"toAgent":"<agent id>","channel":"<channel id>"}}\`) ` +
          `to ALSO post a visible message there and thread that agent's reply under it — use this when the hand-off ` +
          `should be visible to people in the channel. If you were woken by another session, reply with ` +
          `\`{"to":{"sessionId":"<Parent session>"},"message":"..."}\`. To leave a visible note others catch up on ` +
          `later without waking anyone, use \`{"to":{"channel":"<channel id>"},"message":"..."}\`.\n` +
          `- Act only on what is asked of YOU. Do not relay a message onward or start your own broadcast to other ` +
          `agents unless a human explicitly tells you to.\n` +
          `- Be quiet about mechanics: don't narrate each step or post a message per action, and don't restate tool ` +
          `results like "delivered: true". Take the action, add at most one short status line if needed, then end your turn.\n` +
          `- When another agent introduces itself to you, record it in your memory (a peer roster — id, name, what it ` +
          `does, how to reach it) so you know who to delegate to later. Then just acknowledge briefly; do NOT re-introduce ` +
          `yourself back or broadcast to everyone.`

    // Standing response-choice rule for EVERY agent session and delivery scenario. Direct
    // messages and direct agent calls are explicitly described as addressed; shared
    // conversations are where the silent branch is normally useful. Keeping one contract
    // across runtimes prevents identity/route behavior from depending on the surface.

    // Standing context on the system-prompt append: the agent meta object first, then the
    // collaboration guidance, then the no-response rule. A fresh session additionally gets
    // the memory index. Claude carries this via `_meta.systemPrompt`; session/load re-asserts
    // the durable standing rules in a fresh runtime process without treating them as a user
    // turn. Other runtimes inline the fresh-session form as the first block below.
    const resumeSystemContext = [agentMeta, collabAppend, NO_RESPONSE_RULE].filter(Boolean).join('\n\n')
    const sessionContext = [resumeSystemContext, memoryAppend].filter(Boolean).join('\n\n')
    const usesMeta = host.usesMetaSystemPrompt?.() ?? false
    const metaContext = usesMeta ? sessionContext || undefined : undefined

    // Whether THIS call created a brand-new ACP session (vs. resuming/recreating one
    // the CP already knows). Drives the daemon's one-shot `event/session` start emit.
    let created = false
    if (!rec || !rec.acpSessionId) {
      // brand-new session for this (channel, thread, agent); `cwd` prepared above.
      const mcpServers =
        this.deps.mcpServersFor?.({
          agent,
          platform: msg.platform,
          channel: msg.channel,
          thread,
          ...(integrationId !== undefined ? { integrationId } : {}),
          isDm: msg.isDm
        }) ?? []
      const acpSessionId = await abortable(() => host.newSession(cwd, mcpServers, effortOverride, metaContext), signal)
      created = true
      rec = {
        key,
        agentId,
        platform: msg.platform,
        channel: msg.channel,
        thread,
        acpSessionId,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now(),
        // The sender whose message created the session (first-wins in the store;
        // read back as `session/list`'s triggeredBy).
        triggeredBy: msg.sender.id,
        memoryProvider: currentMemoryProvider,
        // Durable parent link, set once at spawn (first-wins in the store).
        ...(effectiveOriginSessionId ? { originSessionId: effectiveOriginSessionId } : {})
      }
      this.deps.store.upsertSession(rec)
    } else if (host.hasSession?.(rec.acpSessionId) === false) {
      const persistedSessionId = rec.acpSessionId
      // Persisted, but unknown to THIS agent process (daemon restart / host eviction):
      // prompting it would yield ACP "Session not found". Prefer native resume
      // (session/load — the agent restores its own history, so the §8.5 gap replay
      // below only re-feeds messages it missed). If the agent can't load it, recreate
      // a fresh session and replay the whole thread as context (lastDeliveredTs=null).
      // `cwd` prepared above (before the host), so skills are installed pre-spawn.
      // Resolved once, shared by both paths: session/load must re-attach the same
      // MCP servers a fresh session would get (the agent doesn't persist them
      // across processes), and resolving twice would register two bridge tokens.
      const mcpServers =
        this.deps.mcpServersFor?.({
          agent,
          platform: msg.platform,
          channel: msg.channel,
          thread,
          ...(integrationId !== undefined ? { integrationId } : {}),
          isDm: msg.isDm
        }) ?? []
      let resumed = false
      if (host.loadSupported?.()) {
        // §7.3 closed/evicted → resuming: mark the re-attach so a TTL-closed session
        // isn't seen as `closed` mid-load, then fall through to `prompting` below.
        this.deps.store.setSessionState(key, 'resuming', Date.now())
        try {
          await abortable(
            () =>
              host.loadSession(
                persistedSessionId,
                cwd,
                mcpServers,
                effortOverride,
                usesMeta ? resumeSystemContext : undefined
              ),
            signal
          )
          resumed = true
        } catch {
          if (signal?.aborted) throw interrupted(signal)
          // agent couldn't load it (GC'd / not durably persisted) — recreate below
        }
      }
      if (!resumed) {
        const acpSessionId = await abortable(
          () => host.newSession(cwd, mcpServers, effortOverride, metaContext),
          signal
        )
        // A fresh ACP id the CP has never seen (the persisted one couldn't be resumed),
        // so this counts as a create for `event/session`. A resumed session (loadSession
        // above) keeps its id — the CP already knows it — so `created` stays false there.
        created = true
        rec = { ...rec, acpSessionId, state: 'idle', lastDeliveredTs: null, updatedAt: Date.now() }
        this.deps.store.upsertSession(rec)
      }
    }

    // Older anchored cron/hook turns persisted their synthetic UUID as the Slack
    // read cursor. Start one bounded catch-up from scratch instead of passing that
    // non-timestamp through the Slack ordering/dedup path; this turn replaces it
    // with the newest canonical timestamp below.
    const markerBefore =
      msg.platform === 'slack' && rec.lastDeliveredTs !== null && slackTsMicros(rec.lastDeliveredTs) === null
        ? null
        : rec.lastDeliveredTs
    // §8.4/§8.5 authoritative warm-thread snapshot (#649): Socket Mode is the
    // low-latency trigger, not an ordered/complete unread source. Slack may deliver a
    // minutes-old event only after the current agent turn has ended, while newer plain
    // replies and even @mentions already exist in conversations.replies. Snapshot every
    // human mid-thread activation through a fixed wall-clock cutoff, then assemble the
    // prompt from that stable window. Messages after the cutoff belong to the next turn.
    // Agent-authored `messageAgent` rows are first-class thread events too: the direct
    // delivery is only an attention signal, so its target snapshots/catches up exactly
    // like a human-triggered turn.
    const snapshotCutoffTs =
      msg.platform === 'slack' && thread !== ts && this.deps.fetchThreadHistory
        ? slackTsForWallClock(Date.now())
        : undefined
    if (snapshotCutoffTs !== undefined) {
      const history = await abortable(
        () => this.deps.fetchThreadHistory!(agentId, msg.channel, thread, snapshotCutoffTs, markerBefore),
        signal
      )
      for (const h of history) {
        // Platform history has canonical decimal Slack timestamps. Keep synthetic /
        // locally-recorded legacy coordinates usable in tests and recovery; a
        // non-canonical value cannot be compared safely with a wall-clock cutoff.
        if (slackTsMicros(h.ts) !== null && compareSlackTs(h.ts, snapshotCutoffTs) > 0) continue
        // Skip the agent's OWN messages: they're already recorded at the send boundary and
        // are always self-filtered from the model (participantGap below). Re-recording them
        // here is redundant — and in `minimal` mode it produces a DUPLICATE transcript row,
        // because the send-boundary `recordReplySegment` stamps a monotonic ts while this
        // path uses the real Slack ts, so the (channel,thread,ts) dedup index can't collapse
        // them (low/medium/high record at the send boundary WITH the Slack ts, so they dedup).
        if (h.sender === agentId) continue
        this.deps.store.appendTranscript({
          channel: msg.channel,
          thread,
          ts: h.ts,
          sender: h.sender,
          // Snapshotted thread history is context THIS agent's turn receives.
          recipient: agentId,
          kind: 'text',
          text: h.text
        })
      }
    }

    // §8.5 first-class thread catch-up: human and agent-authored messages share one
    // conversation log. `messageAgent` determines who wakes NOW, not who may see the row;
    // every participant catches up all thread events through its own stable cutoff when it
    // next wakes. Workflow correlation remains out-of-band in trusted CallMeta.
    const blocks: ContentBlock[] = []
    {
      const gap = this.deps.store
        .transcriptSince(msg.channel, thread, markerBefore)
        .filter(
          (e) =>
            snapshotCutoffTs === undefined ||
            slackTsMicros(e.ts) === null ||
            compareSlackTs(e.ts, snapshotCutoffTs) <= 0
        )
      // SQLite's text order puts UUID-like legacy coordinates after decimal Slack
      // timestamps. Keep those old rows as context, but before the real timeline.
      if (msg.platform === 'slack') gap.sort((a, b) => compareSlackTs(a.ts, b.ts))
      const participantGap = gap.filter((e) => e.sender !== agentId)
      // Own authored rows are not repeated to the model, but they ARE first-class events
      // in the shared log and therefore may advance this agent's read cursor once the
      // surrounding stable window is consumed.
      const deliveredThrough =
        msg.platform === 'slack'
          ? slackTsMicros(ts) !== null
            ? (gap.filter((e) => slackTsMicros(e.ts) !== null).at(-1)?.ts ?? markerBefore)
            : (participantGap.at(-1)?.ts ?? markerBefore)
          : ts
      const triggerWasAlreadyDelivered =
        markerBefore !== null && msg.platform === 'slack' && compareSlackTs(ts, markerBefore) <= 0

      // A stale Socket Mode event may be the wake-up signal even though the snapshot
      // contains newer instructions. In that case the old `context + current` shape is
      // actively wrong: it puts the obsolete trigger last. Deliver one chronological
      // unread batch so the newest human instruction is last and therefore salient.
      const hasMessageAfterTrigger =
        msg.platform === 'slack' && participantGap.some((e) => compareSlackTs(e.ts, ts) > 0)
      if (hasMessageAfterTrigger || triggerWasAlreadyDelivered) {
        const context = participantGap.slice(-MAX_REPLAY_ENTRIES)
        if (context.length === 0) {
          rec.lastDeliveredTs = deliveredThrough
          rec.state = 'idle'
          rec.updatedAt = Date.now()
          this.deps.store.upsertSession(rec)
          return { sessionId: rec.acpSessionId!, blocks: [], created, skipped: true }
        }
        const elided = participantGap.length - context.length
        const head =
          elided > 0
            ? `(unread thread messages, oldest to newest — ${elided} earlier message(s) elided)`
            : '(unread thread messages, oldest to newest)'
        blocks.push({ type: 'text', text: `${head}\n${context.map((e) => `[${e.sender}] ${e.text}`).join('\n')}` })
      } else {
        // Normal in-order activation: preserve the established context-prefix + current
        // prompt shape, while never replaying this agent's own recorded messages.
        const allContext = participantGap.filter((e) => e.ts !== ts)
        const context = allContext.slice(-MAX_REPLAY_ENTRIES)
        if (context.length > 0) {
          const elided = allContext.length - context.length
          const head =
            elided > 0
              ? `(thread context you may have missed — ${elided} earlier message(s) elided)`
              : '(thread context you may have missed)'
          const ctxText = context.map((e) => `[${e.sender}] ${e.text}`).join('\n')
          blocks.push({ type: 'text', text: `${head}\n${ctxText}` })
        }
        blocks.push({ type: 'text', text: msg.text })
      }
      rec.lastDeliveredTs = deliveredThrough ?? ts
    }

    // §9.2 attachments on the current message → image/resource/resource_link blocks.
    if (msg.attachments?.length) {
      const attBlocks = await abortable(
        () =>
          buildAttachmentBlocks(msg.attachments!, {
            download: (att) => this.deps.downloadAttachment?.(agentId, att) ?? Promise.resolve(null),
            supports: (kind) => host.promptSupports?.(kind) ?? false,
            ...(this.deps.attachmentMaxBytes !== undefined ? { maxBytes: this.deps.attachmentMaxBytes } : {})
          }),
        signal
      )
      blocks.push(...attBlocks)
    }

    // Per-activation semantic recall happens only after the real user/peer/unread
    // prompt exists. Its result is appended as a trailing, explicitly untrusted
    // reference block — never as the first user block/title seed (#398).
    const captureInput = recallQueryFromBlocks(blocks)
    // Platform message ids are stable across redelivery and therefore make a
    // durable operation fence. Webchat deliberately reuses one msgId for the
    // whole conversation, so use its per-turn trace id instead.
    const turnId = `${agentId}:${msg.platform === 'webchat' ? msg.traceId : msg.msgId}`
    const recallScope = { agentId, sessionId: rec.acpSessionId! }
    const recallPolicy = memoryEnabled ? this.deps.memory.recallPolicy(recallScope) : undefined
    if (captureInput && recallPolicy?.mode === 'auto') {
      const recallAbort = new AbortController()
      const recallReq = {
        turnId,
        query: captureInput,
        topK: recallPolicy.topK,
        maxBytes: recallPolicy.maxBytes,
        timeoutMs: recallPolicy.timeoutMs,
        signal: recallAbort.signal
      }
      let timer: NodeJS.Timeout | undefined
      const abortRecall = (): void => recallAbort.abort(signal?.reason)
      signal?.addEventListener('abort', abortRecall, { once: true })
      try {
        try {
          this.deps.onMemoryRecallEvent?.(agentId, {
            kind: 'requested',
            sessionId: rec.acpSessionId!,
            turnId,
            provider: currentMemoryProvider,
            topK: recallReq.topK,
            maxBytes: recallReq.maxBytes,
            timeoutMs: recallReq.timeoutMs
          })
        } catch {
          // Observability must never change recall or prompt assembly.
        }
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('memory recall timed out')
            recallAbort.abort(error)
            reject(error)
          }, recallReq.timeoutMs)
          timer.unref?.()
        })
        const raw = await Promise.race([
          abortable(() => this.deps.memory.recallForTurn(recallScope, recallReq), signal),
          timeout
        ])
        const records = sanitizeRecallRecords(raw, recallScope, recallReq)
        const reference = recalledMemoryBlock(records, recallReq.maxBytes)
        const injectedBytes = reference?.type === 'text' ? Buffer.byteLength(reference.text) : 0
        if (reference) {
          if (reference.type === 'text') {
            this.deps.onMemoryRecallInjected?.(agentId, injectedBytes)
          }
          blocks.push(reference)
        }
        try {
          this.deps.onMemoryRecallEvent?.(agentId, {
            kind: 'completed',
            sessionId: rec.acpSessionId!,
            turnId,
            provider: currentMemoryProvider,
            recordCount: records.length,
            injectedBytes
          })
        } catch {
          // Observability must never change recall or prompt assembly.
        }
      } catch (error) {
        try {
          this.deps.onMemoryRecallEvent?.(agentId, {
            kind: 'failed',
            sessionId: rec.acpSessionId!,
            turnId,
            provider: currentMemoryProvider,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            timedOut: error instanceof Error && /timed out/i.test(error.message),
            aborted: signal?.aborted === true
          })
        } catch {
          // Observability must never change recall's fail-open policy.
        }
        if (signal?.aborted) throw interrupted(signal)
        // Runtime recall is fail-open: answer without memory and emit only a
        // metadata-safe diagnostic through the injected observer.
        this.deps.onMemoryRecallError?.(agentId, error)
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abortRecall)
      }
    }

    // System-side context for a newly-created session: the agent meta object (identity +
    // description + source/channel) and the memory INDEX, both in `sessionContext`. All
    // STANDING context, not a user turn — so they never sit as a leading user block (which
    // a runtime auto-titles from — #398). Claude carries them via `_meta.systemPrompt` (see
    // newSession/claudeSessionMeta), so it adds NOTHING here. Other runtimes have no such
    // channel: inline sessionContext as one combined first block. Gated on `created`: a
    // resumed session already carries it from its first turn.
    const promptPrelude: ContentBlock[] = []
    if (created) {
      // Establish the reminder epoch without redundantly restating the rule that this
      // new session just received (inline or via `_meta.systemPrompt`).
      this.turnsSinceReminder.set(key, 0)
      if (!usesMeta && sessionContext) promptPrelude.push({ type: 'text', text: sessionContext })
    } else if (this.shouldRemind(key)) {
      // Long-running (or just-compacted) session: re-assert the no-response
      // rule as a compact system reminder so it stays salient. A brand-new session already
      // carries the full rule (the `created` branch / Claude's system-prompt append), so this
      // fires only on later turns. Placed first, ahead of the catch-up context + message.
      promptPrelude.push({ type: 'text', text: NO_RESPONSE_REMINDER })
    }
    // The router has already matched the raw platform token against THIS integration's
    // resolved bot identity. Preserve that trusted fact for the model: an opaque Slack
    // `<@U…>` id otherwise looks unrelated to the AgentConnect name in standing context,
    // which can make the agent incorrectly classify its own explicit mention as foreign.
    // Keep this separate from user text (no rewriting) and only assert it for the router's
    // explicit-mention rung — never for thread/keyword/auto routing.
    if (msg.trigger === 'mention') {
      promptPrelude.push({ type: 'text', text: EXPLICIT_MENTION_REMINDER })
    }
    if (promptPrelude.length > 0) blocks.unshift(...promptPrelude)

    // Every wake source consumed the same stable thread window above; its per-agent cursor
    // is therefore safe to persist regardless of whether attention came from a human,
    // messageAgent, cron, or hook.
    rec.state = 'prompting'
    rec.updatedAt = Date.now()
    this.deps.store.upsertSession(rec)

    return { sessionId: rec.acpSessionId!, blocks, created, captureInput, turnId }
  }

  /** Decide whether to re-inject the compact no-response reminder on a later turn,
   *  advancing the per-session counters as a side effect (so call it at most once per turn).
   *  Fires every REMINDER_EVERY_TURNS turns, or as soon as a context compaction is detected —
   *  tokens-in-context fell below COMPACTION_DROP_RATIO of the previous turn's (ACP has no
   *  explicit compaction event, only the usage numbers we track via setUsageSnapshot). */
  private shouldRemind(key: string): boolean {
    // First turn observed by this daemon process for an already-existing session: reassert
    // immediately. Besides surviving runtime compaction, this migrates long-lived sessions
    // away from a response marker taught by an older daemon release.
    if (!this.turnsSinceReminder.has(key)) {
      this.turnsSinceReminder.set(key, 0)
      const now = this.deps.store.getUsage(key).contextUsed
      if (now !== undefined) this.lastContextUsed.set(key, now)
      return true
    }
    const turns = (this.turnsSinceReminder.get(key) ?? 0) + 1
    const prev = this.lastContextUsed.get(key)
    const now = this.deps.store.getUsage(key).contextUsed
    if (now !== undefined) this.lastContextUsed.set(key, now)
    const compacted = prev !== undefined && now !== undefined && now < prev * COMPACTION_DROP_RATIO
    const remind = turns >= REMINDER_EVERY_TURNS || compacted
    this.turnsSinceReminder.set(key, remind ? 0 : turns)
    return remind
  }
}

/** Canonical transcript primary-key coordinates for a normalized message. Used by
 *  BOTH the session manager and the daemon's unrouted-append path so a message
 *  recorded from either site lands on the same (thread, ts) PK and dedups via
 *  INSERT OR IGNORE — never a divergent double row. */
export function transcriptCoords(msg: NormalizedMessage): { thread: string; ts: string } {
  const thread = msg.thread ?? msg.msgId
  if (msg.transcriptTs) return { thread, ts: msg.transcriptTs }
  // NormalizedMessage.msgId is `slack:<channel>:<ts>`; recover the ts.
  const parts = msg.msgId.split(':')
  const ts = parts[parts.length - 1] ?? '0'
  return { thread, ts }
}
