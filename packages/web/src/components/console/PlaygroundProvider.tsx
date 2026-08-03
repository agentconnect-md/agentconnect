'use client'

// Ephemeral playground sessions live here (not persisted by the Control Plane).
// Lifting this state above the routes — into a provider mounted by the console
// shell — keeps a live sandbox conversation alive while you navigate between
// routes. Each playground session mints a short-lived token through the CP, then
// owns ONE webchat WebSocket to the relay. The agent's reply streams back as
// structured events which we fold into the session's `steps` for the transcript
// view.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  agentLabel,
  selectedPermissionPreset,
  type Agent,
  type Session,
  type SessionImage,
  type SessionStep
} from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import {
  webchatWsUrl,
  addWebchatConversationAgent,
  fmtCountCompact,
  fmtCost,
  ApiError,
  type SessionMessageDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { wireMentions } from '@/lib/conversation-addressing'
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

interface PlaygroundData {
  /** Composer buffer for one session id (each live conversation has its own). */
  getPgInput: (id: string) => string
  setPgInput: (id: string, v: string) => void
  /** One prepared image waiting in this session's composer. */
  getPgImage: (id: string) => SessionImage | undefined
  setPgImage: (id: string, image?: SessionImage) => void
  /** Is a turn in flight for this session id? Drives its typing indicator + send-disable. */
  isPgBusy: (id: string) => boolean
  /** Create a new sandbox session and return its id. Does not navigate. `members`
   *  adds more participants — the conversation's roster is fixed at creation
   *  (webchat-multi-agents.md §3.1); the first agent is the primary. */
  openPlayground: (agent: Agent, members?: Agent[]) => string
  /** Add a participant to a LIVE conversation (mid-conversation join,
   *  webchat-multi-agents.md §3.1). Registers the agent with the CP, then
   *  rebuilds the socket so the relay re-verifies and caches the grown roster.
   *  Failures surface as a ⚠️ transcript step. Refused while a turn streams. */
  pgAddAgent: (id: string, agent: Agent) => Promise<void>
  pgSend: (
    id: string,
    agentId: string,
    text?: string,
    conversationId?: string,
    participants?: Array<{ agentId: string; name: string; primary?: boolean }>
  ) => void
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
  getPgSession: (id: string) => Session | undefined
  pgSessionList: Session[]
  /** Live tail (this-visit) steps for an ADOPTED webchat session, keyed by its CP session
   *  id — the turns you send after opening a persisted session from the list, appended
   *  below its fetched history. Empty until you send. Synthetic 'pg_' sessions don't use
   *  this (their whole transcript lives in the session's own `steps`). */
  getLiveSteps: (id: string) => SessionStep[]
  /** Retire only optimistic turns confirmed by authoritative transcript rows. */
  reconcileLiveSteps: (id: string, persisted: SessionMessageDto[], agentId: string) => void
}

// Synthetic playground session ids start with `pg_`; real CP session ids do not.
// The prefix lets the provider tell the two apart without extra bookkeeping.
const PG_PREFIX = 'pg_'
const NO_STEPS: SessionStep[] = []
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
  const entropy =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${PG_PREFIX}${agentId}_${entropy}`
}

function stampStep(step: SessionStep, observedAtMs = Date.now()): SessionStep {
  return {
    ...step,
    time: step.time ?? liveStepTime(),
    observedAtMs: step.observedAtMs ?? observedAtMs
  }
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
  | { kind: 'tool_update'; toolCallId: string; status: string }
  | { kind: 'session_info'; title: string }
  | { kind: 'superseded'; generation: number }

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
  const [pgInputBy, setPgInputBy] = useState<Record<string, string>>({})
  const [pgImageBy, setPgImageBy] = useState<Record<string, SessionImage>>({})
  const [pgBusyBy, setPgBusyBy] = useState<Record<string, boolean>>({})
  const conns = useRef<Map<string, Conn>>(new Map())
  const conversationIds = useRef<Map<string, string>>(new Map())
  // Creation-time roster per session id (primary first) — drives the
  // conversation-scoped token mint for a multi-agent create.
  const rosterAgentIds = useRef<Map<string, string[]>>(new Map())
  // The in-flight send's requested turnId — lets an accepted ack from a
  // participant the client did NOT explicitly lane (a resumed conversation
  // where the relay applied the all-participants default) create its stream
  // lane lazily instead of dropping the reply.
  const pendingTurnIds = useRef<Map<string, string>>(new Map())
  // Lanes that already COMPLETED for the in-flight turn (done applied, cursor
  // removed), per session id. With done-before-ack ordering the trailing ack
  // must not re-admit an empty cursor for a finished participant — it would
  // never receive another terminal frame and wedge the busy state. Reset on
  // each send (one in-flight turn per session).
  const finishedTurnLanes = useRef<Map<string, { turnId: string; agents: Set<string> }>>(new Map())
  // Participant display names per session id, mirrored in a ref: the socket's
  // message handlers are closures captured when the socket opened — often the
  // same tick openPlayground staged the session — so state-based lookups there
  // would read a stale snapshot and stamp every step without a name.
  const rosterNames = useRef<Map<string, Map<string, string>>>(new Map())
  // One ordering cursor per stream LANE — a multi-agent turn runs one lane per
  // targeted participant (webchat-multi-agents.md §5.3); keys from lib/webchat-lanes.ts.
  const streamCursors = useRef<Map<string, OrderedWebchatCursor<WebchatOutput, WebchatDone>>>(new Map())
  const reconnectAttempts = useRef<Map<string, number>>(new Map())
  // Standalone set_* operations cannot bind until the first daemon session exists.
  // Keep only fields the user actually touched and attach them atomically to the turn.
  const stagedRuntime = useRef<Map<string, WebchatRuntimeConfig>>(new Map())
  const busyRef = useRef<Record<string, boolean>>({})
  const closingAll = useRef(false)
  const { activeOrg } = useOrgs()

  const stageRuntimeChange = useCallback((id: string, patch: WebchatRuntimeConfig): void => {
    if (!id.startsWith(PG_PREFIX)) return
    stagedRuntime.current.set(id, { ...stagedRuntime.current.get(id), ...patch })
  }, [])

  const setBusy = useCallback((id: string, v: boolean): void => {
    if (v) busyRef.current[id] = true
    else delete busyRef.current[id]
    setPgBusyBy((cur) => (!!cur[id] === v ? cur : { ...cur, [id]: v }))
  }, [])
  const setPgInput = useCallback((id: string, v: string): void => {
    setPgInputBy((cur) => ({ ...cur, [id]: v }))
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
    (id: string, step: SessionStep): void => mutateSteps(id, (steps) => [...steps, stampStep(step)]),
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
    (id: string, ev: WebchatEvent, agentId?: string): void => {
      const observedAtMs = Date.now()
      const who = participantName(id, agentId)
      const lane = (extra: Omit<SessionStep, 'text'> & { text: string }): SessionStep =>
        stampStep({ ...extra, ...(agentId ? { agentId } : {}), ...(who ? { who } : {}) }, observedAtMs)
      mutateSteps(id, (steps) => {
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
            if (step.boundary) break
            if (step.kind === 'done') collapsed[i] = { ...step, kind: 'plan' }
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
          return [...steps, lane({ kind: 'tool', text: ev.title || 'tool call' })]
        }
        if (ev.kind === 'tool_update' && last?.kind === 'tool') {
          return replaceAt(laneIndex, { ...last, observedAtMs })
        }
        return steps // tool_update: status-only, nothing to render for now
      })
    },
    [mutateSteps, participantName]
  )

  /** Fold a status snapshot (model / context / tokens / cost) into the session's headline
   *  fields + `usage` — this is the live status bar, NOT a transcript step. Only defined
   *  fields overwrite, so a partial snapshot (context-only mid-turn) never clears the
   *  model or the last token total. Playground sessions only (adopted webchat rows carry
   *  their own persisted headline). */
  const applyStatus = useCallback((id: string, st: WebchatStatus, agentId?: string): void => {
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
  const dropLanes = (id: string): void => {
    for (const key of lanesOf(id)) streamCursors.current.delete(key)
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
          if (event.kind === 'session_info') applyTitle(id, event.title, agentId)
          else applyEvent(id, event, agentId)
        }
      }
      if (!result.done) return
      reconnectAttempts.current.delete(id)
      streamCursors.current.delete(cursorKey)
      if (agentId && result.done.turnId) {
        const rec = finishedTurnLanes.current.get(id)
        if (rec && rec.turnId === result.done.turnId) rec.agents.add(agentId)
        else finishedTurnLanes.current.set(id, { turnId: result.done.turnId, agents: new Set([agentId]) })
      }
      if (result.done.error) {
        const name = participantName(id, agentId)
        pushStep(id, {
          kind: 'done',
          ...(agentId ? { agentId } : {}),
          ...(name ? { who: name } : {}),
          text: `⚠️ ${result.done.error}`
        })
      }
      // The turn stays busy until every targeted participant's lane finished.
      if (lanesOf(id).length === 0) setBusy(id, false)
    },
    [applyEvent, applyStatus, applyTitle, failStream, participantName, pushStep, setBusy]
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
    (id: string, agentId: string, conversationId?: string, resumeStream = false): Conn => {
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

      const sendResume = (ws: WebSocket): void => {
        // One resume per live lane — a multi-agent turn streams from several
        // participants, each with its own daemon-side replay window.
        for (const key of lanesOf(id)) {
          const cursor = streamCursors.current.get(key)
          const turnId = cursor?.turnId ?? cursor?.requestedTurnId
          if (!cursor || !turnId || ws.readyState !== WebSocket.OPEN) continue
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
        void webchatWsUrl(orgId, agentId, resumeId, rosterAgentIds.current.get(id))
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
            ws.onmessage = (e) => {
              let m: {
                type?: string
                conversationId?: string
                participants?: WebchatParticipant[]
                output?: WebchatOutput
                done?: WebchatDone
                ack?: { accepted?: boolean; reason?: string; turnId?: string; agentId?: string }
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
                }
              } else if (m.type === 'output') {
                if (m.output) receiveOutput(id, m.output)
              } else if (m.type === 'done') {
                if (m.done) receiveDone(id, m.done)
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
                }
                const cursor = key ? streamCursors.current.get(key) : undefined
                if (cursor && m.ack?.turnId) bindWebchatTurn(cursor, m.ack.turnId)
              } else if (m.type === 'resumed' && m.ack?.accepted !== false) {
                const key = cursorKeyFor(id, m.ack?.agentId)
                const cursor = key ? streamCursors.current.get(key) : undefined
                if (cursor && m.ack?.turnId) bindWebchatTurn(cursor, m.ack.turnId)
                reconnectAttempts.current.delete(id)
              } else if (m.type === 'resumed' && m.ack?.accepted === false) {
                const key = cursorKeyFor(id, m.ack?.agentId)
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
              } else if (m.type === 'ack' && m.ack?.accepted === false) {
                // A per-participant rejection: fail only that lane — the other
                // targets of a multi-agent turn keep streaming.
                const key = cursorKeyFor(id, m.ack.agentId)
                if (key) streamCursors.current.delete(key)
                const agentId = m.ack.agentId
                const name = participantName(id, agentId)
                pushStep(id, {
                  kind: 'done',
                  ...(agentId ? { agentId } : {}),
                  ...(name ? { who: name } : {}),
                  text:
                    m.ack.reason === 'paused'
                      ? `⚠️ ${name ?? 'Agent'} is paused — it is not processing messages.`
                      : m.ack.reason === 'busy'
                        ? `⚠️ ${name ?? 'Agent'} is busy — try again shortly.`
                        : m.ack.reason === 'not_participant'
                          ? `⚠️ ${name ?? 'That agent'} is not in this conversation.`
                          : `⚠️ ${name ?? 'Agent'} unavailable (no live daemon).`
                })
                if (lanesOf(id).length === 0) {
                  reconnectAttempts.current.delete(id)
                  setBusy(id, false)
                }
              } else if (m.type === 'error') {
                failStream(id, 'Connection error.')
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
    [activeOrg, failStream, receiveDone, receiveOutput, pushStep, setBusy]
  )

  const openPlayground = useCallback(
    (da: Agent, members?: Agent[]): string => {
      const id = newPlaygroundSessionId(da.id)
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
            permissionMode: selectedPermissionPreset(da.runtime, da.permissionMode, da.approvalsReviewer ?? 'user'),
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
    async (id: string, added: Agent): Promise<void> => {
      const orgId = activeOrg?.id
      const session = pgSessions[id]
      const primaryId = session?.agentId
      if (!orgId || !primaryId) return
      if (primaryId === added.id || session.participants?.some((p) => p.agentId === added.id)) return
      if (busyRef.current[id]) {
        pushStep(id, { kind: 'done', text: '⚠️ Wait for the current reply to finish before adding an agent.' })
        return
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
          return
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
    },
    [activeOrg, pgSessions, connect, pushStep]
  )

  const pgSend = useCallback(
    (
      id: string,
      agentForId: string,
      textArg?: string,
      conversationId?: string,
      knownParticipants?: Array<{ agentId: string; name: string; primary?: boolean }>
    ) => {
      const text = String(textArg ?? pgInputBy[id] ?? '').trim()
      const image = pgImageBy[id]
      if ((!text && !image) || pgBusyBy[id]) return
      pushStep(id, { kind: 'msg', who: '@you', text, ...(image ? { image } : {}) })
      setPgInput(id, '')
      setPgImage(id)
      setBusy(id, true)
      const requestedTurnId = crypto.randomUUID()
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
      const roster = session?.participants ?? knownParticipants ?? []
      if (!session && knownParticipants && knownParticipants.length > 1 && !rosterNames.current.has(id)) {
        rosterNames.current.set(id, new Map(knownParticipants.map((p) => [p.agentId, p.name])))
      }
      const mentions =
        roster.length > 1
          ? roster
              .filter(
                (p) => p.name && new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
              )
              .map((p) => p.agentId)
          : []
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
          ws.send(
            JSON.stringify({
              text,
              turnId: requestedTurnId,
              ...(roster.length > 1 ? { mentions: sentMentions, targets } : {}),
              ...(image ? { attachments: [image] } : {}),
              // Runtime staging is a single-agent affordance — multi-agent
              // conversations expose no runtime controls (§9.1/§9.3).
              ...(roster.length <= 1 && stagedRuntime.current.get(id) ? { runtime: stagedRuntime.current.get(id) } : {})
            })
          )
          if (isNewConversation) setTimeout(refreshSessions, 2500)
        })
        .catch((err) => {
          // A 503 from the token mint means the CP has no relay pool configured — the
          // agent may be perfectly healthy, so name the real cause instead of "unreachable".
          const noRelay = err instanceof ApiError && err.status === 503
          // A 409 from the conversation mint names the exact blocker (an agent's
          // daemon lacking multi-agent webchat support) — surface it verbatim.
          const conflict = err instanceof ApiError && err.status === 409 ? err.message : undefined
          pushStep(id, {
            kind: 'done',
            text: noRelay
              ? '⚠️ Webchat relay not configured — set PUBLIC_RELAY_URL on the control plane.'
              : conflict
                ? `⚠️ ${conflict}`
                : '⚠️ Could not reach the agent.'
          })
          dropLanes(id)
          setBusy(id, false)
        })
    },
    [pgBusyBy, pgImageBy, pgInputBy, pgSessions, connect, pushStep, setPgImage, setPgInput, setBusy, refreshSessions]
  )

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
  const getPgInput = useCallback((id: string) => pgInputBy[id] ?? '', [pgInputBy])
  const getPgImage = useCallback((id: string) => pgImageBy[id], [pgImageBy])
  const isPgBusy = useCallback((id: string) => !!pgBusyBy[id], [pgBusyBy])
  const getLiveSteps = useCallback((id: string) => wcSteps[id] ?? NO_STEPS, [wcSteps])
  const reconcileLiveSteps = useCallback((id: string, persisted: SessionMessageDto[], agentId: string): void => {
    setWcSteps((cur) => {
      const live = cur[id]
      if (!live) return cur
      const reconciled = reconcilePersistedLiveSteps(live, persisted, agentId)
      if (reconciled === live) return cur
      const next = { ...cur }
      if (reconciled.length === 0) delete next[id]
      else next[id] = reconciled
      return next
    })
  }, [])
  const pgSessionList = useMemo(() => Object.values(pgSessions), [pgSessions])

  const value = useMemo<PlaygroundData>(
    () => ({
      getPgInput,
      setPgInput,
      getPgImage,
      setPgImage,
      isPgBusy,
      openPlayground,
      pgAddAgent,
      pgSend,
      pgSetModel,
      pgSetEffort,
      pgSetPermissionPreset,
      pgSetFast,
      pgCancel,
      getPgSession,
      pgSessionList,
      getLiveSteps,
      reconcileLiveSteps
    }),
    [
      getPgInput,
      setPgInput,
      getPgImage,
      setPgImage,
      isPgBusy,
      openPlayground,
      pgAddAgent,
      pgSend,
      pgSetModel,
      pgSetEffort,
      pgSetPermissionPreset,
      pgSetFast,
      pgCancel,
      getPgSession,
      pgSessionList,
      getLiveSteps,
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
