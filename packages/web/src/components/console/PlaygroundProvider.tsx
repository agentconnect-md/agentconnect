'use client'

// Ephemeral playground sessions live here (not persisted by the Control Plane).
// Lifting this state above the routes — into a provider mounted by the console
// shell — keeps a live sandbox conversation alive while you navigate between
// routes. Each playground session mints a short-lived token through the CP, then
// owns ONE webchat WebSocket to the relay. The agent's reply streams back as
// structured events which we fold into the session's `steps` for the transcript
// view.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { agentLabel, isGitWorkspace, type Agent, type Session, type SessionImage, type SessionStep } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import {
  webchatWsUrl,
  webchatSessionWsUrl,
  addWebchatConversationAgent,
  fmtCountCompact,
  fmtCost,
  ApiError,
  type SessionMessageDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { randomUuid } from '@/lib/random-uuid'
import { resolveRoster, typedMentionIds, wireMentions } from '@/lib/conversation-addressing'
import { leadingCommandToken } from '@/components/console/runtime-command-menu'
import { sessionAfterModelSelection } from '@/lib/session-runtime-controls'
import { reconcilePersistedLiveSteps } from '@/lib/session-transcript'
import {
  acceptWebchatDone,
  acceptWebchatOutput,
  bindWebchatTurn,
  createWebchatCursor,
  type OrderedWebchatCursor,
  type OrderedWebchatResult
} from '@/lib/webchat-stream'
import {
  admitsLane,
  cursorKeyFor as cursorKeyForLanes,
  laneAgentId,
  laneKey,
  lanesOf as lanesOfLanes
} from '@/lib/webchat-lanes'
import { createWebchatDeltaBuffer, type WebchatDeltaBuffer } from '@/lib/webchat-delta-buffer'

interface PlaygroundData {
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
  /** Worktree choice staged for a synthetic session's first turn. */
  getPgWorktree: (id: string) => boolean | undefined
  pgSetWorktree: (id: string, worktree: boolean) => void
  /** Is a turn in flight for this session id? Drives its typing indicator + send-disable. */
  isPgBusy: (id: string) => boolean
  /** Create a new sandbox session and return its id. Does not navigate. `members`
   *  adds more participants — the conversation's roster is fixed at creation
   *  (webchat-multi-agents.md §3.1); the first agent is the primary. */
  openPlayground: (agent: Agent, members?: Agent[], options?: { worktree?: boolean }) => string
  /** Add a participant to a LIVE conversation (mid-conversation join,
   *  webchat-multi-agents.md §3.1). Registers the agent with the CP, then
   *  rebuilds the socket so the relay re-verifies and caches the grown roster.
   *  Failures surface as a ⚠️ transcript step AND resolve to `false` — the
   *  promise settling is not itself success (refused-while-busy and rejected
   *  joins settle normally too), so a caller that gates routing on this join
   *  (e.g. the mention picker) can tell an actual join from a no-op/refusal.
   *  Refused while a turn streams. */
  pgAddAgent: (id: string, agent: Agent) => Promise<boolean>
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
    commandPick?: { agentId: string; name: string }
  ) => boolean
  /** Reattach a webchat session after a cold page load: probe the conversation's
   *  daemons for a turn still streaming (the reload wiped the busy flag, lanes,
   *  and streamed reply) and, on a hit, recreate the lane, restore the typing
   *  indicator, and replay the reply from the start. No-op while already busy. */
  pgAttach: (id: string, agentId: string, conversationId: string) => void
  /** Mark `id` (a CP session id) as a session-targeted continuation: the socket
   *  mints through the session-target token route and the daemon dispatches
   *  turns onto that session's own platform coordinates
   *  (webchat-cross-integration-continuation.md §6.5). */
  markSessionTarget: (id: string) => void
  /** Messages queued while a turn streams, oldest first. */
  getPgQueue: (id: string) => QueuedTurn[]
  /** Remove one queued message before it is sent. */
  pgCancelQueued: (id: string, queueId: string) => void
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
  /** Answer the agent's in-band elicitation card; `value: null` is Dismiss. */
  pgAnswerElicitation: (
    id: string,
    agentId: string,
    requestId: string,
    value: string | null,
    conversationId?: string
  ) => void
  getPgSession: (id: string) => Session | undefined
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
  /** Retire only live steps confirmed by authoritative transcript rows. */
  reconcileLiveSteps: (
    id: string,
    persisted: SessionMessageDto[],
    agentId: string,
    promptRows?: SessionMessageDto[]
  ) => void
}

/** One message waiting behind the in-flight turn. Send args are captured at
 *  enqueue time so the auto-dispatch needs nothing from the view. */
export interface QueuedTurn {
  queueId: string
  text: string
  image?: SessionImage
  agentId: string
  conversationId?: string
  participants?: Array<{ agentId: string; name: string; primary?: boolean }>
  /** A `/` pick's owner, revalidated at dispatch — see sendTurn. */
  commandPick?: { agentId: string; name: string }
}

// Synthetic playground session ids start with `pg_`; real CP session ids do not.
// The prefix lets the provider tell the two apart without extra bookkeeping.
const PG_PREFIX = 'pg_'
const NO_STEPS: SessionStep[] = []
const NO_QUEUE: QueuedTurn[] = []
const WEBCHAT_RECONNECT_BASE_MS = 500
const WEBCHAT_RECONNECT_MAX_MS = 4_000
const WEBCHAT_RECONNECT_MAX_ATTEMPTS = 6
const liveStepClock = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})
const liveSessionClock = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit'
})

function liveStepTime(): string {
  return liveStepClock.format(new Date())
}

function liveActivityStamp(): Pick<Session, 'lastActivityAt' | 'time'> {
  const now = new Date()
  return { lastActivityAt: now.toISOString(), time: liveSessionClock.format(now) }
}

function newPlaygroundSessionId(agentId: string): string {
  return `${PG_PREFIX}${agentId}_${randomUuid()}`
}

// A step on its way in: a producer may omit `turnId` (a locally-pushed warning has no stream
// turn) — `stampStep` mints one, so every step that reaches state carries a durable turn identity.
type UnstampedStep = Omit<SessionStep, 'turnId'> & { turnId?: string }

function stampStep(step: UnstampedStep, observedAtMs = Date.now()): SessionStep {
  return {
    ...step,
    // The single choke point every live step passes through, so it is the one place that
    // guarantees `turnId`: keep the wire/user turnId when present, else mint one. A minted id is
    // per-step (a standalone warning is its own trivial turn); real multi-step agent turns always
    // arrive with the wire turnId, so this never splits one.
    turnId: step.turnId ?? `local:${randomUuid()}`,
    time: step.time ?? liveStepTime(),
    observedAtMs: step.observedAtMs ?? observedAtMs
  }
}

/** Drop this lane's live-only wait notice — streamed output IS the wait ending, so the line must go. */
function dropWaitNotices(steps: SessionStep[], agentId: string | undefined, turnId: string): SessionStep[] {
  const waiting = (s: SessionStep): boolean =>
    s.kind === 'notice' && (s.agentId ?? undefined) === agentId && s.turnId === turnId
  return steps.some(waiting) ? steps.filter((s) => !waiting(s)) : steps
}

const Ctx = createContext<PlaygroundData | null>(null)

/** One live webchat socket per playground session. */
interface Conn {
  ws?: WebSocket
  ready: Promise<WebSocket>
  conversationId?: string
  closing?: boolean
  reconnectTimer?: number
}

/** A reply event as it arrives from the relay (mirrors protocol WebchatEvent). */
type WebchatEvent =
  | { kind: 'message'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; toolCallId: string; title: string; status: string }
  | { kind: 'tool_update'; toolCallId: string; status: string; title?: string }
  | { kind: 'session_info'; title: string }
  | { kind: 'superseded'; generation: number }
  | { kind: 'notice'; text: string }
  | { kind: 'plan'; entries: { content: string; status: string; priority?: string }[] }
  | { kind: 'elicitation'; requestId: string; message: string; options: { value: string; label: string }[] }
  | {
      kind: 'elicitation_resolved'
      requestId: string
      outcome: 'accepted' | 'dismissed' | 'cancelled'
      label?: string
    }

/** The session status snapshot carried in a relay `rd/chat` WebchatOutput payload
 *  (mirrors protocol WebchatStatus). Partial: context/cost stream live, token
 *  totals land at turn end. */
type WebchatStatus = {
  model?: string
  effort?: string
  permissionMode?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
  costAmount?: number
  costCurrency?: string
  models?: string[]
  efforts?: string[]
  permissionModes?: string[]
  fastModeAvailable?: boolean
  sessionId?: string
}

type WebchatOutput = {
  turnId: string
  /** Streaming participant (multi-agent conversations). Absent from an older
   *  daemon ⇒ the conversation's sole agent. */
  agentId?: string
  index: number
  event?: WebchatEvent
  status?: WebchatStatus
}

type WebchatDone = {
  turnId: string
  agentId?: string
  lastIndex?: number
  error?: string
}

/** One completed conversation post (mirrors protocol WebchatPost). Only rendered here
 *  when its frame carries `initiator: 'agent'` (#753) — a user-authored post's reply
 *  already streamed live via output/done and would double-render otherwise. */
type WebchatPost = {
  postId: string
  author: { kind: 'user'; user?: string } | { kind: 'agent'; agentId: string }
  text: string
}

/** One roster entry from the relay `ready` frame. */
type WebchatParticipant = { agentId: string; primary?: boolean }

type WebchatRuntimeConfig = {
  model?: string
  effort?: string
  permissionMode?: string
  fastMode?: boolean
}

export function PlaygroundProvider({ children }: { children: ReactNode }) {
  const { refreshSessions } = useConsoleData()
  const [pgSessions, setPgSessions] = useState<Record<string, Session>>({})
  // Live tail for adopted webchat sessions (real CP ids). Kept apart from `pgSessions`
  // so an adopted session still renders from its authoritative CP row + fetched history,
  // with only the turns sent this visit layered on top.
  const [wcSteps, setWcSteps] = useState<Record<string, SessionStep[]>>({})
  // Composer buffer + in-flight flag are PER session id: the provider keeps several
  // conversations live at once (each streams in the background across route changes),
  // so a single global would let one session disable/clear another's composer.
  // Drafts live OUTSIDE React state on purpose: a keystroke must not invalidate
  // the provider context (that re-renders every consumer, including the whole
  // session transcript). Composers subscribe per-session via usePgDraft().
  const pgDrafts = useRef<Record<string, string>>({})
  const pgDraftListeners = useRef(new Set<() => void>())
  const [pgImageBy, setPgImageBy] = useState<Record<string, SessionImage>>({})
  const [pgBusyBy, setPgBusyBy] = useState<Record<string, boolean>>({})
  // Messages sent while a turn was still streaming, oldest first per session id.
  const [pgQueueBy, setPgQueueBy] = useState<Record<string, QueuedTurn[]>>({})
  // Synchronous mirror of pgQueueBy — pgSend's queue-or-send decision cannot
  // read state: when a turn ends, busyRef clears at once but the queue head is
  // dispatched by a passive effect, and a send landing in that gap would jump
  // ahead of messages already shown as queued. Every pgQueueBy write updates
  // this ref in the same tick.
  const pgQueueRef = useRef<Record<string, QueuedTurn[]>>({})
  const conns = useRef<Map<string, Conn>>(new Map())
  const conversationIds = useRef<Map<string, string>>(new Map())
  // CP session ids opened as session-targeted continuations — their sockets mint
  // through the session-target token route instead of the playground mints.
  const sessionTargets = useRef<Set<string>>(new Set())
  // Creation-time roster per session id (primary first) — drives the
  // conversation-scoped token mint for a multi-agent create.
  const rosterAgentIds = useRef<Map<string, string[]>>(new Map())
  // The in-flight send's requested turnId — lets an accepted ack from a
  // participant the client did NOT explicitly lane (a resumed conversation
  // where the relay applied the all-participants default) create its stream
  // lane lazily instead of dropping the reply.
  const pendingTurnIds = useRef<Map<string, string>>(new Map())
  // The in-flight turn's wire frame per session id: a socket that drops between `send` and the ack leaves it in limbo (it may never have reached a daemon), so the reconnect re-sends it once — same turnId, an already-admitted copy is refused `busy` and we attach to its stream — instead of only resuming a stream that may not exist.
  const pendingTurnFrames = useRef<
    Map<string, { turnId: string; frame: string; resentOn?: WebSocket; attaching?: Set<string> }>
  >(new Map())
  // Lanes that already COMPLETED for the in-flight turn (done applied, cursor
  // removed), per session id. With done-before-ack ordering the trailing ack
  // must not re-admit an empty cursor for a finished participant — it would
  // never receive another terminal frame and wedge the busy state. Reset on
  // each send (one in-flight turn per session).
  const finishedTurnLanes = useRef<Map<string, { turnId: string; agents: Set<string> }>>(new Map())
  // Cold-attached lanes (the `attach` probe reattached a reload to a live turn),
  // keyed by lane. Such a replay has no local prompt step, so the turn-shaped arm of
  // `reconcilePersistedLiveSteps` cannot retire it and the reply would render twice
  // once the transcript tail persists it. The reply post frame carries the canonical
  // postId — stamp it onto the replayed steps so the exact-postId arm retires them
  // (the same anchor #753 gave agent-initiated posts).
  const coldAttached = useRef<Map<string, { turnId: string; postId?: string; done?: boolean }>>(new Map())
  // Participant display names per session id, mirrored in a ref: the socket's
  // message handlers are closures captured when the socket opened — often the
  // same tick openPlayground staged the session — so state-based lookups there
  // would read a stale snapshot and stamp every step without a name.
  const rosterNames = useRef<Map<string, Map<string, string>>>(new Map())
  // Per-participant daemon session ids (conversation id → agentId → acp sessionId),
  // from each lane's status frames. The session row's `realSessionId` only tracks
  // the PRIMARY participant (applyStatus fences the rest out), but every member
  // owns its own daemon session — a member's tool step must carry ITS session so
  // the on-demand tool-body read targets the daemon that recorded the call.
  const agentSessionIds = useRef<Map<string, Map<string, string>>>(new Map())
  // One ordering cursor per stream LANE — a multi-agent turn runs one lane per
  // targeted participant (webchat-multi-agents.md §5.3); keys from lib/webchat-lanes.ts.
  const streamCursors = useRef<Map<string, OrderedWebchatCursor<WebchatOutput, WebchatDone>>>(new Map())
  const reconnectAttempts = useRef<Map<string, number>>(new Map())
  // Standalone set_* operations cannot bind until the first daemon session exists.
  // Keep only fields the user actually touched and attach them atomically to the turn.
  const stagedRuntime = useRef<Map<string, WebchatRuntimeConfig>>(new Map())
  const stagedWorktree = useRef<Map<string, boolean>>(new Map())
  const busyRef = useRef<Record<string, boolean>>({})
  const closingAll = useRef(false)
  const { activeOrg } = useOrgs()

  const stageRuntimeChange = useCallback((id: string, patch: WebchatRuntimeConfig): void => {
    if (!id.startsWith(PG_PREFIX)) return
    stagedRuntime.current.set(id, { ...stagedRuntime.current.get(id), ...patch })
  }, [])
  const getPgWorktree = useCallback((id: string): boolean | undefined => stagedWorktree.current.get(id), [])
  const pgSetWorktree = useCallback((id: string, worktree: boolean): void => {
    if (!id.startsWith(PG_PREFIX)) return
    stagedWorktree.current.set(id, worktree)
  }, [])

  const setBusy = useCallback((id: string, v: boolean): void => {
    if (v) busyRef.current[id] = true
    else delete busyRef.current[id]
    setPgBusyBy((cur) => (!!cur[id] === v ? cur : { ...cur, [id]: v }))
  }, [])
  const setPgInput = useCallback((id: string, v: string): void => {
    if ((pgDrafts.current[id] ?? '') === v) return
    pgDrafts.current = { ...pgDrafts.current, [id]: v }
    for (const notify of pgDraftListeners.current) notify()
  }, [])
  const subscribePgDraft = useCallback((listener: () => void): (() => void) => {
    pgDraftListeners.current.add(listener)
    return () => pgDraftListeners.current.delete(listener)
  }, [])
  const setPgImage = useCallback((id: string, image?: SessionImage): void => {
    setPgImageBy((cur) => {
      if (image) return { ...cur, [id]: image }
      if (!(id in cur)) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
  }, [])

  // Close every socket when the provider unmounts (console teardown).
  useEffect(() => {
    const map = conns.current
    return () => {
      closingAll.current = true
      for (const c of map.values()) {
        c.closing = true
        if (c.reconnectTimer) window.clearTimeout(c.reconnectTimer)
        c.ws?.close()
      }
      map.clear()
    }
  }, [])

  /** Replace a session's steps via an updater. A synthetic 'pg_' session owns a full
   *  Session (keep its tool count in sync); an adopted webchat session keeps only its
   *  live tail in `wcSteps`. */
  const mutateSteps = useCallback((id: string, fn: (steps: SessionStep[]) => SessionStep[]): void => {
    if (id.startsWith(PG_PREFIX)) {
      setPgSessions((cur) => {
        const s = cur[id]
        if (!s) return cur
        const steps = fn(s.steps)
        return {
          ...cur,
          [id]: {
            ...s,
            ...liveActivityStamp(),
            steps,
            toolCount: String(steps.filter((x) => x.kind === 'tool').length)
          }
        }
      })
    } else {
      setWcSteps((cur) => ({ ...cur, [id]: fn(cur[id] ?? NO_STEPS) }))
    }
  }, [])

  const pushStep = useCallback(
    (id: string, step: UnstampedStep): void => mutateSteps(id, (steps) => [...steps, stampStep(step)]),
    [mutateSteps]
  )

  /** Settle any card this lane left standing when its terminal frame lands. The daemon
   *  resolves every pending elicitation as the turn ends, but that output can lose the race
   *  with `done` — which retires the lane cursor, so a later event is dropped and the card
   *  would stay answerable forever. A card cannot outlive its turn, so settle it here. */
  const settleLiveElicits = useCallback(
    (id: string, agentId: string | undefined, turnId: string): void =>
      mutateSteps(id, (steps) => {
        let changed = false
        const next = steps.map((s) => {
          if (s.kind !== 'elicit' || s.turnId !== turnId || (s.agentId ?? undefined) !== agentId) return s
          if (!s.elicit || s.elicit.outcome) return s
          changed = true
          return { ...s, elicit: { ...s.elicit, outcome: 'cancelled' as const } }
        })
        return changed ? next : steps
      }),
    [mutateSteps]
  )

  /** Retire a lane's wait notice on an event that is not folded into a step (a title, a clean end). */
  const retireWaitNotice = useCallback(
    (id: string, agentId: string | undefined, turnId: string): void =>
      mutateSteps(id, (steps) => dropWaitNotices(steps, agentId, turnId)),
    [mutateSteps]
  )

  /** Apply the runtime's streamed session title so a live playground session renames
   *  in place — a synthetic 'pg_' session starts with a static "Playground · <agent>"
   *  label; the agent's auto-generated title arrives mid-turn (like a Slack session's).
   *  Only synthetic sessions are relabeled here; an adopted webchat session already
   *  carries its persisted title from the list fetch. */
  const applyTitle = useCallback((id: string, title: string, agentId?: string): void => {
    if (!title.trim() || !id.startsWith(PG_PREFIX)) return
    setPgSessions((cur) => {
      const s = cur[id]
      if (!s || s.title === title) return cur
      // The conversation title follows the PRIMARY participant's session_info
      // (webchat-multi-agents.md §8); a member's title applies only to its own row.
      if (agentId && s.agentId && agentId !== s.agentId) return cur
      return { ...cur, [id]: { ...s, title } }
    })
  }, [])

  /** Display name of a conversation participant (multi-agent sessions only —
   *  a single-agent session carries no roster and keeps unattributed steps). */
  const participantName = useCallback(
    (id: string, agentId: string | undefined): string | undefined => {
      if (!agentId) return undefined
      const named = rosterNames.current.get(id)?.get(agentId)
      if (named) return named
      const s = pgSessions[id]
      return s?.participants?.find((p) => p.agentId === agentId)?.name
    },
    [pgSessions]
  )

  /** Fold one streamed reply event into the session's steps. Consecutive
   *  thinking / message chunks accumulate into a single PLAN / DONE lane so the
   *  bot turn reads as one block instead of one row per delta. */
  const applyEvent = useCallback(
    (id: string, ev: WebchatEvent, agentId: string | undefined, turnId: string): void => {
      const observedAtMs = Date.now()
      const who = participantName(id, agentId)
      const lane = (extra: Omit<SessionStep, 'text' | 'turnId'> & { text: string }): SessionStep =>
        stampStep({ ...extra, turnId, ...(agentId ? { agentId } : {}), ...(who ? { who } : {}) }, observedAtMs)
      mutateSteps(id, (arrived) => {
        // Any streamed event ends the wait a `notice` announced, so it retires before this event lands.
        const steps = ev.kind === 'notice' ? arrived : dropWaitNotices(arrived, agentId, turnId)
        // Concurrent participant streams interleave: accumulate each chunk into
        // the most recent step OF THIS LANE (same agentId), not the array tail.
        // A user message is a hard turn boundary — never merge across it, or a
        // participant's SECOND reply would append into its previous turn's
        // block, rendered above the prompt that caused it.
        const laneIndex = (() => {
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i]!
            if (step.kind === 'msg' && step.agentId === undefined) return -1
            if ((step.agentId ?? undefined) !== agentId) continue
            // A stable stream turn is also a hard boundary. This covers
            // coalesced/resumed turns that have no newly pushed user row.
            if (step.turnId !== turnId) return -1
            // The supersession marker is a hard boundary: the replacement
            // generation starts fresh blocks instead of merging into it (or
            // into the collapsed discarded work behind it).
            if (step.boundary) return -1
            return i
          }
          return -1
        })()
        const last = laneIndex >= 0 ? steps[laneIndex] : undefined
        const replaceAt = (i: number, step: SessionStep): SessionStep[] => [
          ...steps.slice(0, i),
          step,
          ...steps.slice(i + 1)
        ]
        if (ev.kind === 'superseded') {
          // Turn-final context refresh discarded the streamed candidate
          // (webchat-multi-agents.md §5.4): COLLAPSE the discarded answer —
          // this lane's streamed 'done' blocks since the last user message move
          // into the collapsible work lane ('plan') — then break the lane with
          // a marker so the replacement starts a fresh answer block.
          const collapsed = [...steps]
          for (let i = collapsed.length - 1; i >= 0; i--) {
            const step = collapsed[i]!
            if (step.kind === 'msg' && step.agentId === undefined) break
            if ((step.agentId ?? undefined) !== agentId) continue
            if (step.turnId !== turnId) break
            if (step.boundary) break
            if (step.kind === 'done') collapsed[i] = { ...step, kind: 'plan', demoted: true }
          }
          // The marker lives INSIDE the collapsible work lane ('plan'), at the
          // chronological point the update happened — it is live-only chrome (a
          // refresh rebuilds from the persisted transcript, which never records
          // it), so it must not masquerade as standing conversation content.
          // `boundary` still fences it: replacement chunks start fresh blocks.
          return [
            ...collapsed,
            lane({ kind: 'plan', text: 'The conversation moved on — updating this answer…', boundary: true })
          ]
        }
        if (ev.kind === 'plan') {
          // A snapshot: ACP resends the whole list, so this REPLACES the lane's existing
          // block instead of appending a second one, keeping the position it first took —
          // ahead of the work it planned, exactly as the persisted plan row keeps its `seq`.
          // Fenced by agent and turn like tool_update, but deliberately NOT by `boundary`:
          // the daemon builds ONE TranscriptRecorder per turn, so a context-refresh
          // replacement generation rewrites the SAME row. Stopping at the supersession
          // marker would append a second checklist and leave the live view showing both the
          // discarded plan and the current one, where a reload shows only the latter. The
          // boundary exists to stop streamed TEXT merging across generations; a plan is a
          // snapshot keyed to the turn, so it crosses.
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i]!
            if (step.kind === 'msg' && step.agentId === undefined) break
            if ((step.agentId ?? undefined) !== agentId) continue
            if (step.turnId !== turnId) break
            if (step.kind === 'planblock') return replaceAt(i, { ...step, plan: ev.entries, observedAtMs })
          }
          return [...steps, lane({ kind: 'planblock', text: '', plan: ev.entries })]
        }
        if (ev.kind === 'elicitation') {
          // The agent's question, standing in the conversation until it is answered.
          // `boundary` keeps the reply chunks that follow from accumulating into it.
          return [
            ...steps,
            lane({
              kind: 'elicit',
              text: ev.message,
              elicit: { requestId: ev.requestId, options: ev.options },
              boundary: true
            })
          ]
        }
        if (ev.kind === 'elicitation_resolved') {
          // Settle the card in place — the append-only stream's equivalent of Slack
          // rewriting its message. Scanned across the whole transcript, since a card can
          // outlive the lane fences the chunk accumulator stops at, but matched on lane
          // identity too: `elicit-<n>` is unique only within one daemon, so two
          // participants on different daemons can hold the same id concurrently.
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i]!
            if (step.kind !== 'elicit' || step.elicit?.requestId !== ev.requestId) continue
            if ((step.agentId ?? undefined) !== agentId || step.turnId !== turnId) continue
            return replaceAt(i, {
              ...step,
              elicit: {
                ...step.elicit,
                outcome: ev.outcome,
                ...(ev.label !== undefined ? { answerLabel: ev.label } : {})
              },
              observedAtMs
            })
          }
          return steps
        }
        if (ev.kind === 'notice') {
          // Daemon chrome for a wait with nothing else to show (a sandbox pod coming up).
          // Its own lane, not the work lane: it is not something the agent thought or did,
          // so it must not be counted or hidden as a reasoning step. `boundary` keeps the
          // reply chunks that follow from accumulating into it.
          return [...steps, lane({ kind: 'notice', text: ev.text, boundary: true })]
        }
        if (ev.kind === 'message') {
          if (last && last.kind === 'done' && last.who === who) {
            return replaceAt(laneIndex, { ...last, text: last.text + ev.text, observedAtMs })
          }
          return [...steps, lane({ kind: 'done', text: ev.text })]
        }
        if (ev.kind === 'thinking') {
          if (last && last.kind === 'plan' && last.who === who) {
            return replaceAt(laneIndex, { ...last, text: last.text + ev.text, observedAtMs })
          }
          return [...steps, lane({ kind: 'plan', text: ev.text })]
        }
        if (ev.kind === 'tool_call') {
          // The owning participant's daemon session (recorded from its status
          // lane) — the tool-body read must target the session that logged this
          // call, not the conversation's primary. Falls back through the sole/
          // primary lane key; absent until that lane's first status frame lands,
          // in which case the detail view falls back to the row's realSessionId.
          const toolSessionId =
            agentSessionIds.current.get(id)?.get(agentId ?? '') ?? agentSessionIds.current.get(id)?.get('')
          return [
            ...steps,
            lane({
              kind: 'tool',
              text: ev.title || 'tool call',
              toolCallId: ev.toolCallId,
              toolStatus: ev.status,
              ...(toolSessionId ? { toolSessionId } : {})
            })
          ]
        }
        if (ev.kind === 'tool_update') {
          // Address the update to ITS call, not the lane tail: ACP allows parallel
          // tool calls, so the most recent tool step may belong to a different call.
          // Same fences as the lane scan above — never cross a user message, a
          // foreign turn, or the supersession boundary.
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i]!
            if (step.kind === 'msg' && step.agentId === undefined) break
            if ((step.agentId ?? undefined) !== agentId) continue
            if (step.turnId !== turnId) break
            if (step.boundary) break
            if (step.kind === 'tool' && step.toolCallId === ev.toolCallId) {
              return replaceAt(i, {
                ...step,
                toolStatus: ev.status,
                ...(ev.title ? { text: ev.title } : {}),
                observedAtMs
              })
            }
          }
          return steps // no matching call in this lane (e.g. suppressed tool_call)
        }
        return steps
      })
    },
    [mutateSteps, participantName]
  )

  // WebSocket messages arrive as separate browser tasks, so React cannot batch
  // their state updates automatically. Accumulate text per participant lane for
  // one animation frame (with a 50 ms background-tab cap) and commit once.
  const applyEventRef = useRef(applyEvent)
  applyEventRef.current = applyEvent
  const deltaBufferRef = useRef<WebchatDeltaBuffer | null>(null)
  if (!deltaBufferRef.current) {
    deltaBufferRef.current = createWebchatDeltaBuffer((batch) => {
      applyEventRef.current(batch.sessionId, batch.event, laneAgentId(batch.laneKey), batch.turnId)
    })
  }
  const deltaBuffer = deltaBufferRef.current
  useEffect(() => () => deltaBuffer.discardAll(), [deltaBuffer])

  /** Fold a status snapshot (model / context / tokens / cost) into the session's headline
   *  fields + `usage` — this is the live status bar, NOT a transcript step. Only defined
   *  fields overwrite, so a partial snapshot (context-only mid-turn) never clears the
   *  model or the last token total. Playground sessions only (adopted webchat rows carry
   *  their own persisted headline). */
  const applyStatus = useCallback((id: string, st: WebchatStatus, agentId?: string): void => {
    // Record every participant's session id BEFORE the primary fence below —
    // member lanes never reach the session-row merge, but their tool steps need
    // the owning session for the live tool-body read (keyed '' for the sole/
    // primary lane, whose frames may omit agentId).
    if (st.sessionId) {
      const perAgent = agentSessionIds.current.get(id) ?? new Map<string, string>()
      perAgent.set(agentId ?? '', st.sessionId)
      agentSessionIds.current.set(id, perAgent)
    }
    setPgSessions((cur) => {
      const s = cur[id]
      if (!s) return cur
      // Headline runtime/usage fields track the PRIMARY participant; a member
      // agent's status frames only belong to its own session row (multi-agent
      // conversations expose no in-conversation runtime controls anyway).
      if (agentId && s.agentId && agentId !== s.agentId) return cur
      const usage = {
        ...s.usage,
        ...(st.contextUsed !== undefined ? { contextUsed: st.contextUsed } : {}),
        ...(st.contextSize !== undefined ? { contextSize: st.contextSize } : {}),
        ...(st.totalTokens !== undefined ? { totalTokens: st.totalTokens } : {}),
        ...(st.costAmount !== undefined ? { costAmount: st.costAmount } : {}),
        ...(st.costCurrency !== undefined ? { costCurrency: st.costCurrency } : {})
      }
      return {
        ...cur,
        [id]: {
          ...s,
          usage,
          ...(st.model !== undefined ? { model: st.model } : {}),
          ...(st.models !== undefined ? { availableModels: st.models } : {}),
          ...(st.effort !== undefined ? { effort: st.effort } : {}),
          ...(st.efforts !== undefined ? { availableEfforts: st.efforts } : {}),
          ...(st.permissionMode !== undefined ? { permissionMode: st.permissionMode } : {}),
          ...(st.permissionModes !== undefined ? { availablePermissionModes: st.permissionModes } : {}),
          ...(st.fastMode !== undefined ? { fastMode: st.fastMode } : {}),
          ...(st.fastModeAvailable !== undefined ? { fastModeAvailable: st.fastModeAvailable } : {}),
          ...(st.sessionId !== undefined ? { realSessionId: st.sessionId } : {}),
          ...(st.totalTokens !== undefined ? { tokens: fmtCountCompact(st.totalTokens) } : {}),
          ...(st.costAmount !== undefined ? { cost: fmtCost(st.costAmount, st.costCurrency) } : {})
        }
      }
    })
  }, [])

  // ── stream lanes ──────────────────────────────────────────────────────────
  // Cursor keys come from lib/webchat-lanes.ts. Agent-tagged frames match their
  // exact lane only — an unknown tagged participant is admitted lazily from its
  // ack — while the sole-lane fallback is reserved for legacy frames that omit
  // agentId.
  const lanesOf = (id: string): string[] => lanesOfLanes(streamCursors.current, id)
  const finishedFor = (id: string, turnId: string | undefined): ReadonlySet<string> | undefined => {
    const rec = finishedTurnLanes.current.get(id)
    return rec && rec.turnId === turnId ? rec.agents : undefined
  }
  const cursorKeyFor = (id: string, agentId?: string): string | undefined =>
    cursorKeyForLanes(streamCursors.current, id, agentId)
  // REACTIVE lane membership (review fix): the cursor map is a ref, and a
  // lane's removal (a peer's non-final done) may arrive with no other state
  // change — reading the ref at render time would keep showing a finished
  // agent as typing until someone else emits. Every cursor add/delete calls
  // syncBusyLanes, which mirrors the membership into state only when it
  // actually changed.
  const [busyLaneAgents, setBusyLaneAgents] = useState<Record<string, string[]>>({})
  const syncBusyLanes = useCallback((id: string) => {
    setBusyLaneAgents((current) => {
      const next = lanesOfLanes(streamCursors.current, id)
        .map((key) => laneAgentId(key))
        .filter((agentId): agentId is string => agentId !== undefined)
        .sort()
      const previous = current[id] ?? []
      if (previous.length === next.length && previous.every((value, i) => value === next[i])) return current
      return { ...current, [id]: next }
    })
  }, [])
  const getBusyLaneAgentIds = useCallback((id: string): string[] => busyLaneAgents[id] ?? [], [busyLaneAgents])
  const dropLanes = (id: string): void => {
    // Preserve text already received before surfacing a terminal connection
    // error; otherwise the final sub-frame would disappear from the transcript.
    deltaBuffer.flushSession(id)
    for (const key of lanesOf(id)) {
      streamCursors.current.delete(key)
      coldAttached.current.delete(key)
    }
    syncBusyLanes(id)
  }

  const failStream = useCallback(
    (id: string, message: string): void => {
      dropLanes(id)
      reconnectAttempts.current.delete(id)
      pushStep(id, { kind: 'done', text: `⚠️ ${message}` })
      setBusy(id, false)
    },
    [pushStep, setBusy]
  )

  /** Retire a cold-attached turn's replayed steps by stamping the reply's canonical
   *  postId on them (see `coldAttached`), once both the postId and the lane's `done`
   *  are in — either order: the failure path sends `done` before the reply post. */
  const anchorColdTurn = useCallback(
    (id: string, cursorKey: string): void => {
      const cold = coldAttached.current.get(cursorKey)
      const postId = cold?.postId
      if (!cold || !postId || !cold.done) return
      coldAttached.current.delete(cursorKey)
      const agentId = laneAgentId(cursorKey)
      mutateSteps(id, (steps) =>
        steps.map((step) =>
          step.turnId === cold.turnId && (step.agentId ?? undefined) === agentId && !step.postId
            ? { ...step, postId }
            : step
        )
      )
    },
    [mutateSteps]
  )

  const applyStreamResult = useCallback(
    (id: string, cursorKey: string, result: OrderedWebchatResult<WebchatOutput, WebchatDone>): void => {
      const agentId = laneAgentId(cursorKey)
      if (result.overflow) {
        failStream(id, 'Connection interrupted — refresh to load the complete response.')
        return
      }
      for (const output of result.outputs) {
        if (output.status) applyStatus(id, output.status, agentId)
        const event = output.event
        if (event) {
          if (event.kind === 'message' || event.kind === 'thinking') {
            deltaBuffer.enqueue(cursorKey, id, output.turnId, event)
          } else {
            // Tool/supersession events are ordering fences: make preceding text
            // visible before applying the non-text event.
            deltaBuffer.flush(cursorKey)
            if (event.kind === 'session_info') {
              // Not a step, but still streamed by a live runtime — so it ends the wait too.
              applyTitle(id, event.title, agentId)
              retireWaitNotice(id, agentId, output.turnId)
            } else applyEvent(id, event, agentId, output.turnId)
          }
        }
      }
      if (!result.done) return
      // `done` is a hard fence and must not clear busy state before the last
      // buffered reply text has committed.
      deltaBuffer.flush(cursorKey)
      // Every replayed step of a cold-attached turn is now committed — anchor it. Only
      // after the flush: the final chunk becomes a step here.
      const cold = coldAttached.current.get(cursorKey)
      if (cold) {
        cold.done = true
        anchorColdTurn(id, cursorKey)
      }
      reconnectAttempts.current.delete(id)
      streamCursors.current.delete(cursorKey)
      syncBusyLanes(id)
      if (agentId && result.done.turnId) {
        const rec = finishedTurnLanes.current.get(id)
        if (rec && rec.turnId === result.done.turnId) rec.agents.add(agentId)
        else finishedTurnLanes.current.set(id, { turnId: result.done.turnId, agents: new Set([agentId]) })
      }
      if (result.done.turnId) settleLiveElicits(id, agentId, result.done.turnId)
      if (result.done.error) {
        // The notice STAYS on a failure: a turn that died waiting for its pod is explained by it.
        const name = participantName(id, agentId)
        pushStep(id, {
          kind: 'done',
          turnId: result.done.turnId,
          ...(agentId ? { agentId } : {}),
          ...(name ? { who: name } : {}),
          text: `⚠️ ${result.done.error}`
        })
      } else {
        // A lane can end having streamed nothing at all — a silent AC_NO_RESPONSE decline holds
        // every chunk back — so a clean end is the last chance to retire the wait it announced.
        retireWaitNotice(id, agentId, result.done.turnId)
      }
      // The turn stays busy until every targeted participant's lane finished.
      if (lanesOf(id).length === 0) setBusy(id, false)
    },
    [
      anchorColdTurn,
      applyEvent,
      applyStatus,
      applyTitle,
      deltaBuffer,
      failStream,
      participantName,
      pushStep,
      retireWaitNotice,
      setBusy,
      settleLiveElicits
    ]
  )

  const receiveOutput = useCallback(
    (id: string, output: WebchatOutput): void => {
      let key = cursorKeyFor(id, output.agentId)
      // A warm session's first stream frame can beat the participant's ack to
      // the browser (the daemon emits it synchronously inside turn admission).
      // Any tagged frame of the in-flight turn admits the lane exactly like the
      // ack — dropping it would leave the ordered cursor holding every later
      // frame while it waits for this one (webchat-multi-agents.md §5.3).
      if (
        !key &&
        admitsLane(output.agentId, output.turnId, pendingTurnIds.current.get(id), finishedFor(id, output.turnId))
      ) {
        key = laneKey(id, output.agentId)
        streamCursors.current.set(key, createWebchatCursor<WebchatOutput, WebchatDone>(output.turnId))
        syncBusyLanes(id)
      }
      const cursor = key ? streamCursors.current.get(key) : undefined
      if (!key || !cursor || !bindWebchatTurn(cursor, output.turnId)) return
      reconnectAttempts.current.delete(id)
      applyStreamResult(id, key, acceptWebchatOutput(cursor, output))
    },
    [applyStreamResult]
  )

  const receiveDone = useCallback(
    (id: string, done: WebchatDone): void => {
      let key = cursorKeyFor(id, done.agentId)
      // Same early-frame admission as receiveOutput: a participant's terminal
      // frame (e.g. a coalesced turn's immediate done) may also beat its ack.
      if (!key && admitsLane(done.agentId, done.turnId, pendingTurnIds.current.get(id), finishedFor(id, done.turnId))) {
        key = laneKey(id, done.agentId)
        streamCursors.current.set(key, createWebchatCursor<WebchatOutput, WebchatDone>(done.turnId))
        syncBusyLanes(id)
      }
      const cursor = key ? streamCursors.current.get(key) : undefined
      if (!key || !cursor) return
      applyStreamResult(id, key, acceptWebchatDone(cursor, done))
    },
    [applyStreamResult]
  )

  /** Open (or reuse) the webchat socket for a session. `conversationId` RESUMES an
   *  existing conversation (adopted webchat sessions); omit it for a fresh playground
   *  turn (the CP mints the id). */
  const connect = useCallback(
    (id: string, agentId: string, conversationId?: string, resumeStream = false, probeOnReady = false): Conn => {
      const resumeId = conversationId ?? conversationIds.current.get(id)
      if (resumeId) conversationIds.current.set(id, resumeId)
      const existing = conns.current.get(id)
      if (existing) {
        // Reuse a still-pending (ws not yet assigned) or live/connecting socket. A
        // CLOSED/CLOSING one is stale — drop it so we rebuild below, otherwise a
        // dropped socket would be reused forever and a resume's conversationId lost.
        const rs = existing.ws?.readyState
        const sameConversation = !resumeId || !existing.conversationId || existing.conversationId === resumeId
        if (sameConversation && (rs === undefined || rs === WebSocket.CONNECTING || rs === WebSocket.OPEN)) {
          return existing
        }
        existing.closing = true
        if (existing.reconnectTimer) window.clearTimeout(existing.reconnectTimer)
        existing.ws?.close()
        conns.current.delete(id)
      }

      // Remove THIS conn from the map if it's still the mapped one — lets the next
      // connect() rebuild instead of handing back a dead/rejected connection.
      const dropSelf = (): void => {
        if (conns.current.get(id) === conn) conns.current.delete(id)
      }

      const sendLaneResume = (ws: WebSocket, key: string): void => {
        const cursor = streamCursors.current.get(key)
        const turnId = cursor?.turnId ?? cursor?.requestedTurnId
        if (!cursor || !turnId || ws.readyState !== WebSocket.OPEN) return
        cursor.resumeGeneration += 1
        const agentId = laneAgentId(key)
        ws.send(
          JSON.stringify({
            type: 'resume',
            turnId,
            ...(agentId ? { agentId } : {}),
            generation: cursor.resumeGeneration,
            afterIndex: cursor.nextIndex - 1
          })
        )
      }

      /** The turn nobody acked yet, if this reconnect should put it back on the wire (once per socket). */
      const unackedTurn = (
        ws: WebSocket
      ): NonNullable<ReturnType<typeof pendingTurnFrames.current.get>> | undefined => {
        const pending = pendingTurnFrames.current.get(id)
        if (!pending || pending.resentOn === ws || ws.readyState !== WebSocket.OPEN) return undefined
        const lanes = lanesOf(id).map((key) => streamCursors.current.get(key))
        const unacked =
          lanes.length > 0 &&
          lanes.every((cursor) => cursor && cursor.turnId === undefined && cursor.requestedTurnId === pending.turnId)
        return unacked ? pending : undefined
      }

      const sendResume = (ws: WebSocket): void => {
        // Nobody acked the in-flight turn: it may not exist anywhere, so re-send it (same turnId) rather than resume a stream never opened — the daemon answers an admitted copy `busy`, and that ack attaches us (see the ack handler).
        const pending = unackedTurn(ws)
        if (pending) {
          pending.resentOn = ws
          ws.send(pending.frame)
          return
        }
        // One resume per live lane — a multi-agent turn streams from several
        // participants, each with its own daemon-side replay window.
        for (const key of lanesOf(id)) sendLaneResume(ws, key)
      }

      /** A reconnect can beat the original turn across different relay links.
       * Retry only inside the same bounded admission window; once the delayed
       * turn exists, daemon replay recovers everything emitted in the meantime. */
      const scheduleResumeRetry = (ws: WebSocket): void => {
        const attempt = reconnectAttempts.current.get(id) ?? 0
        if (attempt >= WEBCHAT_RECONNECT_MAX_ATTEMPTS) {
          failStream(id, 'The response could not be resumed — refresh to load its latest state.')
          return
        }
        reconnectAttempts.current.set(id, attempt + 1)
        const delay = Math.min(WEBCHAT_RECONNECT_MAX_MS, WEBCHAT_RECONNECT_BASE_MS * 2 ** attempt)
        conn.reconnectTimer = window.setTimeout(() => {
          conn.reconnectTimer = undefined
          if (!busyRef.current[id] || conns.current.get(id) !== conn) return
          sendResume(ws)
        }, delay)
      }

      const scheduleReconnect = (): void => {
        const reconnectId = conn.conversationId ?? resumeId ?? conversationIds.current.get(id)
        if (closingAll.current || conn.closing || !busyRef.current[id] || !reconnectId) {
          setBusy(id, false)
          return
        }
        const attempt = reconnectAttempts.current.get(id) ?? 0
        if (attempt >= WEBCHAT_RECONNECT_MAX_ATTEMPTS) {
          failStream(id, 'Connection interrupted.')
          return
        }
        reconnectAttempts.current.set(id, attempt + 1)
        const delay = Math.min(WEBCHAT_RECONNECT_MAX_MS, WEBCHAT_RECONNECT_BASE_MS * 2 ** attempt)
        conn.reconnectTimer = window.setTimeout(() => {
          conn.reconnectTimer = undefined
          if (!busyRef.current[id] || conns.current.has(id)) return
          void connect(id, agentId, reconnectId, true).ready.catch(() => {})
        }, delay)
      }

      const ready = new Promise<WebSocket>((resolve, reject) => {
        const orgId = activeOrg?.id
        if (!orgId) return reject(new Error('no active org'))
        // A session-targeted continuation mints through the session-target route
        // on every (re)connect — the CP re-runs the continuation gates and
        // converges on the caller's one adopted conversation.
        void (
          sessionTargets.current.has(id)
            ? webchatSessionWsUrl(orgId, id)
            : webchatWsUrl(orgId, agentId, resumeId, rosterAgentIds.current.get(id))
        )
          .then((url) => {
            const ws = new WebSocket(url)
            ws.onopen = () => resolve(ws)
            ws.onerror = () => reject(new Error('webchat connection failed'))
            ws.onclose = () => {
              if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer)
              conn.reconnectTimer = undefined
              dropSelf()
              if (busyRef.current[id]) scheduleReconnect()
              else setBusy(id, false)
            }
            /** A per-participant rejection: fail only that lane — the other targets of a multi-agent turn keep streaming. */
            const rejectLane = (
              agentId: string | undefined,
              turnId: string | undefined,
              reason: string | undefined,
              detail?: string
            ) => {
              const key = cursorKeyFor(id, agentId)
              if (key) {
                deltaBuffer.flush(key)
                streamCursors.current.delete(key)
                syncBusyLanes(id)
              }
              const name = participantName(id, agentId)
              pushStep(id, {
                kind: 'done',
                ...(turnId ? { turnId } : {}),
                ...(agentId ? { agentId } : {}),
                ...(name ? { who: name } : {}),
                text:
                  reason === 'paused'
                    ? `⚠️ ${name ?? 'Agent'} is paused — it is not processing messages.`
                    : reason === 'busy'
                      ? `⚠️ ${name ?? 'Agent'} is busy — try again shortly.`
                      : reason === 'not_participant'
                        ? `⚠️ ${name ?? 'That agent'} is not in this conversation.`
                        : // Its daemon is live; the runtime it launches is not. Say so, and name the
                          // cause the daemon reported instead of blaming a daemon that answered.
                          reason === 'start_failed'
                          ? `⚠️ ${name ?? 'Agent'} could not start${detail ? ` — ${detail}` : ' — check the daemon logs.'}`
                          : `⚠️ ${name ?? 'Agent'} is unavailable — no live daemon is serving it.`
              })
              if (lanesOf(id).length === 0) {
                reconnectAttempts.current.delete(id)
                setBusy(id, false)
              }
            }
            ws.onmessage = (e) => {
              let m: {
                type?: string
                conversationId?: string
                participants?: WebchatParticipant[]
                output?: WebchatOutput
                done?: WebchatDone
                ack?: {
                  accepted?: boolean
                  reason?: string
                  detail?: string
                  turnId?: string
                  agentId?: string
                  generation?: number
                }
                post?: WebchatPost
                initiator?: string
              }
              try {
                m = JSON.parse(String(e.data))
              } catch {
                return
              }
              if (m.type === 'ready') {
                if (typeof m.conversationId === 'string') {
                  conn.conversationId = m.conversationId
                  conversationIds.current.set(id, m.conversationId)
                  setPgSessions((current) => {
                    const session = current[id]
                    if (!session) return current
                    // Adopt the verified roster: names were seeded at open
                    // (openPlayground) — keep them; a resume without seeds falls
                    // back to short ids until the detail view resolves names.
                    const verified = m.participants
                    const participants =
                      verified && verified.length > 1
                        ? verified.map((p) => ({
                            agentId: p.agentId,
                            name:
                              session.participants?.find((x) => x.agentId === p.agentId)?.name ?? p.agentId.slice(0, 8),
                            ...(p.primary ? { primary: true } : {})
                          }))
                        : session.participants
                    return {
                      ...current,
                      [id]: {
                        ...session,
                        channelId: m.conversationId!,
                        ...(participants ? { participants } : {})
                      }
                    }
                  })
                }
                if (resumeStream && busyRef.current[id]) {
                  sendResume(ws)
                } else if (probeOnReady && !busyRef.current[id] && lanesOf(id).length === 0) {
                  // Cold-load discovery: ask each verified participant's daemon
                  // whether a turn is still streaming here (see the 'attached'
                  // handler below). Idle daemons answer with a quiet refusal.
                  const probeIds = m.participants?.length ? m.participants.map((p) => p.agentId) : [agentId]
                  for (const probeId of probeIds) ws.send(JSON.stringify({ type: 'attach', agentId: probeId }))
                }
              } else if (m.type === 'output') {
                if (m.output) receiveOutput(id, m.output)
              } else if (m.type === 'done') {
                if (m.done) receiveDone(id, m.done)
              } else if (m.type === 'post' && m.post?.author.kind === 'agent') {
                const agentId = m.post.author.agentId
                const post = m.post
                // This lane's own reply post while cold-attached: keep the canonical
                // postId as that turn's retirement anchor. An agent-initiated post is
                // a DIFFERENT turn's reply and must not anchor the attached one.
                const coldKey = laneKey(id, agentId)
                const cold = m.initiator === 'agent' ? undefined : coldAttached.current.get(coldKey)
                if (cold) {
                  cold.postId = post.postId
                  anchorColdTurn(id, coldKey)
                }
                // Agent-initiated turn (another participant's sendMessage/lineage-reply
                // wake, #753): it never streamed output/done to this socket, so the
                // completed post IS its first and only rendering here. A human-initiated
                // turn already streamed it and only needs the anchor above.
                // Keyed by postId so a daemon re-broadcast (inbox replay, relay fan-out
                // echo) upserts instead of duplicating the step.
                if (m.initiator === 'agent')
                  mutateSteps(id, (steps) =>
                    steps.some((step) => step.postId === post.postId)
                      ? steps
                      : [
                          ...steps,
                          stampStep({
                            kind: 'done',
                            turnId: post.postId,
                            // The daemon persists this reply before the post frame ever arrives, so
                            // `postId` is what lets `reconcilePersistedLiveSteps` drop this step once
                            // the canonical row lands in a later transcript refresh (#753) — text/time
                            // matching (the prompt-turn heuristic) has nothing to anchor on here.
                            postId: post.postId,
                            agentId,
                            ...(participantName(id, agentId) ? { who: participantName(id, agentId) } : {}),
                            text: post.text
                          })
                        ]
                  )
              } else if (m.type === 'ack' && m.ack?.accepted !== false) {
                let key = cursorKeyFor(id, m.ack?.agentId)
                // The relay may target participants the client did not lane (a
                // resumed conversation without a local roster): admit the lane
                // on its ack so the reply stream binds instead of dropping.
                const ackAgentId = m.ack?.agentId
                const ackTurnId = m.ack?.turnId
                if (
                  !key &&
                  ackAgentId &&
                  ackTurnId &&
                  admitsLane(ackAgentId, ackTurnId, pendingTurnIds.current.get(id), finishedFor(id, ackTurnId))
                ) {
                  key = laneKey(id, ackAgentId)
                  streamCursors.current.set(key, createWebchatCursor<WebchatOutput, WebchatDone>(ackTurnId))
                  syncBusyLanes(id)
                }
                const cursor = key ? streamCursors.current.get(key) : undefined
                if (cursor && m.ack?.turnId) bindWebchatTurn(cursor, m.ack.turnId)
              } else if (m.type === 'attached') {
                // Cold-load probe verdict: a hit names the in-flight turn — recreate
                // its lane, seed the cursor's generation from the daemon's (so our
                // resume outruns pre-reload generations), restore busy, and pull the
                // stream from the start through the ordinary resume path. A miss is
                // the normal idle answer and stays silent.
                const a = m.ack
                if (a?.accepted === true && typeof a.turnId === 'string' && typeof a.agentId === 'string') {
                  const key = laneKey(id, a.agentId)
                  if (!streamCursors.current.has(key) && !finishedFor(id, a.turnId)?.has(a.agentId)) {
                    const cursor = createWebchatCursor<WebchatOutput, WebchatDone>(a.turnId)
                    bindWebchatTurn(cursor, a.turnId)
                    if (typeof a.generation === 'number') cursor.resumeGeneration = a.generation
                    streamCursors.current.set(key, cursor)
                    // No local prompt step to reconcile against — the reply post frame
                    // will name this turn's retirement anchor (see `coldAttached`).
                    coldAttached.current.set(key, { turnId: a.turnId })
                    syncBusyLanes(id)
                    setBusy(id, true)
                    sendLaneResume(ws, key)
                  }
                }
              } else if (m.type === 'resumed' && m.ack?.accepted !== false) {
                const key = cursorKeyFor(id, m.ack?.agentId)
                const cursor = key ? streamCursors.current.get(key) : undefined
                if (cursor && m.ack?.turnId) bindWebchatTurn(cursor, m.ack.turnId)
                if (key) pendingTurnFrames.current.get(id)?.attaching?.delete(key)
                reconnectAttempts.current.delete(id)
              } else if (m.type === 'resumed' && m.ack?.accepted === false) {
                const key = cursorKeyFor(id, m.ack?.agentId)
                const pending = pendingTurnFrames.current.get(id)
                if (key && pending?.resentOn === ws && pending.attaching?.has(key)) {
                  pending.attaching.delete(key)
                  // The attach after a `busy` copy found no stream: that `busy` was the daemon's real verdict (drain / queue full), not a duplicate — report it as such.
                  if (m.ack.reason === 'stream_not_found') {
                    rejectLane(m.ack.agentId, pending.turnId, 'busy')
                    return
                  }
                }
                const awaitingAdmission =
                  m.ack.reason === 'stream_not_found' && !(key ? streamCursors.current.get(key)?.turnId : undefined)
                if (awaitingAdmission) scheduleResumeRetry(ws)
                else
                  failStream(
                    id,
                    m.ack.reason === 'stream_gap'
                      ? 'Some response updates could not be recovered — refresh to load the complete response.'
                      : 'The response could not be resumed — refresh to load its latest state.'
                  )
              } else if (
                m.type === 'ack' &&
                m.ack?.accepted === false &&
                m.ack.reason === 'busy' &&
                m.ack.turnId !== undefined &&
                pendingTurnFrames.current.get(id)?.resentOn === ws &&
                pendingTurnFrames.current.get(id)?.turnId === m.ack.turnId
              ) {
                // `busy` for our re-sent copy is ambiguous — a stream this turn already opened (the original was admitted, its ack lost), or a real drain / queue-full refusal — so try to attach; the `resumed` verdict settles which it was.
                const key = cursorKeyFor(id, m.ack.agentId)
                const pending = pendingTurnFrames.current.get(id)
                if (key && pending) {
                  ;(pending.attaching ??= new Set()).add(key)
                  sendLaneResume(ws, key)
                }
              } else if (m.type === 'ack' && m.ack?.accepted === false) {
                rejectLane(m.ack.agentId, m.ack.turnId, m.ack.reason, m.ack.detail)
              } else if (m.type === 'error') {
                // An error frame with nothing in flight (e.g. an older relay answering
                // the attach probe with 'unrecognized frame') must not push a warning
                // step into an idle transcript.
                if (busyRef.current[id]) failStream(id, 'Connection error.')
              }
            }
            if (conns.current.get(id) === conn) conn.ws = ws
          })
          .catch((err) => {
            dropSelf() // URL/token resolution failed — drop the poisoned entry so a retry rebuilds
            if (busyRef.current[id] && resumeId) scheduleReconnect()
            reject(err) // settle `ready` so pgSend's .catch clears the busy flag
          })
      })
      // `ws` is assigned once the URL/token resolve; a placeholder keeps the map
      // entry stable so a rapid second send reuses this same pending connection.
      const conn: Conn = { ready, ...(resumeId ? { conversationId: resumeId } : {}) }
      conns.current.set(id, conn)
      return conn
    },
    [activeOrg, deltaBuffer, failStream, receiveDone, receiveOutput, pushStep, setBusy]
  )

  const openPlayground = useCallback(
    (da: Agent, members?: Agent[], options?: { worktree?: boolean }): string => {
      const id = newPlaygroundSessionId(da.id)
      if (da.workspace && isGitWorkspace(da.workspace)) {
        stagedWorktree.current.set(id, options?.worktree ?? da.workspace.worktree === true)
      }
      // The roster is fixed at creation (webchat-multi-agents.md §3.1): the
      // first pick is the primary; there is no add/remove after the first send.
      const roster = [da, ...(members ?? []).filter((m) => m.id !== da.id)]
      if (roster.length > 1) {
        rosterAgentIds.current.set(
          id,
          roster.map((a) => a.id)
        )
        rosterNames.current.set(id, new Map(roster.map((a) => [a.id, agentLabel(a)])))
      }
      setPgSessions((cur) => {
        return {
          ...cur,
          [id]: {
            id,
            title: 'Playground · ' + roster.map((a) => agentLabel(a)).join(', '),
            ...liveActivityStamp(),
            status: 'online',
            platform: 'playground',
            channel: 'Playground',
            user: '@you',
            agentId: da.id,
            agentName: agentLabel(da),
            ...(roster.length > 1
              ? {
                  participants: roster.map((a, i) => ({
                    agentId: a.id,
                    name: agentLabel(a),
                    ...(i === 0 ? { primary: true } : {})
                  }))
                }
              : {}),
            model: da.model,
            runtime: da.runtime,
            permissionMode: da.permissionMode,
            duration: 'live',
            tokens: '0',
            cost: '—',
            toolCount: '0',
            statusLabel: 'Live',
            steps: []
          }
        }
      })
      setPgInput(id, '')
      setPgImage(id)
      setBusy(id, false)
      // Warm the socket so the first turn is snappy. Swallow its ready rejection here —
      // a token-mint failure (e.g. no relay pool configured → 503) is surfaced on the
      // actual send in pgSend; an unhandled warm-connect rejection would just noise logs.
      connect(id, da.id).ready.catch(() => {})
      return id
    },
    [connect, setPgImage, setPgInput, setBusy]
  )

  const pgAddAgent = useCallback(
    async (id: string, added: Agent): Promise<boolean> => {
      const orgId = activeOrg?.id
      const session = pgSessions[id]
      const primaryId = session?.agentId
      if (!orgId || !primaryId) return false
      // Already there — nothing to join, but not a failure either.
      if (primaryId === added.id || session.participants?.some((p) => p.agentId === added.id)) return true
      if (busyRef.current[id]) {
        pushStep(id, { kind: 'done', text: '⚠️ Wait for the current reply to finish before adding an agent.' })
        return false
      }
      const conversationId = conversationIds.current.get(id)
      if (conversationId) {
        try {
          await addWebchatConversationAgent(orgId, conversationId, added.id)
        } catch (err) {
          pushStep(id, {
            kind: 'done',
            text: `⚠️ ${err instanceof ApiError ? err.message : `Could not add ${agentLabel(added)}.`}`
          })
          return false
        }
      }
      const ids = rosterAgentIds.current.get(id) ?? [primaryId]
      if (!ids.includes(added.id)) rosterAgentIds.current.set(id, [...ids, added.id])
      const names = rosterNames.current.get(id) ?? new Map<string, string>()
      if (!names.size && session.agentName) names.set(primaryId, session.agentName)
      names.set(added.id, agentLabel(added))
      rosterNames.current.set(id, names)
      setPgSessions((cur) => {
        const s = cur[id]
        if (!s || !s.agentId) return cur
        const base = s.participants ?? [{ agentId: s.agentId, name: s.agentName ?? '', primary: true }]
        if (base.some((p) => p.agentId === added.id)) return cur
        return {
          ...cur,
          [id]: {
            ...s,
            title: s.participants ? s.title : `Playground · ${s.agentName ?? ''}, ${agentLabel(added)}`,
            participants: [...base, { agentId: added.id, name: agentLabel(added) }]
          }
        }
      })
      // A live conversation's relay connection caches the roster it verified at
      // connect — rebuild the socket so a fresh rc/verify picks up the join.
      if (conversationId) {
        const existing = conns.current.get(id)
        if (existing) {
          existing.closing = true
          if (existing.reconnectTimer) window.clearTimeout(existing.reconnectTimer)
          existing.ws?.close()
          conns.current.delete(id)
        }
        connect(id, primaryId, conversationId).ready.catch(() => {})
      }
      return true
    },
    [activeOrg, pgSessions, connect, pushStep]
  )

  /** Put one turn on the wire NOW. The composer read / busy check / queueing live
   *  in pgSend; the queue dispatcher calls this directly with the captured args. */
  const sendTurn = useCallback(
    (
      id: string,
      agentForId: string,
      text: string,
      image: SessionImage | undefined,
      conversationId?: string,
      knownParticipants?: Array<{ agentId: string; name: string; primary?: boolean }>,
      commandPick?: { agentId: string; name: string }
    ): void => {
      const requestedTurnId = randomUuid()
      pushStep(id, { kind: 'msg', who: '@you', turnId: requestedTurnId, text, ...(image ? { image } : {}) })
      setBusy(id, true)
      // Targeting (webchat-multi-agents.md §4.2): conversation membership is a
      // STANDING mention — an unmentioned message goes to the WHOLE roster
      // (each agent may silently decline); explicit @mentions narrow the turn
      // to the named participants. The relay validates against its verified
      // roster, and also applies the same all-participants default itself, so a
      // resumed conversation with no client-side roster still reaches everyone.
      const session = pgSessions[id]
      // An ADOPTED webchat session has no pgSessions entry — its roster comes
      // from the fetched session detail (knownParticipants). Without it the
      // send degrades to the relay's all-participants default: mentions can't
      // narrow, and no lanes are pre-created (leaving delivery to the
      // early-frame admission path).
      //
      // The staged-ref fallback (resolveRoster) covers the FIRST send of a
      // fresh multi-agent conversation: openPlayground stages the session and
      // HomeView sends in the same tick, so `pgSessions[id]` is still the
      // pre-stage snapshot. Reading only state here silently dropped
      // mentions/targets (and lane pre-creation) from every first message —
      // the standing mention never reached the wire, so the parallel-answer
      // race could still silence an agent on exactly the message most users
      // test with.
      const roster = resolveRoster(session?.participants, knownParticipants, rosterAgentIds.current.get(id), (a) =>
        rosterNames.current.get(id)?.get(a)
      )
      if (!session && knownParticipants && knownParticipants.length > 1 && !rosterNames.current.has(id)) {
        rosterNames.current.set(id, new Map(knownParticipants.map((p) => [p.agentId, p.name])))
      }
      const typed = typedMentionIds(roster, text)
      const commandTarget =
        commandPick &&
        roster.some((p) => p.agentId === commandPick.agentId) &&
        leadingCommandToken(text) === commandPick.name &&
        !typed.includes(commandPick.agentId)
          ? [commandPick.agentId]
          : []
      const mentions = [...typed, ...commandTarget]
      const targets = roster.length > 1 ? (mentions.length ? mentions : roster.map((p) => p.agentId)) : [agentForId]
      // Membership is a standing mention — a bare multi-agent send materializes it as
      // the whole roster in structured `mentions` (see wireMentions), the same wire
      // shape an explicit @-everyone message produces. Delivery is unchanged: targets
      // already covered the roster.
      const sentMentions = wireMentions(roster, mentions)
      pendingTurnIds.current.set(id, requestedTurnId)
      finishedTurnLanes.current.delete(id)
      for (const target of targets) {
        streamCursors.current.set(laneKey(id, target), createWebchatCursor<WebchatOutput, WebchatDone>(requestedTurnId))
      }
      syncBusyLanes(id)
      if (conversationId) conversationIds.current.set(id, conversationId)
      reconnectAttempts.current.delete(id)
      // First send of a fresh conversation mints a real session on the daemon. The SSE
      // start-milestone is the immediate signal, but it can be delayed/buffered in some
      // setups (leaving the getting-started "first conversation" tick to the 60s poll) —
      // so nudge the session lists shortly after the send lands.
      const isNewConversation = !conversationId && !conversationIds.current.get(id)
      const conn = connect(id, agentForId, conversationId)
      conn.ready
        .then((ws) => {
          const frame = JSON.stringify({
            text,
            turnId: requestedTurnId,
            ...(roster.length > 1 ? { mentions: sentMentions, targets } : {}),
            ...(image ? { attachments: [image] } : {}),
            // Runtime staging is a single-agent affordance — multi-agent
            // conversations expose no runtime controls (§9.1/§9.3).
            ...(roster.length <= 1 && stagedRuntime.current.get(id) ? { runtime: stagedRuntime.current.get(id) } : {}),
            ...(roster.length <= 1 && stagedWorktree.current.has(id)
              ? { worktree: stagedWorktree.current.get(id) }
              : {})
          })
          // Kept until the agent acks: a reconnect that finds it unacked re-sends it. Single-agent only — the relay mints the canonical post identity per received frame, so a re-sent multi-agent turn partially admitted the first time would land under a second postId on the rest of the roster (duplicate user messages in the merged transcript).
          if (roster.length <= 1) pendingTurnFrames.current.set(id, { turnId: requestedTurnId, frame })
          else pendingTurnFrames.current.delete(id)
          ws.send(frame)
          if (isNewConversation) setTimeout(refreshSessions, 2500)
        })
        .catch((err) => {
          // A 503 from the token mint means the CP has no relay pool configured — the
          // agent may be perfectly healthy, so name the real cause instead of "unreachable".
          const noRelay = err instanceof ApiError && err.status === 503
          // A 409 from the conversation mint names the exact blocker (an agent's
          // daemon lacking multi-agent webchat support) — surface it verbatim.
          const conflict = err instanceof ApiError && err.status === 409 ? err.message : undefined
          // A 404 on a RESUME is the CP refusing this account the conversation (private to its owner, or a roster member out of view) — not an unreachable agent.
          const notYours = Boolean(conversationId) && err instanceof ApiError && err.status === 404
          pushStep(id, {
            kind: 'done',
            turnId: requestedTurnId,
            text: noRelay
              ? '⚠️ Webchat relay not configured — set PUBLIC_RELAY_URL on the control plane.'
              : conflict
                ? `⚠️ ${conflict}`
                : notYours
                  ? '⚠️ You can’t continue this conversation — it is private to the person who started it, or includes an agent you can’t view.'
                  : '⚠️ Could not reach the agent.'
          })
          pendingTurnFrames.current.delete(id)
          dropLanes(id)
          setBusy(id, false)
        })
    },
    [pgSessions, connect, pushStep, setBusy, refreshSessions]
  )

  const pgSend = useCallback(
    (
      id: string,
      agentForId: string,
      textArg?: string,
      conversationId?: string,
      knownParticipants?: Array<{ agentId: string; name: string; primary?: boolean }>,
      imageArg?: SessionImage,
      commandPick?: { agentId: string; name: string }
    ) => {
      const text = String(textArg ?? pgDrafts.current[id] ?? '').trim()
      const image = imageArg ?? pgImageBy[id]
      if (!text && !image) return false
      setPgInput(id, '')
      setPgImage(id)
      // Queue while a turn streams (Claude Code-style) — and also while older
      // queued messages are still waiting for the dispatcher, so a send landing
      // between a turn's end and the dispatch of the queue head stays FIFO.
      if (busyRef.current[id] || (pgQueueRef.current[id]?.length ?? 0) > 0) {
        const queued: QueuedTurn = {
          queueId: randomUuid(),
          text,
          ...(image ? { image } : {}),
          agentId: agentForId,
          ...(commandPick ? { commandPick } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(knownParticipants ? { participants: knownParticipants } : {})
        }
        pgQueueRef.current[id] = [...(pgQueueRef.current[id] ?? NO_QUEUE), queued]
        setPgQueueBy((cur) => ({ ...cur, [id]: [...(cur[id] ?? NO_QUEUE), queued] }))
        return true
      }
      sendTurn(id, agentForId, text, image, conversationId, knownParticipants, commandPick)
      return true
    },
    [pgImageBy, sendTurn, setPgImage, setPgInput]
  )

  // Dispatch the oldest queued message the moment its session's turn ends. The
  // dispatched-set makes the effect idempotent (StrictMode runs effects twice).
  const dispatchedQueueIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const id of Object.keys(pgQueueBy)) {
      // Head comes from the synchronous mirror, NOT the render-time snapshot:
      // a cancel landing after busy cleared but before this effect ran has
      // already removed it from the mirror, and dispatching the snapshot's
      // head would send a message the user watched disappear.
      const next = pgQueueRef.current[id]?.[0]
      if (!next || busyRef.current[id] || dispatchedQueueIds.current.has(next.queueId)) continue
      dispatchedQueueIds.current.add(next.queueId)
      pgQueueRef.current[id] = (pgQueueRef.current[id] ?? NO_QUEUE).filter((q) => q.queueId !== next.queueId)
      setPgQueueBy((cur) => ({ ...cur, [id]: (cur[id] ?? NO_QUEUE).filter((q) => q.queueId !== next.queueId) }))
      sendTurn(id, next.agentId, next.text, next.image, next.conversationId, next.participants, next.commandPick)
    }
  }, [pgQueueBy, pgBusyBy, sendTurn])

  const getPgQueue = useCallback((id: string) => pgQueueBy[id] ?? NO_QUEUE, [pgQueueBy])
  const pgCancelQueued = useCallback((id: string, queueId: string): void => {
    pgQueueRef.current[id] = (pgQueueRef.current[id] ?? NO_QUEUE).filter((q) => q.queueId !== queueId)
    setPgQueueBy((cur) => {
      const queue = cur[id]
      if (!queue?.some((q) => q.queueId === queueId)) return cur
      return { ...cur, [id]: queue.filter((q) => q.queueId !== queueId) }
    })
  }, [])

  /** Switch the session's model (fire-and-forget over the conversation socket). Updates
   *  the local model optimistically so the dropdown reflects the choice at once; the
   *  daemon confirms via the next status frame. */
  const pgSetModel = useCallback(
    (id: string, agentForId: string, model: string, conversationId?: string) => {
      setPgSessions((cur) => (cur[id] ? { ...cur, [id]: sessionAfterModelSelection(cur[id]!, model) } : cur))
      stageRuntimeChange(id, { model })
      connect(id, agentForId, conversationId)
        .ready.then((ws) => ws.send(JSON.stringify({ type: 'set_model', model })))
        .catch(() => {})
    },
    [connect, stageRuntimeChange]
  )

  /** Switch the session's reasoning effort (fire-and-forget). Optimistically updates the
   *  local effort so the dropdown reflects the choice at once; the daemon confirms via the
   *  next status frame. */
  const pgSetEffort = useCallback(
    (id: string, agentForId: string, effort: string, conversationId?: string) => {
      setPgSessions((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id]!, effort } } : cur))
      stageRuntimeChange(id, { effort })
      connect(id, agentForId, conversationId)
        .ready.then((ws) => ws.send(JSON.stringify({ type: 'set_effort', effort })))
        .catch(() => {})
    },
    [connect, stageRuntimeChange]
  )

  /** Switch the session's composite permission preset (fire-and-forget), optimistic
   * like pgSetEffort. The daemon decomposes Auto before calling ACP. */
  const pgSetPermissionPreset = useCallback(
    (id: string, agentForId: string, permissionPreset: string, conversationId?: string) => {
      setPgSessions((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id]!, permissionMode: permissionPreset } } : cur))
      stageRuntimeChange(id, { permissionMode: permissionPreset })
      connect(id, agentForId, conversationId)
        .ready.then((ws) => ws.send(JSON.stringify({ type: 'set_permission_mode', permissionMode: permissionPreset })))
        .catch(() => {})
    },
    [connect, stageRuntimeChange]
  )

  /** Toggle the session's fast mode (fire-and-forget), optimistic like pgSetEffort. */
  const pgSetFast = useCallback(
    (id: string, agentForId: string, fastMode: boolean, conversationId?: string) => {
      setPgSessions((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id]!, fastMode } } : cur))
      stageRuntimeChange(id, { fastMode })
      connect(id, agentForId, conversationId)
        .ready.then((ws) => ws.send(JSON.stringify({ type: 'set_fast', fastMode })))
        .catch(() => {})
    },
    [connect, stageRuntimeChange]
  )

  /** Answer an in-band elicitation card (fire-and-forget) — `value: null` is Dismiss.
   *  Deliberately NOT optimistic: the daemon owns the card's outcome and settles it with
   *  the `elicitation_resolved` event, so a refused answer leaves the card answerable. */
  const pgAnswerElicitation = useCallback(
    (id: string, agentForId: string, requestId: string, value: string | null, conversationId?: string) => {
      connect(id, agentForId, conversationId)
        .ready.then((ws) =>
          ws.send(JSON.stringify({ type: 'elicitation_choice', requestId, value, agentId: agentForId }))
        )
        .catch(() => {})
    },
    [connect]
  )

  /** Interrupt the running turn (fire-and-forget). The daemon ends the turn with a
   *  relay `done` item, which clears pgBusy via the socket's done handler. */
  const pgCancel = useCallback(
    (id: string, agentForId: string, conversationId?: string) => {
      connect(id, agentForId, conversationId)
        .ready.then((ws) => ws.send(JSON.stringify({ type: 'cancel' })))
        .catch(() => {})
    },
    [connect]
  )

  // Once the daemon creates the real session, the route switches from the synthetic
  // `pg_…` id to that durable id. Keep resolving the same in-memory session so the
  // active socket and streamed transcript survive the route replacement.
  const getPgSession = useCallback(
    (id: string) => pgSessions[id] ?? Object.values(pgSessions).find((session) => session.realSessionId === id),
    [pgSessions]
  )
  const getPgInput = useCallback((id: string) => pgDrafts.current[id] ?? '', [])
  const getPgImage = useCallback((id: string) => pgImageBy[id], [pgImageBy])
  const isPgBusy = useCallback((id: string) => !!pgBusyBy[id], [pgBusyBy])
  const getLiveSteps = useCallback((id: string) => wcSteps[id] ?? NO_STEPS, [wcSteps])
  const reconcileLiveSteps = useCallback(
    (id: string, persisted: SessionMessageDto[], agentId: string, promptRows?: SessionMessageDto[]): void => {
      setWcSteps((cur) => {
        const live = cur[id]
        if (!live) return cur
        const reconciled = reconcilePersistedLiveSteps(live, persisted, agentId, promptRows)
        if (reconciled === live) return cur
        const next = { ...cur }
        if (reconciled.length === 0) delete next[id]
        else next[id] = reconciled
        return next
      })
    },
    []
  )
  const pgSessionList = useMemo(() => Object.values(pgSessions), [pgSessions])

  const markSessionTarget = useCallback((id: string): void => {
    sessionTargets.current.add(id)
  }, [])

  /** See PlaygroundData.pgAttach. Doubles as socket warming: a reused live conn
   *  skips the probe (its ready already passed — nothing was lost in a reload). */
  const pgAttach = useCallback(
    (id: string, agentId: string, conversationId: string): void => {
      if (!conversationId || busyRef.current[id]) return
      connect(id, agentId, conversationId, false, true).ready.catch(() => {})
    },
    [connect]
  )

  const value = useMemo<PlaygroundData>(
    () => ({
      getPgInput,
      setPgInput,
      subscribePgDraft,
      getPgImage,
      setPgImage,
      getPgWorktree,
      pgSetWorktree,
      isPgBusy,
      openPlayground,
      pgAddAgent,
      pgSend,
      pgAttach,
      markSessionTarget,
      getPgQueue,
      pgCancelQueued,
      pgSetModel,
      pgSetEffort,
      pgSetPermissionPreset,
      pgSetFast,
      pgAnswerElicitation,
      pgCancel,
      getPgSession,
      pgSessionList,
      getLiveSteps,
      getBusyLaneAgentIds,
      reconcileLiveSteps
    }),
    [
      getPgInput,
      setPgInput,
      subscribePgDraft,
      getPgImage,
      setPgImage,
      getPgWorktree,
      pgSetWorktree,
      isPgBusy,
      openPlayground,
      pgAddAgent,
      pgSend,
      pgAttach,
      markSessionTarget,
      getPgQueue,
      pgCancelQueued,
      pgSetModel,
      pgSetEffort,
      pgSetPermissionPreset,
      pgSetFast,
      pgAnswerElicitation,
      pgCancel,
      getPgSession,
      pgSessionList,
      getLiveSteps,
      getBusyLaneAgentIds,
      reconcileLiveSteps
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlayground(): PlaygroundData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayground must be used within <PlaygroundProvider>')
  return ctx
}

/** Reactive view of one session's composer draft. Only the calling component
 *  re-renders on keystrokes — the provider context itself stays untouched. */
export function usePgDraft(id: string): string {
  const { getPgInput, subscribePgDraft } = usePlayground()
  return useSyncExternalStore(
    subscribePgDraft,
    () => getPgInput(id),
    () => ''
  )
}

/** Reactive empty/non-empty flag for one session's draft — for send-button
 *  enablement in big views: it only re-renders them when the flag flips. */
export function usePgDraftHasText(id: string): boolean {
  const { getPgInput, subscribePgDraft } = usePlayground()
  return useSyncExternalStore(
    subscribePgDraft,
    () => getPgInput(id).trim().length > 0,
    () => false
  )
}
