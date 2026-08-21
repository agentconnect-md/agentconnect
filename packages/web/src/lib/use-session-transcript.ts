'use client'

// The webchat transcript's fetch machine, lifted out of SessionDetailView: the initial history
// pull (single-session backward-walk + merged-conversation fan-out), the live-tail refresh, and
// cross-source "load earlier" paging. It owns the transcript state (`msgs`, loading/paging/error,
// tail readiness) and the conversation-mode row bookkeeping; the view decides WHEN to refresh the
// tail and renders the result. Pure move-out of the previously-inlined logic — no behaviour change.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { platformTranscriptOrdering } from '@/components/console/platforms/registry'
import { ApiError, fetchSessionMessages, type SessionMessageDto } from '@/lib/api'
import { mergeConversation, type MergeSource } from '@/lib/conversation-merge'
import { mergeSessionMessages } from '@/lib/session-transcript'

/** A 502/503/504 from one member's daemon is an offline source (partial-merge notice), not a
 *  page-level failure. */
function countsAsOfflineSource(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 502 || error.status === 503 || error.status === 504)
}

/** Render input for conversation mode: mergeConversation over the CURRENT per-member row map
 *  (merged-conversation-view.md §6). Preserve each row's object identity while indexing its source
 *  out-of-band: ToolBodyDetail uses exact-row identity to fence a previously fetched full body. */
function mergeConversationRows(
  sources: { sessionId: string; agentId: string; platform: string }[],
  rows: Map<string, SessionMessageDto[]>,
  sourceSessionByMessage: WeakMap<SessionMessageDto, string>,
  sourceTurnByMessage: WeakMap<SessionMessageDto, string>,
  sourcePlatformByMessage: WeakMap<SessionMessageDto, string>,
  sourceAgentByMessage: WeakMap<SessionMessageDto, string>
): SessionMessageDto[] {
  return mergeConversation(
    sources
      .filter((source) => rows.has(source.sessionId))
      .map((source) => ({ ...source, rows: rows.get(source.sessionId)! }) satisfies MergeSource)
  ).map(({ row, sourceSessionId, sourceAgentId, sourcePlatform, sourceTurnKey }) => {
    sourceSessionByMessage.set(row, sourceSessionId)
    sourceAgentByMessage.set(row, sourceAgentId)
    sourcePlatformByMessage.set(row, sourcePlatform)
    if (sourceTurnKey) sourceTurnByMessage.set(row, sourceTurnKey)
    return row
  })
}

/** One conversation member as this machine needs it — a structural subset of the wire `SessionDto`. */
interface TranscriptMember {
  sessionId: string
  agentId?: string | null
}

export interface UseSessionTranscriptInput {
  sid: string | undefined
  aid: string | undefined
  wantTranscript: boolean
  /** The open session's platform (`session?.platform ?? ''`) — the single-session tail's ordering key. */
  sessionPlatform: string
  conversationKey: string | null
  /** Keys the conversation fan-out on the member SET; a roster refresh with identical members must
   *  not refetch every transcript. */
  conversationSourceKey: string
  /** Current visible member sessions (conversation mode), representative-first; null single-session. */
  conversationMembers: readonly TranscriptMember[] | null
  /** The roster's platform, stamped on every member source (defaults to 'slack'). */
  conversationRosterPlatform: string | undefined
  /** Live busy flag by ref — reconcile is skipped while the owning session is mid-turn. */
  sessionBusyRef: RefObject<boolean>
  reconcileLiveSteps: (
    id: string,
    persisted: SessionMessageDto[],
    agentId: string,
    promptRows?: SessionMessageDto[]
  ) => void
}

export interface UseSessionTranscriptResult {
  msgs: SessionMessageDto[] | null
  msgLoading: boolean
  msgPaging: boolean
  msgErr: string | null
  tailReady: boolean
  transcriptSessionId: string | null
  conversationOffline: number
  conversationHasEarlier: boolean
  conversationPagingEarlier: boolean
  conversationLoadedKey: string | null
  loadEarlier: () => Promise<void>
  refreshTail: () => Promise<void>
  /** Conversation-mode per-member state, read during render (merge + per-row source resolution). */
  conversationSourcesRef: RefObject<{
    rows: Map<string, SessionMessageDto[]>
    cursors: Map<string, string | null>
    older: Map<string, string | null>
  }>
  conversationSourceSessionByMessageRef: RefObject<WeakMap<SessionMessageDto, string>>
  conversationSourceTurnByMessageRef: RefObject<WeakMap<SessionMessageDto, string>>
  conversationSourcePlatformByMessageRef: RefObject<WeakMap<SessionMessageDto, string>>
  conversationSourceAgentByMessageRef: RefObject<WeakMap<SessionMessageDto, string>>
}

export function useSessionTranscript(input: UseSessionTranscriptInput): UseSessionTranscriptResult {
  const {
    sid,
    aid,
    wantTranscript,
    sessionPlatform,
    conversationKey,
    conversationSourceKey,
    conversationMembers,
    conversationRosterPlatform,
    sessionBusyRef,
    reconcileLiveSteps
  } = input

  const [msgs, setMsgs] = useState<SessionMessageDto[] | null>(null)
  // Conversation mode: per-member fetched rows + live cursors; the rendered transcript is always
  // mergeConversation() over the CURRENT map, so every update path (initial load, tail pages) stays
  // consistent by construction.
  const conversationSourcesRef = useRef<{
    rows: Map<string, SessionMessageDto[]>
    cursors: Map<string, string | null>
    older: Map<string, string | null>
  }>({ rows: new Map(), cursors: new Map(), older: new Map() })
  const conversationSourceSessionByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  const conversationSourceTurnByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  // Each merged row's OWN platform (§10) — the key its text renderer resolves under. Out-of-band so
  // the row objects keep their identity, and per row because sources interleave by event time.
  const conversationSourcePlatformByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  // Owning member agent of a merged-conversation row — a background-task wake from a peer member
  // must render as THAT agent's work, not the representative's.
  const conversationSourceAgentByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  const [conversationHasEarlier, setConversationHasEarlier] = useState(false)
  const [conversationPagingEarlier, setConversationPagingEarlier] = useState(false)
  // Which conversation key the CURRENT fan-out state belongs to — the focus effect's readiness
  // signal. Null while a (new) key is loading, so a key-to-key navigation in the persistent layout
  // can never act on the previous conversation's leftover msgs/cursors.
  const [conversationLoadedKey, setConversationLoadedKey] = useState<string | null>(null)
  const conversationMembersRef = useRef<{ sessionId: string; agentId: string; platform: string }[] | null>(null)
  // Merge sources in CANONICAL order — sessionId sort, decoupled from the resolver's
  // representative-first response, whose activity-based order is mutable: a 30s roster refresh must
  // never swap which recipient copy wins the first-source rule in mergeConversation().
  conversationMembersRef.current = conversationMembers
    ? [...conversationMembers]
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
        .map((m) => ({
          sessionId: m.sessionId,
          agentId: m.agentId ?? '',
          platform: conversationRosterPlatform ?? 'slack'
        }))
    : null
  const [conversationOffline, setConversationOffline] = useState(0)
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgPaging, setMsgPaging] = useState(false)
  const [msgErr, setMsgErr] = useState<string | null>(null)
  const [tailReady, setTailReady] = useState(false)
  const [transcriptSessionId, setTranscriptSessionId] = useState<string | null>(null)
  const liveCursorRef = useRef<string | null>(null)
  const tailSessionRef = useRef<string | null>(null)
  const tailReadyRef = useRef(false)
  const tailInFlightRef = useRef<Promise<void> | null>(null)
  const tailDirtyRef = useRef(false)

  useEffect(() => {
    if (!wantTranscript || !sid || !aid) return
    let active = true
    setTranscriptSessionId(sid)
    tailSessionRef.current = sid
    tailReadyRef.current = false
    liveCursorRef.current = null
    tailInFlightRef.current = null
    tailDirtyRef.current = false
    setTailReady(false)
    setMsgLoading(true)
    setMsgErr(null)
    setMsgs(null)
    setMsgPaging(false)
    // Pull the WHOLE history, not just the newest frame-budgeted page: render the first (newest)
    // page immediately, then keep paging strictly older via nextCursor, prepending each page.
    // Bounded so a pathological session can't keep the proxy busy forever.
    const MAX_PAGES = 40
    if (conversationKey) {
      // Merged conversation (merged-conversation-view.md §4/§6): pull every member's history through
      // the SAME bounded per-session reads, then render mergeConversation() over the union. A member
      // whose read fails (daemon offline) degrades to a partial merge with a notice — never a
      // page-level failure; authorization-hidden members never reached the roster in the first place.
      const sources = conversationMembersRef.current ?? []
      if (sources.length === 0) return
      setConversationLoadedKey(null)
      const rowsBySession = new Map<string, SessionMessageDto[]>()
      const cursors = new Map<string, string | null>()
      const older = new Map<string, string | null>()
      let failed = 0
      ;(async () => {
        await Promise.all(
          sources.map(async (src) => {
            try {
              // Newest window only — one page per member (C3 §5.2). Older history loads on demand via
              // the per-source cursors below, capping a cold open at N requests instead of N × MAX_PAGES.
              const page = await fetchSessionMessages(src.sessionId, {})
              if (!active) return
              cursors.set(src.sessionId, page.liveCursor ?? null)
              older.set(src.sessionId, page.nextCursor ?? null)
              rowsBySession.set(src.sessionId, page.messages)
            } catch (error) {
              if (countsAsOfflineSource(error)) failed += 1
            }
          })
        )
        if (!active) return
        conversationSourcesRef.current = { rows: rowsBySession, cursors, older }
        setConversationHasEarlier([...older.values()].some((cursor) => cursor !== null))
        setConversationLoadedKey(conversationKey)
        setConversationOffline(failed)
        // Exact post matching uses every participant row; fuzzy prompt matching stays representative-only.
        const merged = mergeConversationRows(
          sources,
          rowsBySession,
          conversationSourceSessionByMessageRef.current,
          conversationSourceTurnByMessageRef.current,
          conversationSourcePlatformByMessageRef.current,
          conversationSourceAgentByMessageRef.current
        )
        setMsgs(merged)
        setMsgLoading(false)
        setMsgPaging(false)
        liveCursorRef.current = cursors.get(sid) ?? null
        tailReadyRef.current = true
        setTailReady(true)
        if (merged.length > 0 && !sessionBusyRef.current)
          reconcileLiveSteps(sid, merged, aid, rowsBySession.get(sid) ?? [])
      })().catch((e) => {
        if (!active) return
        setMsgErr(e instanceof Error ? e.message : String(e))
        setMsgLoading(false)
        setMsgPaging(false)
      })
      return () => {
        active = false
        if (tailSessionRef.current === sid) {
          tailSessionRef.current = null
          tailReadyRef.current = false
        }
      }
    }
    ;(async () => {
      let all: SessionMessageDto[] = []
      let cursor: string | undefined
      let liveCursor: string | null = null
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchSessionMessages(sid, { ...(cursor ? { cursor } : {}) })
        if (!active) return
        if (i === 0) liveCursor = page.liveCursor ?? null
        all = [...page.messages, ...all]
        setMsgs(all)
        setMsgLoading(false)
        if (!page.nextCursor) {
          setMsgPaging(false)
          liveCursorRef.current = liveCursor
          tailReadyRef.current = true
          setTailReady(true)
          if (!sessionBusyRef.current) reconcileLiveSteps(sid, all, aid)
          return
        }
        cursor = page.nextCursor
        setMsgPaging(true)
      }
      setMsgPaging(false)
      liveCursorRef.current = liveCursor
      tailReadyRef.current = true
      setTailReady(true)
      if (!sessionBusyRef.current) reconcileLiveSteps(sid, all, aid)
    })().catch((e) => {
      if (!active) return
      setMsgErr(e instanceof Error ? e.message : String(e))
      setMsgLoading(false)
      setMsgPaging(false)
    })
    return () => {
      active = false
      if (tailSessionRef.current === sid) {
        tailSessionRef.current = null
        tailReadyRef.current = false
      }
    }
    // conversationSourceKey keys the fan-out on the member SET — a roster refresh with identical
    // members must not refetch every transcript.
  }, [wantTranscript, sid, aid, reconcileLiveSteps, conversationKey, conversationSourceKey])

  const refreshTail = useCallback((): Promise<void> => {
    if (!wantTranscript || !sid || !tailReadyRef.current || sessionBusyRef.current) return Promise.resolve()
    if (tailInFlightRef.current) {
      tailDirtyRef.current = true
      return tailInFlightRef.current
    }
    const platform = sessionPlatform
    if (conversationKey) {
      const sources = conversationMembersRef.current ?? []
      const run = (async () => {
        const state = conversationSourcesRef.current
        // Per-source isolation, mirroring the initial fan-out: one member's daemon going offline
        // mid-conversation must degrade THAT source to the partial-merge notice, never stall the
        // whole tail round.
        let failed = 0
        let fetchedAny = false
        for (const src of sources) {
          try {
            let cursor = state.cursors.get(src.sessionId) ?? null
            for (let pageNo = 0; pageNo < 20; pageNo++) {
              const page = await fetchSessionMessages(src.sessionId, {
                ...(cursor !== null ? { after: cursor } : {}),
                limit: 200
              })
              if (tailSessionRef.current !== sid) return
              const current = state.rows.get(src.sessionId) ?? []
              state.rows.set(
                src.sessionId,
                mergeSessionMessages(current, page.messages, platformTranscriptOrdering(src.platform))
              )
              if (page.messages.length > 0) fetchedAny = true
              if (page.liveCursor !== null) {
                cursor = page.liveCursor
                state.cursors.set(src.sessionId, cursor)
              }
              if (!page.liveMore || page.liveCursor === null) break
            }
          } catch (error) {
            if (countsAsOfflineSource(error)) failed += 1
          }
        }
        if (tailSessionRef.current !== sid) return
        setConversationOffline(failed)
        // Exact post matching uses every participant row; fuzzy prompt matching stays representative-only.
        const merged = mergeConversationRows(
          sources,
          state.rows,
          conversationSourceSessionByMessageRef.current,
          conversationSourceTurnByMessageRef.current,
          conversationSourcePlatformByMessageRef.current,
          conversationSourceAgentByMessageRef.current
        )
        setMsgs(merged)
        if (tailSessionRef.current === sid && !sessionBusyRef.current && fetchedAny)
          reconcileLiveSteps(sid, merged, aid ?? '', state.rows.get(sid) ?? [])
      })()
        .catch(() => {
          // Keep the last good transcript; the next signal retries.
        })
        .finally(() => {
          if (tailInFlightRef.current !== run) return
          tailInFlightRef.current = null
          const retry = tailDirtyRef.current && tailSessionRef.current === sid
          tailDirtyRef.current = false
          if (retry) void refreshTail()
        })
      tailInFlightRef.current = run
      return run
    }
    const run = (async () => {
      let cursor = liveCursorRef.current
      const persisted: SessionMessageDto[] = []
      for (let pageNo = 0; pageNo < 20; pageNo++) {
        const page = await fetchSessionMessages(sid, {
          ...(cursor !== null ? { after: cursor } : {}),
          limit: 200
        })
        if (tailSessionRef.current !== sid) return
        persisted.push(...page.messages)
        setMsgs((current) => mergeSessionMessages(current ?? [], page.messages, platformTranscriptOrdering(platform)))
        if (page.liveCursor !== null) {
          cursor = page.liveCursor
          liveCursorRef.current = cursor
        }
        if (!page.liveMore || page.liveCursor === null) break
      }
      if (tailSessionRef.current === sid && !sessionBusyRef.current) reconcileLiveSteps(sid, persisted, aid ?? '')
    })()
      .catch(() => {
        // Keep the last good transcript. The next SSE signal or reconnect retries without replacing
        // visible history with an error.
      })
      .finally(() => {
        if (tailInFlightRef.current !== run) return
        tailInFlightRef.current = null
        const retry = tailDirtyRef.current && tailSessionRef.current === sid
        tailDirtyRef.current = false
        if (retry) void refreshTail()
      })
    tailInFlightRef.current = run
    return run
  }, [wantTranscript, sid, aid, sessionPlatform, reconcileLiveSteps, conversationKey])

  // C3 §5.2 cross-source "load earlier": one strictly-older page per member that still has history,
  // prepended per source, then re-merged.
  const loadEarlier = useCallback(async (): Promise<void> => {
    if (!conversationKey || conversationPagingEarlier) return
    const sources = conversationMembersRef.current ?? []
    const state = conversationSourcesRef.current
    setConversationPagingEarlier(true)
    try {
      await Promise.all(
        sources.map(async (src) => {
          const cursor = state.older.get(src.sessionId)
          if (!cursor) return
          try {
            const page = await fetchSessionMessages(src.sessionId, { cursor })
            state.rows.set(src.sessionId, [...page.messages, ...(state.rows.get(src.sessionId) ?? [])])
            state.older.set(src.sessionId, page.nextCursor ?? null)
          } catch {
            // Keep this source's window; the button stays for a retry.
          }
        })
      )
      setMsgs(
        mergeConversationRows(
          sources,
          state.rows,
          conversationSourceSessionByMessageRef.current,
          conversationSourceTurnByMessageRef.current,
          conversationSourcePlatformByMessageRef.current,
          conversationSourceAgentByMessageRef.current
        )
      )
      setConversationHasEarlier([...state.older.values()].some((cursor) => cursor !== null))
    } finally {
      setConversationPagingEarlier(false)
    }
  }, [conversationKey, conversationPagingEarlier])

  return {
    msgs,
    msgLoading,
    msgPaging,
    msgErr,
    tailReady,
    transcriptSessionId,
    conversationOffline,
    conversationHasEarlier,
    conversationPagingEarlier,
    conversationLoadedKey,
    loadEarlier,
    refreshTail,
    conversationSourcesRef,
    conversationSourceSessionByMessageRef,
    conversationSourceTurnByMessageRef,
    conversationSourcePlatformByMessageRef,
    conversationSourceAgentByMessageRef
  }
}
