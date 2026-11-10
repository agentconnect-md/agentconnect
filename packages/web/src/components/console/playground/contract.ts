import type { Agent, ElicitAnswerValue, FillCardAnswer, Session, SessionImage, SessionStep } from '@/lib/data'
import type { McpAppRpc, WebchatFileAttachment } from '@agentconnect.md/protocol'
import type { SessionMessageDto } from '@/lib/api'
import type { ComposerFile } from '@/lib/webchat-file'

export interface PlaygroundData {
  /** Composer buffer for one session id (each live conversation has its own).
   *  NOT reactive — drafts live outside React state so keystrokes don't
   *  re-render every context consumer. Subscribe via usePgDraft()/
   *  subscribePgDraft when the UI must follow the value. */
  getPgInput: (id: string) => string
  setPgInput: (id: string, v: string) => void
  /** Notifies on any draft change; pair with getPgInput in useSyncExternalStore. */
  subscribePgDraft: (listener: () => void) => () => void
  /** One prepared image waiting in this session's composer. */
  getPgImage: (id: string) => SessionImage | undefined
  setPgImage: (id: string, image?: SessionImage) => void
  /** Images and documents staged in this session's composer, including failed uploads. */
  getPgFiles: (id: string) => ComposerFile[]
  setPgFiles: (id: string, update: (files: ComposerFile[]) => ComposerFile[]) => void
  /** Worktree choice staged for a synthetic session's first turn. */
  getPgWorktree: (id: string) => boolean | undefined
  pgSetWorktree: (id: string, worktree: boolean) => void
  /** Is a turn in flight for this session id? Drives its typing indicator + send-disable. */
  isPgBusy: (id: string) => boolean
  /** A turn runs that this view sees only through the transcript (the daemon cannot replay it), so Stop still applies. */
  isPgTurnUnstreamed: (id: string) => boolean
  /** Create a new sandbox session and return its id. Does not navigate. `members`
   *  adds more participants — the conversation's roster is fixed at creation
   *  (webchat-multi-agents.md §3.1); the first agent is the primary. `conversationId`
   *  opens it on a conversation that exists already, such as the member's coordinator. */
  openPlayground: (
    agent: Agent,
    members?: Agent[],
    /** `coordinator` marks the member's coordinator conversation (auto-session-mode.md §10) before it has a session. */
    options?: { worktree?: boolean; conversationId?: string; coordinator?: boolean }
  ) => string
  /** Add a participant to a LIVE conversation (mid-conversation join,
   *  webchat-multi-agents.md §3.1). Registers the agent with the CP, then
   *  rebuilds the socket so the relay re-verifies and caches the grown roster.
   *  Failures surface as a ⚠️ transcript step AND resolve to `false` — the
   *  promise settling is not itself success (refused-while-busy and rejected
   *  joins settle normally too), so a caller that gates routing on this join
   *  (e.g. the mention picker) can tell an actual join from a no-op/refusal.
   *  Refused while a turn streams. */
  pgAddAgent: (id: string, agent: Agent) => Promise<boolean>
  /** Remove a non-primary member from a live conversation (§3.1a), then reconnect so the relay re-verifies the shrunk roster; refused while a turn streams or queues. */
  pgRemoveAgent: (id: string, agentId: string) => Promise<boolean>
  /** Close a conversation that never sent a turn, as when its first send moves it to the other protocol. */
  pgDiscard: (id: string) => void
  /** Returns whether the send was ACCEPTED — false only when there is nothing to
   *  send. A send while a turn is still streaming is accepted too: it QUEUES
   *  (Claude Code-style) and dispatches in order as turns finish. Callers that
   *  move the viewport on send (the session view pins the transcript to the
   *  bottom) must not act on a rejected one, and this keeps that condition in a
   *  single place. */
  pgSend: (
    id: string,
    agentId: string,
    text?: string,
    conversationId?: string,
    participants?: Array<{ agentId: string; name: string; primary?: boolean }>,
    /** Overrides the staged composer image — for callers (Home) that mint the
     *  session id in the same tick, before setPgImage state could land. */
    image?: SessionImage,
    /** A `/` pick's owner. Honored only while the picked token still LEADS the outgoing text and
     *  the owner is a participant — then it joins `mentions[]`, narrowing the turn to the one
     *  agent whose runtime has the skill instead of waking the roster to decline. */
    commandPick?: { agentId: string; name: string },
    /** Overrides the staged composer files, as `image` does. */
    files?: WebchatFileAttachment[]
  ) => boolean
  /** Send one line the CONVERSATION speaks rather than the person — today, an
   *  approval decision the agent has to hear about because its own request only
   *  received an operationId. Delivered exactly like a message (steer, queue or
   *  send now) but with NO composer side effects: the owner's unsent draft and
   *  staged attachment are theirs, and clicking Approve is not a send. */
  pgNotice: (
    id: string,
    agentId: string,
    text: string,
    conversationId?: string,
    participants?: Array<{ agentId: string; name: string; primary?: boolean }>
  ) => boolean
  /** Send `text` in a thread of a coordinator conversation (webchat-threads.md §6.3), leaving its composer alone; a session-targeted continuation writes it in that thread of its task or its coordinator (§7). */
  pgSendThread: (
    id: string,
    agentId: string,
    text: string,
    thread: string,
    conversationId?: string,
    image?: SessionImage,
    files?: WebchatFileAttachment[]
  ) => boolean
  /** The thread the turn in flight was sent in, undefined at the root or when idle. */
  getPgTurnThread: (id: string) => string | undefined
  /** What the relay's `ready` frame said it supports; undefined until a socket of this session is verified. */
  getPgRelayFeatures: (id: string) => readonly string[] | undefined
  /** Probe the conversation's daemons for a turn this view is not streaming (after a reload, or one started elsewhere) and reattach on a hit; no-op while busy. */
  pgAttach: (id: string, agentId: string, conversationId: string) => void
  /** Make `id`'s socket continue `targetSessionId` (itself by default; webchat-cross-integration-continuation.md §6.5); `threads`: its page draws threads, so a message sent in one is drawn there. */
  markSessionTarget: (id: string, targetSessionId?: string, threads?: boolean) => void
  /** Messages queued while a turn streams, oldest first. */
  getPgQueue: (id: string) => QueuedTurn[]
  /** Remove one queued message before it is sent. */
  pgCancelQueued: (id: string, queueId: string) => void
  // Stage an explicit pair before the first turn, or clear it to restore the Agent Decision.
  pgStageRuntime: (id: string, runtime: WebchatRuntimeConfig) => void
  /** Switch the session's model (in-session, sticky). */
  pgSetModel: (id: string, agentId: string, model: string, conversationId?: string) => void
  /** Switch the session's reasoning effort (in-session, sticky). */
  pgSetEffort: (id: string, agentId: string, effort: string, conversationId?: string) => void
  /** Switch the session's composite permission preset when chat changes are allowed. */
  pgSetPermissionPreset: (id: string, agentId: string, permissionPreset: string, conversationId?: string) => void
  /** Toggle the session's fast mode (in-session, sticky). */
  pgSetFast: (id: string, agentId: string, fastMode: boolean, conversationId?: string) => void
  /** Interrupt the running turn without ending the session. */
  pgCancel: (id: string, agentId: string, conversationId?: string) => void
  /** Answer the agent's in-band elicitation card; a list answers a multi-select, a number a
   *  numeric field, a record of value-per-field a multi-field form, `null` is Dismiss. */
  pgAnswerElicitation: (
    id: string,
    agentId: string,
    requestId: string,
    value: ElicitAnswerValue,
    conversationId?: string
  ) => void
  /** Forward one MCP App view's JSON-RPC to the daemon and resolve with its verdict
   *  (webchat-mcp-apps.md §7.3). Unlike every other op here this is request/reply: a frame is
   *  waiting on the answer, and a view left waiting looks to the reader like one that broke. */
  pgAppRpc: (
    id: string,
    agentId: string,
    appId: string,
    rpc: McpAppRpc,
    conversationId?: string
  ) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
  /** Tell the daemon the reader closed an MCP App frame. */
  pgCloseApp: (id: string, agentId: string, appId: string, conversationId?: string) => void
  /** Answer a Fill card (computer-form-fill-and-vault.md §6); the values go only to the daemon, never kept here. */
  pgAnswerFill: (
    id: string,
    agentId: string,
    requestId: string,
    answer: FillCardAnswer,
    conversationId?: string
  ) => Promise<{ accepted: boolean; reason?: string }>
  /** Show a Fill card asked on a chat platform to the person who asked; the daemon refuses anyone else. */
  pgOpenFill: (
    id: string,
    agentId: string,
    requestId: string,
    conversationId?: string
  ) => Promise<{ ok: boolean; reason?: string }>
  getPgSession: (id: string) => Session | undefined
  /** The runtime's predicted next prompt for this session's empty composer, if it sent one. */
  getPgSuggestion: (id: string) => string | undefined
  pgSessionList: Session[]
  /** Live tail (this-visit) steps for an ADOPTED webchat session, keyed by its CP session
   *  id — the turns you send after opening a persisted session from the list, appended
   *  below its fetched history. Empty until you send. Synthetic 'pg_' sessions don't use
   *  this (their whole transcript lives in the session's own `steps`). */
  getLiveSteps: (id: string) => SessionStep[]
  /** Participants whose reply lanes are STILL OPEN for this conversation —
   *  drives per-agent typing attribution in multi-agent conversations (a
   *  superseded regeneration keeps its author's lane open, so the indicator
   *  names the agent actually working, not the primary). */
  getBusyLaneAgentIds: (id: string) => string[]
  /** Retire only live steps confirmed by authoritative transcript rows: the root's, or with `thread` that thread's. */
  reconcileLiveSteps: (
    id: string,
    persisted: SessionMessageDto[],
    agentId: string,
    promptRows?: SessionMessageDto[],
    thread?: string
  ) => void
}

/** One message waiting behind the in-flight turn. Send args are captured at
 *  enqueue time so the auto-dispatch needs nothing from the view. */
export interface QueuedTurn {
  queueId: string
  text: string
  image?: SessionImage
  /** Uploaded-file references; their bytes are already in the object store. */
  files?: WebchatFileAttachment[]
  agentId: string
  conversationId?: string
  participants?: Array<{ agentId: string; name: string; primary?: boolean }>
  /** A `/` pick's owner, revalidated at dispatch — see sendTurn. */
  commandPick?: { agentId: string; name: string }
  /** Composer send order (per provider), so a steer put back in the queue keeps its place. */
  seq?: number
  /** The thread it is sent in, a root's postId. */
  thread?: string
}

export type WebchatRuntimeConfig = {
  runtime?: string
  model?: string
  effort?: string
  permissionMode?: string
  fastMode?: boolean
}
