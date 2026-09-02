import type { McpServer } from '@agentclientprotocol/sdk'
import type { AcpHost } from '../../acp/acp-host.js'
import type { Agent } from '../../agents/agent-schema.js'
import type { LocalStore, SessionRecord } from '../../store/local-store.js'

/** The store writes the opener owns — the session row plus the ingress-supplied title. */
type OpenerStore = Pick<LocalStore, 'setSessionState' | 'upsertSession' | 'setSessionTitle'>

/** Everything the create branch needs to mint the brand-new session row. */
export interface RuntimeSessionIdentity {
  key: string
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope: string | null
  triggeredBy: string
  threadUrl?: string
  memoryProvider: SessionRecord['memoryProvider']
  workspaceIsolation: 'shared' | 'session'
  /** Durable parent link (§5.3), set once at spawn (first-wins in the store). */
  originSessionId?: string
  /** Durable report-back obligation (sticky-true in the store). */
  needsParentReply?: boolean
  /** Ingress-supplied title, already trimmed and only for a brand-new logical session. */
  initialTitle?: string
  /** The platform standing block the opening message carried; persisted first-wins on the row. */
  platformStanding?: string
}

export interface OpenRuntimeSessionInput {
  host: AcpHost
  agent: Agent
  /** The session row as handle() reconciled it; undefined ⇒ no logical session yet. */
  rec: SessionRecord | undefined
  identity: RuntimeSessionIdentity
  store: OpenerStore
  /** Daemon-verified cwd prepared before handle() (GitHub exact-ref turns). */
  preparedWorkspaceCwd?: string
  /** Pre-host preparation from a cold hostFor; only a shared workspace may consume it. */
  preparedCwd?: string
  /** Ordinary warm host carrying generation identity into the preparation seam. */
  expectedWarmHost?: AcpHost
  prepareWorkspace: (agent: Agent, expectedWarmHost?: AcpHost) => Promise<string>
  /** Extra roots the runtime may read beyond cwd, per workspace isolation. */
  workspaceDirectories: (cwd: string) => Promise<string[]>
  /** The default MCP servers for this turn's platform binding, resolved once. */
  mcpServersFor: () => McpServer[]
  /** Trusted descriptors bound to an overridden host; dropped if the runtime rejects them. */
  additionalMcpServers?: McpServer[]
  /** Current chat authority for runtime changes, re-read immediately before each request. */
  chatRuntimeChangesAllowed: () => boolean
  /** The sticky per-session effort override (chat-selected or turn-supplied). */
  effortOverride: () => Promise<string | undefined>
  /** Standing context for a fresh session; `resumeSystemContext` for a native resume. Both are
   *  resolved HERE, after workspace preparation, so what the prompt names and what
   *  `workspaceDirectories` hands the runtime come from one snapshot. */
  metaContext?: () => Promise<string | undefined>
  resumeSystemContext?: () => Promise<string | undefined>
  usesMeta: boolean
  /** Mint this slot's OUTWARD id (session-concept.md §1.1) and hand back the binder that pairs the
   *  runtime's id with it. Awaited BEFORE `session/new` is issued, so the binder itself is
   *  synchronous: the host makes the session live and then awaits its configuration round trips,
   *  and the row lands later still, so a runtime advertising from inside that window would
   *  otherwise be reported under the hop's id — durably, with nothing to repair it. Anything
   *  awaited at the response instead would widen the gap where such an update is dropped
   *  outright. Runs on every create path; a resumed session keeps the id its row carries. */
  prepareOutwardBinding?: () => Promise<(acpSessionId: string) => void>
  signal?: AbortSignal
  abortable: <T>(start: () => PromiseLike<T> | T, signal?: AbortSignal) => Promise<T>
  interrupted: (signal: AbortSignal) => Error
}

export interface OpenRuntimeSessionResult {
  sessionId: string
  /** The session row after create/recreate; unchanged when the runtime session was live. */
  rec: SessionRecord
  /** Whether THIS call created a brand-new ACP session (vs. resuming a known one). */
  created: boolean
  /** False when the runtime rejected the trusted additional descriptors and only the
   *  ordinary server set succeeded. Absent when no additional descriptors existed. */
  additionalMcpAttached?: boolean
}

/**
 * Open the ACP runtime session backing this turn: create a brand-new one, or re-attach a
 * persisted one the host no longer knows (native `session/load`, else silently rebuild).
 * The additional-MCP outcome is reported through the return value rather than a mutable
 * the caller shares with this decision.
 */
export async function openRuntimeSession(input: OpenRuntimeSessionInput): Promise<OpenRuntimeSessionResult> {
  const { host, agent, identity, store, signal, abortable, interrupted } = input
  let rec = input.rec
  let additionalMcpAttached: boolean | undefined = input.additionalMcpServers?.length ? true : undefined
  let created = false

  const sessionStartEffort = async (): Promise<{ value?: string; chatSelected: boolean }> => {
    if (!input.chatRuntimeChangesAllowed()) return { chatSelected: false }
    const value = await input.effortOverride()
    return { value, chatSelected: value !== undefined }
  }
  const withAdditionalMcpFallback = async <T>(
    primary: () => Promise<T>,
    fallback: (() => Promise<T>) | undefined
  ): Promise<T> => {
    try {
      return await primary()
    } catch (error) {
      if (signal?.aborted || !fallback) throw error
      const result = await fallback()
      additionalMcpAttached = false
      return result
    }
  }
  const newRuntimeSession = async (
    cwd: string,
    mcpServers: McpServer[],
    systemAppend?: string,
    fallbackMcpServers?: McpServer[]
  ): Promise<string> => {
    const additionalDirectories = await input.workspaceDirectories(cwd)
    const bindOutward = await input.prepareOutwardBinding?.()
    while (true) {
      const selected = await sessionStartEffort()
      const create = (servers: McpServer[]) =>
        abortable(
          () => host.newSession(cwd, servers, selected.value, systemAppend, additionalDirectories, bindOutward),
          signal
        )
      const sessionId = await withAdditionalMcpFallback(
        () => create(mcpServers),
        fallbackMcpServers ? () => create(fallbackMcpServers) : undefined
      )
      if (!selected.chatSelected || input.chatRuntimeChangesAllowed()) return sessionId
      host.discardSession(sessionId)
    }
  }
  const loadRuntimeSession = async (
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    systemAppend?: string,
    fallbackMcpServers?: McpServer[]
  ): Promise<boolean> => {
    const selected = await sessionStartEffort()
    const additionalDirectories = await input.workspaceDirectories(cwd)
    const load = (servers: McpServer[]) =>
      abortable(
        () => host.loadSession(sessionId, cwd, servers, selected.value, systemAppend, additionalDirectories),
        signal
      )
    await withAdditionalMcpFallback(
      () => load(mcpServers),
      fallbackMcpServers ? () => load(fallbackMcpServers) : undefined
    )
    if (!selected.chatSelected || input.chatRuntimeChangesAllowed()) return true
    // The pinned Claude adapter treats a repeated load of the same session/cwd/MCP
    // fingerprint as idempotent, so another load cannot replace metadata-only effort.
    // Forget this local attachment and let the caller create a fresh safe session.
    host.discardSession(sessionId)
    return false
  }
  // Use the pre-host preparation when the host was cold, else prepare now (warm host —
  // ordering vs spawn is moot). Only a shared workspace may consume the pre-host cwd.
  const resolveCwd = async (): Promise<string> =>
    input.preparedWorkspaceCwd ??
    (identity.workspaceIsolation === 'shared' ? input.preparedCwd : undefined) ??
    (await abortable(() => input.prepareWorkspace(agent, input.expectedWarmHost), signal))

  if (!rec || !rec.acpSessionId) {
    const cwd = await resolveCwd()
    const ordinaryMcpServers = input.mcpServersFor()
    const mcpServers = [...ordinaryMcpServers, ...(input.additionalMcpServers ?? [])]
    const acpSessionId = await newRuntimeSession(
      cwd,
      mcpServers,
      await input.metaContext?.(),
      input.additionalMcpServers?.length ? ordinaryMcpServers : undefined
    )
    created = true
    rec = {
      key: identity.key,
      agentId: identity.agentId,
      platform: identity.platform,
      channel: identity.channel,
      thread: identity.thread,
      transportScope: identity.transportScope,
      acpSessionId,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      // The source that created the session (first-wins in the store; read back
      // as `session/list`'s triggeredBy). Hook routing identity remains separate
      // from the GitHub actor credited on the transcript row.
      triggeredBy: identity.triggeredBy,
      ...(identity.threadUrl ? { threadUrl: identity.threadUrl } : {}),
      memoryProvider: identity.memoryProvider,
      workspaceIsolation: identity.workspaceIsolation,
      ...(identity.originSessionId ? { originSessionId: identity.originSessionId } : {}),
      ...(identity.needsParentReply ? { needsParentReply: 1 } : {}),
      ...(identity.platformStanding ? { platformStanding: identity.platformStanding } : {})
    }
    await store.upsertSession(rec)
    if (identity.initialTitle) await store.setSessionTitle(identity.key, identity.initialTitle)
  } else if (host.hasSession?.(rec.acpSessionId) === false) {
    const persistedSessionId = rec.acpSessionId
    // Persisted, but unknown to THIS agent process (daemon restart / host eviction):
    // prompting it would yield ACP "Session not found". Prefer native resume
    // (session/load — the agent restores its own history, so the §8.5 gap replay
    // only re-feeds messages it missed). If the agent can't load it, recreate a
    // fresh session and replay the whole thread as context (lastDeliveredTs=null).
    const cwd = await resolveCwd()
    // Resolved once, shared by both paths: session/load must re-attach the same
    // MCP servers a fresh session would get (the agent doesn't persist them
    // across processes), and resolving twice would register two bridge tokens.
    const ordinaryMcpServers = input.mcpServersFor()
    const mcpServers = [...ordinaryMcpServers, ...(input.additionalMcpServers ?? [])]
    const fallbackMcpServers = input.additionalMcpServers?.length ? ordinaryMcpServers : undefined
    let resumed = false
    if (host.loadSupported?.()) {
      // §7.3 closed/evicted → resuming: mark the re-attach so a TTL-closed session
      // isn't seen as `closed` mid-load, then fall through to `prompting` later.
      await store.setSessionState(identity.key, 'resuming', Date.now())
      try {
        resumed = await loadRuntimeSession(
          persistedSessionId,
          cwd,
          mcpServers,
          input.usesMeta ? await input.resumeSystemContext?.() : undefined,
          fallbackMcpServers
        )
      } catch {
        if (signal?.aborted) throw interrupted(signal)
        // agent couldn't load it (GC'd / not durably persisted) — recreate below
      }
    }
    if (!resumed) {
      const acpSessionId = await newRuntimeSession(cwd, mcpServers, await input.metaContext?.(), fallbackMcpServers)
      // A fresh ACP id the CP has never seen (the persisted one couldn't be resumed),
      // so this counts as a create for `event/session`. A resumed session (loadSession
      // above) keeps its id — the CP already knows it — so `created` stays false there.
      created = true
      rec = { ...rec, acpSessionId, state: 'idle', lastDeliveredTs: null, updatedAt: Date.now() }
      await store.upsertSession(rec)
    }
  }

  return {
    sessionId: rec.acpSessionId!,
    rec,
    created,
    ...(additionalMcpAttached !== undefined ? { additionalMcpAttached } : {})
  }
}
