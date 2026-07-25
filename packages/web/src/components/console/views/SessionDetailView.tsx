'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  agentLabel,
  displayedEffort,
  effortLabel,
  fileColor,
  isSelfSender,
  lane,
  modelCapability,
  modelLabel,
  permissionModeDefault,
  permissionModeLabel,
  pgPrompts,
  platName,
  preferredModelFor,
  runtimeLabel,
  sessionPlatform,
  speaker,
  status,
  type SessionImage,
  type SessionStep
} from '@/lib/data'
import {
  fetchSessionMessages,
  fetchSessionDetail,
  fetchToolBody,
  fmtCountCompact,
  memberDisplayName,
  sessionFromDetailDto,
  type SessionDetailDto,
  type SessionMessageDto,
  type SessionRelationDto,
  type ToolBody
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { AgentIconView, AgentMark, LoadingState, PlatformMark, Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { NotFound } from '@/components/console/NotFound'
import { Avatar, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { formatTranscriptTime, parseTranscriptTime } from '@/lib/transcript-time'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { consoleKeys } from '@/lib/swr-keys'
import { sessionSenderLabel } from '@/lib/session-trigger'
import { clipboardImageFile, prepareWebchatImage } from '@/lib/webchat-image'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import {
  sessionEffortAfterModelChange,
  sessionEffortChoicesForSelection,
  sessionPermissionChoices,
  sessionPermissionSelection,
  sessionRuntimeChangesEnabled
} from '@/lib/session-runtime-controls'

// One agent-turn step rendered from a real transcript message. Maps the daemon
// transcript kind (text | tool | reasoning) onto the existing lane styling.
function msgStep(m: SessionMessageDto): FmtStep {
  const k = (m.kind || 'text').toLowerCase()
  if (k === 'tool') {
    return {
      lane: 'TOOL',
      laneColor: 'var(--blue-500)',
      dot: 'var(--blue-500)',
      weight: 500,
      textColor: 'var(--text-secondary)',
      codeColor: 'var(--text-secondary)',
      text: '',
      code: m.text,
      files: [],
      time: formatTranscriptTime(m.ts),
      // Carry the raw message so the row can render the captured tool body (input /
      // output / content / diff / locations) below the title, on demand.
      ...(m.body ? { msg: m } : {})
    }
  }
  if (k === 'reasoning') {
    return {
      lane: 'THINK',
      laneColor: 'var(--brand)',
      dot: 'var(--brand)',
      weight: 500,
      textColor: 'var(--text-tertiary)',
      codeColor: 'var(--text-secondary)',
      text: m.text,
      code: '',
      files: [],
      time: formatTranscriptTime(m.ts)
    }
  }
  return {
    lane: '',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 400,
    textColor: 'var(--text-primary)',
    codeColor: 'var(--text-secondary)',
    text: m.text,
    code: '',
    files: [],
    time: formatTranscriptTime(m.ts)
  }
}

interface FmtStep {
  lane: string
  laneColor: string
  dot: string
  weight: number
  textColor: string
  codeColor: string
  text: string
  code: string
  files: { tag: string; path: string; color: string }[]
  time?: string
  // Present only on real-transcript tool rows that carry a captured body.
  msg?: SessionMessageDto
}

function fmtTranscriptDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

interface ActivityStats {
  firstMs: number | null
  lastMs: number | null
  toolCalls: number
}

function activityStatsFromTranscript(messages: SessionMessageDto[]): ActivityStats {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  const toolIds = new Set<string>()
  let anonymousToolRows = 0

  for (const m of messages) {
    const t = parseTranscriptTime(m.ts)
    if (t != null) {
      first = Math.min(first, t)
      last = Math.max(last, t)
    }

    if ((m.kind || '').toLowerCase() === 'tool') {
      if (m.toolCallId) toolIds.add(m.toolCallId)
      else anonymousToolRows += 1
    }
  }

  return {
    firstMs: Number.isFinite(first) ? first : null,
    lastMs: Number.isFinite(last) ? last : null,
    toolCalls: toolIds.size + anonymousToolRows
  }
}

function activityStatsFromSteps(steps: SessionStep[]): ActivityStats {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  let toolCalls = 0

  for (const stp of steps) {
    if (stp.observedAtMs != null && Number.isFinite(stp.observedAtMs)) {
      first = Math.min(first, stp.observedAtMs)
      last = Math.max(last, stp.observedAtMs)
    }
    if (stp.kind === 'tool') toolCalls += 1
  }

  return {
    firstMs: Number.isFinite(first) ? first : null,
    lastMs: Number.isFinite(last) ? last : null,
    toolCalls
  }
}

function minTime(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
  return finite.length > 0 ? Math.min(...finite) : null
}

function maxTime(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
  return finite.length > 0 ? Math.max(...finite) : null
}

function fmtStep(stp: SessionStep): FmtStep {
  const L = lane(stp.kind)
  return {
    lane: L.lane,
    laneColor: L.laneColor,
    dot: L.dot,
    weight: L.weight,
    textColor: L.textColor,
    codeColor: L.codeColor,
    text: stp.text,
    code: stp.code ?? '',
    files: (stp.files ?? []).map((f) => ({ tag: f.tag, path: f.path, color: fileColor(f.tag) })),
    time: stp.time ?? ''
  }
}

// ── captured tool body rendering ──────────────────────────────────────────────
// The daemon captures the full ACP ToolCall (input / output / content / diff /
// terminal / locations) and ships a ≤32 KiB JSON preview inline; the full body is
// pulled on demand. Everything below renders that structured body faithfully.

// ACP status → badge colouring (completed green, failed red, in-flight amber).
function statusBadge(s?: string): { bg: string; text: string; dot: string } | null {
  const v = (s || '').toLowerCase()
  if (!v) return null
  if (v === 'completed') return { bg: 'var(--status-online-soft)', text: 'var(--green-500)', dot: 'var(--green-500)' }
  if (v === 'failed') return { bg: 'var(--status-error-soft)', text: 'var(--red-600)', dot: 'var(--red-600)' }
  // pending / in_progress
  return { bg: 'var(--status-paused-soft)', text: 'var(--amber-500)', dot: 'var(--amber-500)' }
}

// Pretty-print a free-form value (rawInput/rawOutput) — objects as indented JSON,
// strings verbatim (so a command / file body reads naturally).
function fmtValue(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function CodeBlock({ children }: { children: string }) {
  return <div className="codeblk mt-[6px] max-h-80 overflow-auto">{children}</div>
}

function DetailLabel({ children }: { children: string }) {
  return (
    <div className="mono mt-[10px] text-[10px] font-semibold tracking-[.04em] text-(--text-tertiary)">{children}</div>
  )
}

// One ACP ToolCallContent block: { type:'content', content } | { type:'diff', path,
// oldText, newText } | { type:'terminal', terminalId }. Kept opaque in the schema,
// so narrow structurally here.
function ContentBlock({ block }: { block: unknown }) {
  if (!block || typeof block !== 'object') return <CodeBlock>{fmtValue(block)}</CodeBlock>
  const b = block as Record<string, unknown>
  if (b.type === 'diff') {
    const path = typeof b.path === 'string' ? b.path : ''
    const oldText = typeof b.oldText === 'string' ? b.oldText : b.oldText == null ? '' : fmtValue(b.oldText)
    const newText = typeof b.newText === 'string' ? b.newText : b.newText == null ? '' : fmtValue(b.newText)
    return (
      <div className="mt-[6px]">
        {path && <span className="scope mb-1 inline-block">{path}</span>}
        <div className="codeblk max-h-80 overflow-auto whitespace-pre-wrap">
          {oldText.split('\n').map((l, i) => (
            <div key={`o${i}`} className="text-(--red-600)">
              - {l}
            </div>
          ))}
          {newText.split('\n').map((l, i) => (
            <div key={`n${i}`} className="text-(--green-500)">
              + {l}
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (b.type === 'terminal') {
    const ref = typeof b.terminalId === 'string' ? b.terminalId : fmtValue(b.terminalId)
    return (
      <div className="mt-[6px]">
        <span className="scope">terminal {ref}</span>
      </div>
    )
  }
  if (b.type === 'content') {
    const inner = b.content as Record<string, unknown> | undefined
    // ACP content block: usually { type:'text', text } — surface text directly.
    if (inner && typeof inner === 'object' && typeof inner.text === 'string') return <CodeBlock>{inner.text}</CodeBlock>
    return <CodeBlock>{fmtValue(b.content)}</CodeBlock>
  }
  return <CodeBlock>{fmtValue(block)}</CodeBlock>
}

// The expandable body panel for one tool row: input, output, content blocks,
// locations, plus a "view full" affordance when only a truncated preview is inline.
function ToolBodyDetail({ msg, sessionId, agentId }: { msg: SessionMessageDto; sessionId: string; agentId: string }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<string | null>(null) // full body JSON, once fetched
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Prefer the fetched full body over the inline preview once available.
  const bodyStr = full ?? msg.body ?? null
  let body: ToolBody | null = null
  let parseErr = false
  if (bodyStr) {
    try {
      body = JSON.parse(bodyStr) as ToolBody
    } catch {
      parseErr = true
    }
  }

  const truncated = msg.bodyTruncated && full == null
  const badge = statusBadge(body?.status ?? msg.toolStatus)
  const kind = body?.kind ?? msg.toolKind
  const bytes = msg.bodyBytes

  const loadFull = () => {
    if (loading || !agentId) return
    setLoading(true)
    setErr(null)
    fetchToolBody(sessionId, agentId, msg.toolCallId ?? body?.toolCallId ?? '').then(
      (s) => {
        setFull(s)
        setLoading(false)
        setOpen(true)
      },
      (e) => {
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    )
  }

  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

  return (
    <div className="mt-[6px]">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)"
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          {open ? 'Hide detail' : 'View detail'}
        </button>
        {kind && <span className="scope text-[10.5px]">{kind}</span>}
        {badge && (
          <span className="badge text-[10px]" style={{ background: badge.bg, color: badge.text }}>
            <span className="dot h-[5px] w-[5px]" style={{ background: badge.dot }} />
            {body?.status ?? msg.toolStatus}
          </span>
        )}
        {truncated && bytes != null && (
          <span className="font-sans text-[10.5px] font-medium leading-normal text-(--text-tertiary)">
            Truncated preview · full size {kb(bytes)}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-1">
          {parseErr ? (
            <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--red-600)">
              Couldn&apos;t parse the tool body.
            </div>
          ) : body ? (
            <>
              {body.rawInput != null && (
                <>
                  <DetailLabel>INPUT</DetailLabel>
                  <CodeBlock>{fmtValue(body.rawInput)}</CodeBlock>
                </>
              )}
              {body.rawOutput != null && (
                <>
                  <DetailLabel>OUTPUT</DetailLabel>
                  <CodeBlock>{fmtValue(body.rawOutput)}</CodeBlock>
                </>
              )}
              {body.content && body.content.length > 0 && (
                <>
                  <DetailLabel>CONTENT</DetailLabel>
                  {body.content.map((c, i) => (
                    <ContentBlock key={i} block={c} />
                  ))}
                </>
              )}
              {body.locations && body.locations.length > 0 && (
                <>
                  <DetailLabel>LOCATIONS</DetailLabel>
                  <div className="mt-[6px] flex flex-wrap gap-[6px]">
                    {body.locations.map((l, i) => (
                      <span key={i} className="scope">
                        {l.path}
                        {l.line != null ? `:${l.line}` : ''}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {(truncated || body.truncated) && (
                <div className="mt-[10px]">
                  {err && (
                    <div className="mb-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--red-600)">
                      {err}
                    </div>
                  )}
                  <button
                    onClick={loadFull}
                    disabled={loading}
                    className={`iconbtn w-auto gap-[6px] px-[11px] py-1 font-sans text-[11.5px] font-semibold leading-normal ${
                      loading ? 'opacity-60' : ''
                    }`}
                  >
                    {loading ? <Spinner size={13} /> : <Icon name="maximize-2" size={13} />}
                    View full
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              No body captured for this tool call.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Turn =
  | {
      kind: 'user'
      sp: ReturnType<typeof speaker>
      sourceLabel: string
      time: string
      text: string
      image?: SessionImage
      isCron: boolean
      cronId: string | null
    }
  | { kind: 'bot'; agentName: string; model: string; time: string; steps: FmtStep[] }

function SessionRelationLink({
  relation,
  orgPath,
  bordered = false
}: {
  relation: SessionRelationDto
  orgPath: (path: string) => string
  bordered?: boolean
}) {
  const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
  return (
    <Link
      href={orgPath(`/sessions/${encodeURIComponent(relation.id)}`)}
      title={title}
      className={`lnk flex min-w-0 items-center gap-2 py-[10px] no-underline ${
        bordered ? 'border-t border-(--border-subtle)' : ''
      }`}
    >
      <Icon name="message-square" size={14} className="flex-none" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold leading-normal">{title}</span>
      {relation.title && (
        <span className="hidden flex-none font-mono text-[10.5px] font-medium leading-normal text-(--text-tertiary) desktop:inline">
          {relation.id.slice(0, 8)}
        </span>
      )}
      <Icon name="chevron-right" size={14} color="var(--text-tertiary)" className="flex-none" />
    </Link>
  )
}

function SessionFamilyLinks({
  parent,
  children,
  orgPath
}: {
  parent: SessionRelationDto | null
  children: SessionRelationDto[]
  orgPath: (path: string) => string
}) {
  if (!parent && children.length === 0) return null
  return (
    <div className="card mx-4 mt-4 overflow-hidden desktop:mx-0 desktop:mt-0 desktop:mb-4">
      {parent && (
        <div
          className={`grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4 desktop:grid-cols-[118px_minmax(0,1fr)] ${
            children.length > 0 ? 'border-b border-(--border-subtle)' : ''
          }`}
        >
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            Parent session
          </span>
          <SessionRelationLink relation={parent} orgPath={orgPath} />
        </div>
      )}
      {children.length > 0 && (
        <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4 desktop:grid-cols-[118px_minmax(0,1fr)]">
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            {children.length === 1 ? 'Child session' : `Child sessions (${children.length})`}
          </span>
          <div className="min-w-0">
            {children.map((child, index) => (
              <SessionRelationLink key={child.id} relation={child} orgPath={orgPath} bordered={index > 0} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function SessionDetailView() {
  const acpRegistry = useAcpRegistry()
  const { activeOrg, orgPath } = useOrgs()
  const router = useRouter()
  const { id } = useParams<{ id: string }>()
  const { agents, allSessions, sessionsLoading, crons, daemons, members } = useConsoleData()
  const {
    getPgSession,
    getLiveSteps,
    clearLiveSteps,
    getPgInput,
    getPgImage,
    isPgBusy,
    setPgInput: setPgInputById,
    setPgImage,
    pgSend,
    pgSetModel,
    pgSetEffort,
    pgSetPermissionMode,
    pgSetFast,
    pgCancel
  } = usePlayground()
  const { user, me } = useProfile()
  const [copied, setCopied] = useState(false)
  const [msgs, setMsgs] = useState<SessionMessageDto[] | null>(null)
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgPaging, setMsgPaging] = useState(false)
  const [msgErr, setMsgErr] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [showThinking, setShowThinking] = useState(true)
  const [showTools, setShowTools] = useState(true)
  const [imagePreparing, setImagePreparing] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [runtimeSelections, setRuntimeSelections] = useState<
    Record<string, { model?: string; effort?: string; permissionMode?: string }>
  >({})
  const imageInputRef = useRef<HTMLInputElement>(null)

  const localSession = getPgSession(id) ?? allSessions.find((s) => s.id === id) ?? null
  // Relationship links can point outside the cursor pages loaded by SessionsView.
  // Fetch CP-stored detail metadata for real sessions (or an otherwise-missing
  // deep link) and use it as a fallback row. Mock sessions carry local steps and
  // synthetic playground ids deliberately skip this request.
  const syntheticPlayground = localSession?.platform === 'playground' && id !== localSession.realSessionId
  const detailId =
    !syntheticPlayground && (!localSession || localSession.steps.length === 0 || localSession.platform === 'playground')
      ? id
      : null
  const { data: sessionDetail, isLoading: sessionDetailLoading } = useSWR<SessionDetailDto>(
    consoleKeys.sessionDetail(activeOrg?.id, detailId),
    ([, orgId, , sessionId]) => fetchSessionDetail(sessionId as string, orgId as string),
    { refreshInterval: 30_000 }
  )
  const sessionBase = localSession ?? (sessionDetail ? sessionFromDetailDto(sessionDetail) : null)
  const owner = sessionBase ? agents.find((a) => a.id === sessionBase.agentId) : undefined
  const session =
    sessionBase && !localSession
      ? {
          ...sessionBase,
          agentName: owner ? agentLabel(owner) : sessionBase.agentId,
          model: sessionBase.model ?? (sessionBase.runtime ? '' : (owner?.model ?? '—')),
          runtime: sessionBase.runtime ?? owner?.runtime ?? '',
          daemon: sessionBase.daemon ?? owner?.daemon
        }
      : sessionBase
  const agentRuntime = session?.runtime || owner?.runtime || ''
  const runtimeMeta = acpRuntime(acpRegistry, agentRuntime)
  const sessionBusy = session ? isPgBusy(session.id) : false

  // A fresh Playground starts on a synthetic `pg_…` route so it can render before
  // the runtime creates a durable session. As soon as the real id arrives, make it
  // the canonical URL. PlaygroundProvider resolves that id back to the live in-memory
  // session, so this replacement does not interrupt streaming; a refresh then loads
  // the persisted session instead of trying to find the synthetic id.
  useEffect(() => {
    const realSessionId = session?.platform === 'playground' ? session.realSessionId : undefined
    if (!realSessionId || id === realSessionId) return
    router.replace(`${orgPath(`/sessions/${encodeURIComponent(realSessionId)}`)}${window.location.search}`, {
      scroll: false
    })
  }, [id, orgPath, router, session?.platform, session?.realSessionId])

  // A real (CP) session arrives with an empty `steps` — its transcript is a
  // separate on-demand pull from the owning daemon. Playground + mock sessions
  // carry their own steps, so they never fetch.
  const sid = session?.id
  const aid = session?.agentId
  const wantTranscript = !!session && session.platform !== 'playground' && session.steps.length === 0 && !!aid
  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, agentLabel(a)])), [agents])
  const memberNameByIdentity = useMemo(() => {
    const names = new Map<string, string>()
    for (const m of members) {
      const label = memberDisplayName(m)
      names.set(m.userId, label)
      if (m.email) names.set(m.email, label)
    }
    return names
  }, [members])
  // The viewer's own webchat messages render as "You" (like the live playground) instead
  // of a raw id — see isSelfSender. Webchat-only: Slack senders never match /me.
  const isSelf = (sender?: string | null): boolean => isSelfSender(sender, me)
  const senderLabel = (sender: string | null | undefined, fallback?: string): string =>
    sessionSenderLabel(sender, fallback, agentNameById, memberNameByIdentity, me)

  useEffect(() => {
    if (!wantTranscript || !sid || !aid) return
    let active = true
    setMsgLoading(true)
    setMsgErr(null)
    setMsgs(null)
    setMsgPaging(false)
    // We're loading authoritative history — drop any optimistic live tail from a prior
    // visit so a resumed turn already in that history doesn't also render from the tail.
    clearLiveSteps(sid)
    // Pull the WHOLE history, not just the newest frame-budgeted page: render the
    // first (newest) page immediately, then keep paging strictly older via
    // nextCursor, prepending each page. Bounded so a pathological session can't
    // keep the proxy busy forever.
    const MAX_PAGES = 40
    ;(async () => {
      let all: SessionMessageDto[] = []
      let cursor: string | undefined
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchSessionMessages(sid, aid, cursor)
        if (!active) return
        all = [...page.messages, ...all]
        setMsgs(all)
        setMsgLoading(false)
        if (!page.nextCursor) {
          setMsgPaging(false)
          return
        }
        cursor = page.nextCursor
        setMsgPaging(true)
      }
      setMsgPaging(false)
    })().catch((e) => {
      if (!active) return
      setMsgErr(e instanceof Error ? e.message : String(e))
      setMsgLoading(false)
      setMsgPaging(false)
    })
    return () => {
      active = false
    }
  }, [wantTranscript, sid, aid, clearLiveSteps])

  useEffect(() => {
    if (!session || (session.platform !== 'playground' && session.platform !== 'webchat') || !sessionBusy) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [session?.id, session?.platform, sessionBusy])

  if (!session) {
    // Shell owns detail navigation at both breakpoints; this branch only renders the
    // loading or not-found body.
    return (
      <div className="wrap max-w-[880px] max-desktop:p-4">
        {/* Still pulling the sessions list — it's not "not found" until that settles. */}
        {sessionsLoading || (detailId !== null && sessionDetailLoading) ? (
          <LoadingState fill />
        ) : (
          <NotFound
            icon="message-square-off"
            kind="SESSION"
            title="Session not found"
            pre="No session "
            chip={id}
            post=" in this organization. It may have expired or been deleted."
            actionLabel="Back to sessions"
            actionHref={orgPath('/sessions')}
            searchLabel="Search sessions"
          />
        )}
      </div>
    )
  }

  const ss = status(session.status)
  const isPg = session.platform === 'playground'
  // A persisted webchat session is the same surface as the live playground — continue
  // it in place. `isLive` gates the composer/typing affordance for both.
  const isWebchat = session.platform === 'webchat'
  const sessionIntegration = sessionPlatform(session)
  const usesIntegrationAvatar = session.platform === 'hook' && sessionIntegration === 'github'
  const isLive = isPg || isWebchat
  // Composer state is per-session in the provider — bind it to THIS session's id so a
  // different live conversation streaming in the background can't disable or clear it.
  const pgBusy = sessionBusy
  const pgInput = getPgInput(session.id)
  const pgImage = getPgImage(session.id)
  const setPgInput = (v: string) => setPgInputById(session.id, v)
  const agentHref = session.agentId ? `/agents/${session.agentId}` : null
  const liveSteps = isWebchat ? getLiveSteps(session.id) : []

  // Resume the webchat conversation by its id (session.channelId == the conversationId);
  // a synthetic playground turn omits it (the CP mints a fresh id).
  const onPgSend = (text?: string) => {
    if (imagePreparing) return
    setImageError(null)
    pgSend(session.id, session.agentId ?? '', text, isWebchat ? session.channelId : undefined)
  }
  const onImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || imagePreparing) return
    setAttachMenuOpen(false)
    setImagePreparing(true)
    setImageError(null)
    try {
      setPgImage(session.id, await prepareWebchatImage(file))
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Couldn’t prepare that image.')
    } finally {
      setImagePreparing(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }
  const webchatConversationId = isWebchat ? session.channelId : undefined
  const onCopyLink = () => {
    try {
      const canonicalId = session.realSessionId ?? session.id
      const link = window.location.origin + orgPath(`/sessions/${encodeURIComponent(canonicalId)}`)
      void navigator.clipboard?.writeText(link)?.catch?.(() => {})
    } catch {
      /* noop */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  // Resolve a `cron:<scheduleId>` author string to its schedule (name once the crons
  // list loads). Shared by the header chip and the transcript turns so a scheduled
  // trigger reads as its schedule, not a raw uuid.
  const asCron = (s: string): { id: string; name: string | null } | null => {
    if (!s.startsWith('cron:')) return null
    const id = s.slice('cron:'.length)
    return { id, name: crons.find((c) => c.id === id)?.name ?? null }
  }

  const turns: Turn[] = []
  const speakers = new Set<string>()
  if (wantTranscript) {
    // Real transcript: agent output carries `sender === agentId`; everything else
    // is a human/cron author. Group consecutive agent messages into one turn.
    for (const m of msgs ?? []) {
      if (m.sender === session.agentId) {
        let last = turns[turns.length - 1]
        if (!last || last.kind !== 'bot') {
          last = { kind: 'bot', agentName: session.agentName ?? '', model: session.model ?? '', time: '', steps: [] }
          turns.push(last)
        }
        const step = msgStep(m)
        last.steps.push(step)
        if (!last.time && step.time) last.time = step.time
      } else {
        // Count participants by stable sender id — two people can share a display name.
        speakers.add(m.sender)
        const cron = asCron(m.sender)
        const senderAgentName = agentNameById.get(m.sender)
        const hookFallback = session.platform === 'hook' && m.sender?.startsWith('hook:') ? session.user : undefined
        turns.push({
          kind: 'user',
          sp: isSelf(m.sender)
            ? speaker('@you')
            : speaker(
                senderAgentName ?? m.sender,
                cron?.name ?? (cron ? 'Schedule' : senderLabel(m.sender, m.senderName ?? hookFallback))
              ),
          sourceLabel: platName(sessionIntegration),
          time: formatTranscriptTime(m.ts),
          text: m.text,
          image: m.attachments?.[0],
          isCron: !!cron,
          cronId: cron?.id ?? null
        })
      }
    }
  } else {
    let firstMsg = true
    session.steps.forEach((stp) => {
      if (stp.kind === 'msg') {
        const who = stp.who ?? session.user
        speakers.add(who)
        const cron = asCron(who)
        const senderAgentName = agentNameById.get(who)
        turns.push({
          kind: 'user',
          sp: speaker(senderAgentName ?? who, cron?.name ?? (cron ? 'Schedule' : senderAgentName)),
          sourceLabel: platName(sessionIntegration),
          time: stp.time ?? (firstMsg ? session.time : ''),
          text: stp.text,
          image: stp.image,
          isCron: !!cron,
          cronId: cron?.id ?? null
        })
        firstMsg = false
      } else {
        let last = turns[turns.length - 1]
        if (!last || last.kind !== 'bot') {
          last = { kind: 'bot', agentName: session.agentName ?? '', model: session.model ?? '', time: '', steps: [] }
          turns.push(last)
        }
        const step = fmtStep(stp)
        last.steps.push(step)
        if (!last.time && step.time) last.time = step.time
      }
    })
  }

  // An adopted webchat session layers the turns you send THIS visit below its fetched
  // history — the same fold as a synthetic playground session.
  if (isWebchat) {
    for (const stp of liveSteps) {
      if (stp.kind === 'msg') {
        const who = stp.who ?? session.user
        speakers.add(who)
        const senderAgentName = agentNameById.get(who)
        turns.push({
          kind: 'user',
          sp: speaker(senderAgentName ?? who, senderAgentName),
          sourceLabel: platName(sessionIntegration),
          time: stp.time ?? '',
          text: stp.text,
          image: stp.image,
          isCron: false,
          cronId: null
        })
      } else {
        let last = turns[turns.length - 1]
        if (!last || last.kind !== 'bot') {
          last = { kind: 'bot', agentName: session.agentName ?? '', model: session.model ?? '', time: '', steps: [] }
          turns.push(last)
        }
        const step = fmtStep(stp)
        last.steps.push(step)
        if (!last.time && step.time) last.time = step.time
      }
    }
  }

  // Transcript visibility is presentation-only: keep the complete turn list for
  // usage/duration accounting, and derive a filtered tree for rendering. Live PLAN
  // steps are the playground equivalent of persisted THINK messages.
  const isThinkingStep = (step: FmtStep): boolean => step.lane === 'THINK' || step.lane === 'PLAN'
  const isToolStep = (step: FmtStep): boolean => step.lane === 'TOOL'
  const hasThinkingSteps = turns.some((turn) => turn.kind === 'bot' && turn.steps.some((step) => isThinkingStep(step)))
  const hasToolSteps = turns.some((turn) => turn.kind === 'bot' && turn.steps.some((step) => isToolStep(step)))
  const hasActivityFilters = hasThinkingSteps || hasToolSteps
  const visibleTurns: Turn[] = turns.flatMap((turn): Turn[] => {
    if (turn.kind === 'user') return [turn]
    const steps = turn.steps.filter(
      (step) => (showThinking || !isThinkingStep(step)) && (showTools || !isToolStep(step))
    )
    return steps.length > 0 ? [{ ...turn, steps }] : []
  })

  // Sole author reads as "You" when it's the viewer (webchat) — checked on the raw
  // triggeredBy id, not the display `user`, since a resolved name would mask the match.
  const soleAuthor = senderLabel(session.triggeredBy, session.user)
  const participantsLabel = speakers.size > 1 ? speakers.size + ' participants' : soleAuthor
  // The session's `daemon` is the owning agent's daemonId (or '—' when unplaced);
  // resolve it to the daemon's display name — never surface the raw id/host
  // (short-id fallback when it isn't in the fleet), matching the Agents list.
  const owningDaemonId = session.daemon && session.daemon !== '—' ? session.daemon : owner?.daemon
  const owningDaemon =
    owningDaemonId && owningDaemonId !== '—' ? daemons.find((d) => d.daemonId === owningDaemonId) : undefined
  const daemonName =
    owningDaemonId && owningDaemonId !== '—'
      ? (owningDaemon?.name ?? (owningDaemonId.length > 12 ? owningDaemonId.slice(0, 8) : owningDaemonId))
      : ''
  // A cron-triggered session carries `user === "cron:<scheduleId>"`. When that's the
  // shown participant, render the chip as a link back to the owning schedule
  // (name-first once the crons list resolves it; the raw `cron:<id>` still links if
  // it hasn't).
  const headerCron = participantsLabel === session.user ? asCron(session.user) : null
  const pgEmpty = isPg && session.steps.length === 0 && !pgBusy
  // "No messages" only when nothing is rendered — a resumed webchat turn folds into
  // `turns`, so once you've sent one the empty card gives way to the transcript.
  const transcriptEmpty = wantTranscript && !msgLoading && !msgErr && (msgs?.length ?? 0) === 0 && turns.length === 0
  const prompts = pgPrompts(session.agentId ?? '')
  const loadedTranscriptStats = wantTranscript && msgs !== null ? activityStatsFromTranscript(msgs) : null
  const liveActivityStats = isPg ? activityStatsFromSteps(session.steps) : activityStatsFromSteps(liveSteps)
  const durationFirst = minTime(loadedTranscriptStats?.firstMs, liveActivityStats.firstMs)
  const durationLast = maxTime(
    loadedTranscriptStats?.lastMs,
    liveActivityStats.lastMs,
    pgBusy && durationFirst != null ? nowMs : null
  )
  const displayDuration =
    durationFirst != null && durationLast != null
      ? fmtTranscriptDuration(durationLast - durationFirst)
      : session.duration
  const displayToolCount = loadedTranscriptStats
    ? fmtCountCompact(loadedTranscriptStats.toolCalls + liveActivityStats.toolCalls)
    : liveActivityStats.toolCalls > 0 || isPg
      ? fmtCountCompact(liveActivityStats.toolCalls)
      : session.toolCount

  // Token-usage breakdown for the detail card — only the fields the runtime reported.
  const u = session.usage
  const fmtN = (n?: number) => (n == null ? null : fmtCountCompact(n))
  const usageEntries: { label: string; value: string }[] = []
  if (u) {
    const push = (label: string, n?: number) => {
      const v = fmtN(n)
      if (v != null) usageEntries.push({ label, value: v })
    }
    push('Input', u.inputTokens)
    push('Output', u.outputTokens)
    push('Thought', u.thoughtTokens)
    push('Cache read', u.cachedReadTokens)
    push('Cache write', u.cachedWriteTokens)
    if (u.contextUsed != null)
      usageEntries.push({
        label: 'Context',
        value: u.contextSize != null ? `${fmtN(u.contextUsed)} / ${fmtN(u.contextSize)}` : fmtN(u.contextUsed)!
      })
  }

  // Live controls and status folded into the composer toolbar. Webchat `status`
  // frames are authoritative when they include choices. An idle or restored session
  // may not have a live frame, so fall back to the owning daemon's discovered catalog.
  const allowRuntimeChangesInChat = owner?.allowRuntimeChangesInChat === true
  const runtimeChangesEnabled = sessionRuntimeChangesEnabled(allowRuntimeChangesInChat, session)
  const runtimeSelection = runtimeSelections[session.id]
  const setRuntimeSelection = (patch: { model?: string; effort?: string; permissionMode?: string }) =>
    setRuntimeSelections((current) => ({
      ...current,
      [session.id]: { ...current[session.id], ...patch }
    }))
  const runtimeProfile = owningDaemon?.runtimeModels.find((profile) => profile.runtime === agentRuntime)
  const runtimeCatalog = runtimeProfile?.modelCatalog ?? undefined
  const pgModel =
    runtimeSelection?.model ?? (session.model || owner?.model || preferredModelFor(owningDaemon, agentRuntime))
  const pgModels = runtimeChangesEnabled ? (session.availableModels ?? runtimeProfile?.models ?? []) : []
  const pgModelOptions =
    pgModels.length > 0 && pgModel && !pgModels.includes(pgModel) ? [pgModel, ...pgModels] : pgModels
  const selectedModelCapability = modelCapability(owningDaemon, agentRuntime, pgModel)
  const pgEffortChoices = runtimeChangesEnabled
    ? sessionEffortChoicesForSelection(agentRuntime, owningDaemon, pgModel, session.model, session.availableEfforts)
    : []
  const pgEffort = displayedEffort(
    runtimeSelection?.effort ?? session.effort ?? owner?.reasoning ?? '',
    pgEffortChoices,
    selectedModelCapability?.defaultEffort
  )
  const pgEffortOptions =
    runtimeChangesEnabled && pgEffort && !pgEffortChoices.some((choice) => choice.value === pgEffort)
      ? [{ value: pgEffort, label: effortLabel(agentRuntime, pgEffort) }, ...pgEffortChoices]
      : pgEffortChoices
  const livePermissionModes = session.availablePermissionModes
  const selectablePermissionModes = sessionPermissionChoices(agentRuntime, runtimeCatalog, livePermissionModes)
  const pgPermissionMode = sessionPermissionSelection(
    agentRuntime,
    runtimeCatalog,
    livePermissionModes,
    runtimeSelection?.permissionMode ??
      session.permissionMode ??
      owner?.permissionMode ??
      permissionModeDefault(agentRuntime)
  )
  const pgPermissionModes = runtimeChangesEnabled
    ? livePermissionModes === undefined &&
      pgPermissionMode &&
      !selectablePermissionModes.some((choice) => choice.v === pgPermissionMode)
      ? [{ v: pgPermissionMode, l: permissionModeLabel(agentRuntime, pgPermissionMode) }, ...selectablePermissionModes]
      : selectablePermissionModes
    : []
  // Shared style for the inline composer selectors.
  const pgSelectClass =
    'cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)'
  const pgStatusBar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
      {pgPermissionModes.length > 0 ? (
        <select
          aria-label="Session permission mode"
          value={pgPermissionMode}
          onChange={(event) => {
            const permissionMode = event.target.value
            setRuntimeSelection({ permissionMode })
            pgSetPermissionMode(session.id, session.agentId ?? '', permissionMode, webchatConversationId)
          }}
          className={pgSelectClass}
        >
          {pgPermissionModes.map((mode) => (
            <option key={mode.v} value={mode.v}>
              {mode.l}
            </option>
          ))}
        </select>
      ) : (
        session.permissionMode && <span>{permissionModeLabel(session.runtime ?? '', session.permissionMode)}</span>
      )}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <ContextWindowIndicator used={u?.contextUsed} size={u?.contextSize} />
        <span>
          <span className="font-mono text-[11.5px] font-medium leading-normal">{session.tokens}</span>&nbsp;tok
        </span>
        <span className="font-mono text-[11.5px] font-medium leading-normal">{session.cost}</span>
        <span className="inline-flex items-center gap-[6px] text-(--text-secondary)">
          <span className="av h-4 w-4 flex-none rounded-xs">
            <AgentMark model={agentRuntime} />
          </span>
          {pgModelOptions.length > 0 ? (
            <select
              aria-label="Session model"
              value={pgModel}
              onChange={(event) => {
                const model = event.target.value
                const currentEffort = runtimeSelection?.effort ?? session.effort ?? owner?.reasoning ?? ''
                const effort = sessionEffortAfterModelChange(agentRuntime, owningDaemon, model, currentEffort)
                setRuntimeSelection(effort === currentEffort ? { model } : { model, effort })
                pgSetModel(session.id, session.agentId ?? '', model, webchatConversationId)
                if (effort !== currentEffort) {
                  pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
                }
              }}
              className={pgSelectClass}
            >
              {pgModelOptions.map((model) => (
                <option key={model} value={model}>
                  {modelLabel(model)}
                </option>
              ))}
            </select>
          ) : (
            modelLabel(session.model ?? '')
          )}
        </span>
        {pgEffortOptions.length > 0 && (
          <select
            aria-label="Session reasoning effort"
            value={pgEffort}
            onChange={(event) => {
              const effort = event.target.value
              setRuntimeSelection({ effort })
              pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
            }}
            className={pgSelectClass}
          >
            {pgEffortOptions.map((effort) => (
              <option key={effort.value} value={effort.value}>
                {effort.label}
              </option>
            ))}
          </select>
        )}
        {!runtimeChangesEnabled && (session.effort ?? owner?.reasoning) && (
          <span>effort: {session.effort ?? owner?.reasoning}</span>
        )}
        {runtimeChangesEnabled && session.fastModeAvailable && (
          <select
            aria-label="Session fast mode"
            value={session.fastMode ? 'on' : 'off'}
            onChange={(e) =>
              pgSetFast(session.id, session.agentId ?? '', e.target.value === 'on', webchatConversationId)
            }
            className={pgSelectClass}
          >
            <option value="on">fast: on</option>
            <option value="off">fast: off</option>
          </select>
        )}
        {!runtimeChangesEnabled && session.fastMode !== undefined && (
          <span>fast: {session.fastMode ? 'on' : 'off'}</span>
        )}
      </div>
    </div>
  )

  // Mobile header-region derivations (≤768px meta strip + agent config row).
  const metaCells: { label: string; value: string }[] = [
    { label: 'Dur', value: displayDuration },
    { label: 'Tokens', value: session.tokens },
    { label: 'Cost', value: session.cost },
    { label: 'Tools', value: displayToolCount }
  ]
  const cfgLine = [
    daemonName,
    session.runtime ? runtimeLabel(session.runtime, runtimeMeta?.name) : '',
    modelLabel(session.model ?? '')
  ]
    .filter(Boolean)
    .join(' · ')

  // ── one responsive tree ─────────────────────────────────────────────────────
  // ≤768px renders the native push-screen body (Shell owns the 56px app bar:
  // back · title · status-dot/channel · link): meta strip → agent config row →
  // transcript → live. ≥769px renders the classic page: header → stat/usage
  // cards → transcript. Breakpoint differences are CSS-gated (desktop: /
  // max-desktop:), never JS-forked.
  return (
    <div className="wrap max-w-[880px] max-desktop:pb-6">
      {/* DESKTOP HEADER — h1 · status badge · meta chips · copy-link. The mobile
          title/status live in Shell's app bar, so this whole region is desktop-only. */}
      <div className="mb-[14px] hidden items-start gap-[14px] desktop:flex">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle text-[21px]">{session.title}</h1>
            <span className="badge" style={{ background: ss.bg, color: ss.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: ss.dot }} />
              {session.statusLabel || ss.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-[14px] gap-y-2">
            {agentHref ? (
              <Link className="lnk text-[12.5px] text-(--text-secondary)" href={agentHref}>
                <span className="av h-[18px] w-[18px] rounded-[5px]">
                  <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={18} />
                </span>
                {session.agentName}
              </Link>
            ) : (
              <span className="lnk cursor-default text-[12.5px] text-(--text-secondary)">
                <span className="av h-[18px] w-[18px] rounded-[5px]">
                  <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={18} />
                </span>
                {session.agentName}
              </span>
            )}
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <span className="imark h-4 w-4 rounded-xs">
                <PlatformMark platform={sessionIntegration} />
              </span>
              {session.threadUrl ? (
                <a
                  className="lnk font-mono text-[12px] font-medium leading-normal text-(--text-link)"
                  href={session.threadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open the ${platName(sessionIntegration)} thread`}
                >
                  {session.channel}
                </a>
              ) : (
                <span className="mono text-[12px]">{session.channel}</span>
              )}
            </span>
            {daemonName && (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                <Icon name="server" size={13} color="var(--text-tertiary)" />
                <span className="mono text-[12px]">{daemonName}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="cpu" size={13} color="var(--text-tertiary)" />
              {session.runtime ? `${runtimeLabel(session.runtime, runtimeMeta?.name)} · ` : ''}
              <span className="mono text-[12px]">{modelLabel(session.model ?? '')}</span>
            </span>
            {headerCron ? (
              <Link
                className="lnk font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)"
                href={orgPath(`/crons/${headerCron.id}`)}
              >
                <Icon name="calendar-clock" size={13} />
                {headerCron.name || 'Schedule'}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
                <Icon name="users" size={13} />
                {participantsLabel}
              </span>
            )}
          </div>
        </div>
        <button
          className="iconbtn w-auto shrink-0 gap-[7px] px-3 py-0 font-sans text-[12.5px] font-semibold leading-normal"
          onClick={onCopyLink}
        >
          <Icon name="link" size={14} />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {/* DESKTOP STAT CARD (full labels; the mobile meta strip below is its ≤768px twin). */}
      <div className="card mb-4 hidden desktop:block">
        <div className="grid grid-cols-[repeat(4,1fr)]">
          <div className="border-r border-(--border-subtle) px-4 py-[11px]">
            <div className="statlbl text-[11px]">Duration</div>
            <div className="mono mt-[2px] text-[14px] font-semibold">{displayDuration}</div>
          </div>
          <div className="border-r border-(--border-subtle) px-4 py-[11px]">
            <div className="statlbl text-[11px]">Tokens</div>
            <div className="mono mt-[2px] text-[14px] font-semibold">{session.tokens}</div>
          </div>
          <div className="border-r border-(--border-subtle) px-4 py-[11px]">
            <div className="statlbl text-[11px]">Cost</div>
            <div className="mono mt-[2px] text-[14px] font-semibold">{session.cost}</div>
          </div>
          <div className="px-4 py-[11px]">
            <div className="statlbl text-[11px]">Tool calls</div>
            <div className="mono mt-[2px] text-[14px] font-semibold">{displayToolCount}</div>
          </div>
        </div>
      </div>

      {/* MOBILE META STRIP — single-row 4-up, abbreviated labels tuned for 390px. */}
      <div className="grid grid-cols-[repeat(4,1fr)] border-b border-(--border-subtle) bg-(--surface-card) desktop:hidden">
        {metaCells.map((c, i) => (
          <div
            key={c.label}
            className={`min-w-0 overflow-hidden px-3 py-[10px] ${i < 3 ? 'border-r border-(--border-subtle)' : ''}`}
          >
            <div className="font-sans text-[10px] font-medium uppercase leading-normal tracking-[.06em] text-(--text-tertiary)">
              {c.label}
            </div>
            <div className="mt-[2px] truncate font-mono text-[13px] font-semibold leading-normal">{c.value}</div>
          </div>
        ))}
      </div>

      {/* MOBILE AGENT CONFIG ROW — taps through to the owning agent. */}
      {agentHref ? (
        <Link
          href={orgPath(agentHref)}
          className="box-border flex w-full items-center gap-[10px] border-b border-(--border-subtle) bg-(--surface-card) px-4 py-[10px] no-underline desktop:hidden"
        >
          <span className="av h-8 w-8 flex-none rounded-md">
            <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={32} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
            <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
              {session.agentName}
            </span>
            <span className="truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {cfgLine}
            </span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="flex-none" />
        </Link>
      ) : (
        <div className="flex items-center gap-[10px] border-b border-(--border-subtle) bg-(--surface-card) px-4 py-[10px] desktop:hidden">
          <span className="av h-8 w-8 flex-none rounded-md">
            <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={32} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
            <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
              {session.agentName}
            </span>
            <span className="truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {cfgLine}
            </span>
          </span>
        </div>
      )}

      {sessionDetail?.id === session.id && (
        <SessionFamilyLinks
          parent={sessionDetail.parentSession}
          children={sessionDetail.childSessions}
          orgPath={orgPath}
        />
      )}

      {/* Token-usage breakdown — desktop-only detail card. */}
      {usageEntries.length > 0 && (
        <div className="card mb-4 hidden flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-[9px] desktop:flex">
          <span className="font-sans text-[12.5px] font-semibold leading-normal">Token usage</span>
          <span className="mono mr-1 text-[10.5px] text-(--text-tertiary)">cumulative</span>
          {usageEntries.map((e) => (
            <span key={e.label} className="inline-flex items-baseline gap-[5px]">
              <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">{e.label}</span>
              <span className="mono text-[12px] font-semibold">{e.value}</span>
            </span>
          ))}
        </div>
      )}

      {wantTranscript && msgLoading && (
        <div className="flex justify-center py-10">
          <Spinner size={30} />
        </div>
      )}
      {wantTranscript && msgErr && (
        <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
          <span>
            Couldn&apos;t load the transcript — the owning daemon may be offline. Session history is pulled live from
            the daemon, so it&apos;s unavailable while that machine is disconnected.
          </span>
        </div>
      )}
      {transcriptEmpty && (
        <div className="card m-4 flex flex-col items-center gap-[6px] px-6 py-[34px] text-center desktop:m-0">
          <Icon name="message-square-dashed" size={20} color="var(--text-tertiary)" />
          <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No messages in this session yet.
          </div>
        </div>
      )}

      {msgPaging && (
        <div className="flex items-center justify-center gap-2 pt-[10px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary) desktop:pt-1 desktop:pb-3">
          <Spinner size={14} />
          Loading earlier activity…
        </div>
      )}
      {/* TRANSCRIPT — one shared tree. Mobile adds the 16px gutter column around
          turns + live tail; on desktop the gutter div is a plain block so turns and
          the composer sit in the page flow exactly as before. */}
      <div className="flex flex-col gap-4 p-4 desktop:block desktop:p-0">
        {hasActivityFilters && (
          <div
            className="flex flex-wrap items-center gap-[10px] desktop:mb-[14px]"
            role="group"
            aria-label="Transcript activity filters"
          >
            <span className="font-mono text-[11px] font-semibold uppercase leading-normal tracking-[.04em] text-(--text-tertiary)">
              Show
            </span>
            <span className="inline-flex items-center gap-3">
              {hasThinkingSteps && (
                <label
                  className="inline-flex cursor-pointer items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)"
                  title={showThinking ? 'Hide thinking' : 'Show thinking'}
                >
                  <input
                    type="checkbox"
                    checked={showThinking}
                    onChange={(event) => setShowThinking(event.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-(--brand)"
                  />
                  thinking
                </label>
              )}
              {hasToolSteps && (
                <label
                  className="inline-flex cursor-pointer items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)"
                  title={showTools ? 'Hide tool calls' : 'Show tool calls'}
                >
                  <input
                    type="checkbox"
                    checked={showTools}
                    onChange={(event) => setShowTools(event.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-(--brand)"
                  />
                  tools
                </label>
              )}
            </span>
          </div>
        )}
        {visibleTurns.length > 0 && (
          <div className="flex flex-col gap-4 desktop:gap-[14px]">
            {visibleTurns.map((turn, ti) =>
              turn.kind === 'user' ? (
                <div key={ti} className="flex items-start gap-[10px] desktop:gap-[11px]">
                  {turn.sp.handle === '@you' ? (
                    <Avatar
                      src={user.picture}
                      initials={turn.sp.initials}
                      size={30}
                      fontSize={11}
                      bg={turn.sp.avBg}
                      fg={turn.sp.avText}
                    />
                  ) : (
                    <span
                      className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full font-sans text-[11px] font-semibold leading-normal"
                      style={{ background: turn.sp.avBg, color: turn.sp.avText }}
                    >
                      {turn.isCron ? (
                        <Icon name="calendar-clock" size={15} />
                      ) : usesIntegrationAvatar ? (
                        <PlatformMark platform={sessionIntegration} />
                      ) : (
                        turn.sp.initials
                      )}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mb-[5px] flex items-baseline gap-[7px]">
                      {turn.isCron && turn.cronId ? (
                        <Link
                          className="lnk font-sans text-[13px] font-semibold leading-normal text-inherit"
                          href={orgPath(`/crons/${turn.cronId}`)}
                        >
                          {turn.sp.name}
                        </Link>
                      ) : (
                        <span className="font-sans text-[13px] font-semibold leading-normal">{turn.sp.name}</span>
                      )}
                      {!turn.isCron && turn.sp.handle !== turn.sp.name && (
                        <span className="mono text-[11px] text-(--text-tertiary)">{turn.sp.handle}</span>
                      )}
                      {/* Source-label chip is desktop-only chrome. */}
                      <span className="hidden rounded-[3px] border border-(--border-strong) px-1 py-[1px] font-sans text-[9px] font-medium uppercase leading-normal tracking-[.06em] text-(--text-tertiary) desktop:inline">
                        {turn.sourceLabel}
                      </span>
                      {turn.time && (
                        <span className="mono ml-auto shrink-0 whitespace-nowrap text-[11px] text-(--text-tertiary)">
                          {turn.time}
                        </span>
                      )}
                    </div>
                    <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-card) px-[13px] py-[10px] font-sans text-[13.5px] font-normal leading-[1.5] text-(--text-primary) desktop:px-[14px] desktop:py-[11px] desktop:leading-[1.55]">
                      {turn.image && (
                        <img
                          src={`data:${turn.image.mimeType};base64,${turn.image.data}`}
                          alt={turn.image.name}
                          className={`max-h-[360px] max-w-full rounded-md object-contain ${
                            turn.text ? 'mb-[10px]' : ''
                          }`}
                        />
                      )}
                      {turn.text && <MessageText text={turn.text} />}
                    </div>
                  </div>
                </div>
              ) : (
                <div key={ti} className="flex items-start gap-[10px] desktop:gap-[11px]">
                  <span className="av h-[30px] w-[30px] flex-none rounded-md">
                    <AgentIconView icon={owner?.icon} runtime={agentRuntime || turn.model} size={30} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center gap-[7px]">
                      <span className="font-sans text-[13px] font-semibold leading-normal">{turn.agentName}</span>
                      {/* APP chip is desktop-only chrome. */}
                      <span className="hidden rounded-[3px] border border-(--border-strong) px-1 py-[1px] font-sans text-[9px] font-semibold leading-normal tracking-[.06em] text-(--text-tertiary) desktop:inline">
                        APP
                      </span>
                      {turn.time && (
                        <span className="mono ml-auto shrink-0 whitespace-nowrap text-[11px] text-(--text-tertiary)">
                          {turn.time}
                        </span>
                      )}
                    </div>
                    {/* Step card: `card` chrome on both widths (mobile radius 11); the inner
                    padding gutter + per-row bottom rules are desktop, edge-to-edge rows
                    with top rules are mobile. */}
                    <div className="card overflow-hidden max-desktop:rounded-[11px]">
                      <div className="desktop:px-[18px] desktop:pt-[6px] desktop:pb-3">
                        {turn.steps.map((st, si) => (
                          <div
                            key={si}
                            className={`grid grid-cols-[72px_1fr] gap-[11px] border-(--border-subtle) px-[14px] py-[11px] desktop:grid-cols-[90px_1fr] desktop:gap-[13px] desktop:border-b desktop:px-0 ${
                              si > 0 ? 'border-t desktop:border-t-0' : ''
                            }`}
                          >
                            <div className="flex flex-col items-end gap-[3px] self-start desktop:gap-1 desktop:pt-[1px]">
                              <div className="flex items-center justify-end gap-[6px] desktop:gap-[7px]">
                                <span
                                  className="mono text-[10px] font-semibold tracking-[.02em]"
                                  style={{ color: st.laneColor }}
                                >
                                  {st.lane}
                                </span>
                                <span className="dot h-[7px] w-[7px]" style={{ background: st.dot }} />
                              </div>
                              {st.time && (
                                <span className="mono whitespace-nowrap text-[10.5px] text-(--text-tertiary)">
                                  {st.time}
                                </span>
                              )}
                            </div>
                            <div className="min-w-0">
                              {st.text && (
                                <div
                                  className="font-sans text-[13px] leading-[1.5]"
                                  style={{ fontWeight: st.weight, color: st.textColor }}
                                >
                                  <MessageText text={st.text} />
                                </div>
                              )}
                              {st.code && (
                                <div className="codeblk mt-[7px]" style={{ color: st.codeColor }}>
                                  {st.code}
                                </div>
                              )}
                              {st.files.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-[6px]">
                                  {st.files.map((f, fi) => (
                                    <span key={fi} className="scope">
                                      <span style={{ color: f.color }}>{f.tag}</span> {f.path}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {st.msg && sid && aid && <ToolBodyDetail msg={st.msg} sessionId={sid} agentId={aid} />}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
        )}
        {turns.length > 0 && visibleTurns.length === 0 && (
          <div className="card px-4 py-5 text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            All transcript activity is hidden by the current filters.
          </div>
        )}

        {/* LIVE INDICATOR — mobile-only trailing bot avatar + blue-dot note while a
            platform run is live. (A live playground/webchat surface uses the
            typing-dots affordance below instead.) */}
        {session.status === 'online' && !isLive && (
          <div className="flex items-center gap-[10px] desktop:hidden">
            <span className="av h-[30px] w-[30px] flex-none rounded-md">
              <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={30} />
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
              <span className="h-[6px] w-[6px] rounded-full bg-(--blue-500)" />
              {session.statusLabel || 'Live'}
            </span>
          </div>
        )}

        {/* Playground / resumed webchat: typing indicator, starter prompts, composer. */}
        {isLive && (
          <>
            {pgBusy && (
              <div className="flex items-center gap-[10px] desktop:mt-[14px] desktop:gap-[11px]">
                <span className="av h-[30px] w-[30px] flex-none rounded-md">
                  <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={30} />
                </span>
                <div className="inline-flex items-center gap-1 rounded-[11px] bg-(--brand-soft) px-[14px] py-[11px]">
                  <span className="tdot" />
                  <span className="tdot [animation-delay:.18s]" />
                  <span className="tdot [animation-delay:.36s]" />
                </div>
              </div>
            )}
            {pgEmpty && (
              <div className="flex flex-wrap gap-2 desktop:mt-[6px]">
                {prompts.map((p) => (
                  <button key={p} className="chip" onClick={() => onPgSend(p)}>
                    {p}
                  </button>
                ))}
              </div>
            )}
            {imageError && (
              <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{imageError}</div>
            )}
            <div
              className="pgcomposer relative flex-col items-stretch gap-2 rounded-[11px] border border-(--border-default) desktop:ml-[41px] desktop:mt-4"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setAttachMenuOpen(false)
              }}
            >
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => void onImageFile(event.target.files?.[0])}
              />
              <div className="flex min-w-0 flex-col">
                {pgImage && (
                  <div className="relative mb-2 w-fit">
                    <img
                      src={`data:${pgImage.mimeType};base64,${pgImage.data}`}
                      alt={pgImage.name}
                      title={pgImage.name}
                      className="h-20 w-20 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) object-cover"
                    />
                    <button
                      type="button"
                      className="iconbtn absolute -right-2 -top-2 h-6 w-6 rounded-full shadow-(--shadow-xs)"
                      title="Remove image"
                      aria-label="Remove image"
                      onClick={() => setPgImage(session.id)}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                )}
                <textarea
                  className="pgin w-full border-0 px-1 py-2 focus:shadow-none"
                  placeholder={`Message ${session.agentName}…`}
                  value={pgInput}
                  onChange={(e) => setPgInput(e.target.value)}
                  onPaste={(event) => {
                    const image = clipboardImageFile(event.clipboardData)
                    if (!image) return
                    event.preventDefault()
                    void onImageFile(image)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      onPgSend()
                    }
                  }}
                />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <div className="relative flex-none">
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label="Add"
                    aria-haspopup="menu"
                    aria-expanded={attachMenuOpen}
                    disabled={imagePreparing}
                    onClick={() => setAttachMenuOpen((open) => !open)}
                  >
                    {imagePreparing ? <Spinner size={16} /> : <Icon name="plus" size={19} />}
                  </button>
                  {attachMenuOpen && (
                    <>
                      <div
                        aria-hidden="true"
                        className="fixed inset-0 z-40"
                        onClick={() => setAttachMenuOpen(false)}
                      ></div>
                      <div
                        role="menu"
                        className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[166px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="fopt"
                          onClick={() => {
                            setAttachMenuOpen(false)
                            imageInputRef.current?.click()
                          }}
                        >
                          <Icon name="image" size={16} color="var(--text-secondary)" />
                          Add photos
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {pgStatusBar}
                <button
                  className="sendbtn h-8 w-8 rounded-md"
                  aria-label={pgBusy ? 'Stop response' : 'Send message'}
                  onClick={() =>
                    pgBusy ? pgCancel(session.id, session.agentId ?? '', webchatConversationId) : onPgSend()
                  }
                  disabled={!pgBusy && (imagePreparing || (!pgInput.trim() && !pgImage))}
                >
                  <Icon name={pgBusy ? 'square' : 'arrow-up'} size={pgBusy ? 12 : 16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
