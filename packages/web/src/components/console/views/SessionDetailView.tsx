'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  agentLabel,
  agentPermissionDisplay,
  displayedEffort,
  effortLabel,
  fastModeAvailableFor,
  fileColor,
  isSelfSender,
  lane,
  modelCapability,
  modelLabel,
  MOCK_PREFIX,
  permissionModeLabel,
  pgPrompts,
  platName,
  preferredModelFor,
  runtimeLabel,
  sessionChannelDisplay,
  sessionPlatform,
  speaker,
  status,
  type Agent,
  type SessionImage,
  type SessionStep
} from '@/lib/data'
import {
  fetchSessionMessages,
  fetchSessionDetail,
  fetchToolBody,
  fmtCountCompact,
  memberDisplayName,
  mergeSessionDetailUsage,
  sessionFromDetailDto,
  type SessionDetailDto,
  type SessionMessageDto,
  type SessionRelationDto,
  type ToolBody
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { AgentIconView, LoadingState, ModelMark, PlatformMark, Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { NotFound } from '@/components/console/NotFound'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { formatTranscriptTime, parseTranscriptTime } from '@/lib/transcript-time'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { consoleKeys } from '@/lib/swr-keys'
import { sessionAttributionAgentAuthors, sessionAttributionAgentId, sessionSenderLabel } from '@/lib/session-trigger'
import { mergeSessionMessages } from '@/lib/session-transcript'
import { clipboardImageFile, prepareWebchatImage } from '@/lib/webchat-image'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import { ComposerMenu } from '@/components/console/ComposerMenu'
import { WORK_LANES, toggleWorkPanel, workCounts, workPanelOpen, workSummary } from '@/components/console/session-work'
import { ApprovalRequestsCard } from '@/components/console/ApprovalRequestsCard'
import { SessionVisibilityControl } from '@/components/console/SessionVisibilityControl'
import { WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'
import {
  sessionEffortAfterModelChange,
  sessionEffortChoicesForSelection,
  sessionPermissionChoices,
  sessionPermissionSelection,
  sessionRuntimeChangesEnabled
} from '@/lib/session-runtime-controls'

type ComposerMenuKey = 'permission' | 'model' | 'effort'

// Design composer selectors (session composer, mirrors HomeView): the model is a
// "pill" with a leading mark, effort/permission are plain chips. Full literal
// strings so Tailwind's scanner sees them (STYLE.md §8).
const COMPOSER_CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
const COMPOSER_CHIP_STATIC =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'
const COMPOSER_PILL =
  'inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] font-mono text-[11.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)'
const COMPOSER_PILL_STATIC =
  'inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] font-mono text-[11.5px] font-medium leading-normal text-(--text-primary)'

// The "fast" tag shown inside the model pill when fast mode is on.
function FastBadge() {
  return (
    <span className="rounded-sm bg-(--brand-soft) px-[5px] py-px font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-(--brand-soft-text)">
      fast
    </span>
  )
}

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

// A step's non-text extras (code block, file chips, captured tool body) — rendered
// identically in a turn's plain answer and in its collapsed "work" rows.
function StepExtras({ step, sessionId }: { step: FmtStep; sessionId?: string }) {
  return (
    <>
      {step.code && (
        <div className="codeblk mt-[7px]" style={{ color: step.codeColor }}>
          {step.code}
        </div>
      )}
      {step.files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-[6px]">
          {step.files.map((f, fi) => (
            <span key={fi} className="scope">
              <span style={{ color: f.color }}>{f.tag}</span> {f.path}
            </span>
          ))}
        </div>
      )}
      {step.msg && sessionId && <ToolBodyDetail msg={step.msg} sessionId={sessionId} />}
    </>
  )
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
function ToolBodyDetail({ msg, sessionId }: { msg: SessionMessageDto; sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<{ source: SessionMessageDto; body: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // A same-seq live update replaces `msg`; associate the fetched body with the
  // exact source row so an older full response can never mask the new preview.
  const fullBody = full?.source === msg ? full.body : null
  const bodyStr = fullBody ?? msg.body ?? null
  let body: ToolBody | null = null
  let parseErr = false
  if (bodyStr) {
    try {
      body = JSON.parse(bodyStr) as ToolBody
    } catch {
      parseErr = true
    }
  }

  const truncated = msg.bodyTruncated && fullBody == null
  const badge = statusBadge(body?.status ?? msg.toolStatus)
  const kind = body?.kind ?? msg.toolKind
  const bytes = msg.bodyBytes

  const loadFull = () => {
    if (loading) return
    setLoading(true)
    setErr(null)
    fetchToolBody(sessionId, msg.toolCallId ?? body?.toolCallId ?? '').then(
      (s) => {
        setFull({ source: msg, body: s })
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
      agent: Agent | null
      avatarUrl?: string | null
      sourceLabel: string
      time: string
      text: string
      image?: SessionImage
      isCron: boolean
      cronId: string | null
    }
  | { kind: 'bot'; agentName: string; model: string; time: string; steps: FmtStep[] }

function ParticipantAvatar({
  agent,
  avatarUrl,
  sp,
  isCron
}: {
  agent: Agent | null
  avatarUrl?: string | null
  sp: ReturnType<typeof speaker>
  isCron: boolean
}) {
  return (
    <span
      className="av flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md font-sans text-[9.5px] font-semibold leading-normal"
      title={sp.name}
    >
      {agent ? (
        <AgentIconView icon={agent.icon} runtime={agent.runtime} size={26} />
      ) : avatarUrl ? (
        <img src={avatarUrl} alt="" className="object-cover" style={{ width: '100%', height: '100%' }} />
      ) : isCron ? (
        <Icon name="calendar-clock" size={14} color="var(--text-secondary)" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-[inherit]"
          style={{ background: sp.avBg, color: sp.avText }}
        >
          {sp.initials || '?'}
        </span>
      )}
    </span>
  )
}

function SessionRelationLink({
  relation,
  agent,
  orgPath,
  bordered = false
}: {
  relation: SessionRelationDto
  agent?: Agent
  orgPath: (path: string) => string
  bordered?: boolean
}) {
  const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
  const agentName = agent ? agentLabel(agent) : relation.agentId
  return (
    <Link
      href={orgPath(`/sessions/${encodeURIComponent(relation.id)}`)}
      title={title}
      className={`lnk flex min-w-0 items-center gap-2 py-[10px] no-underline ${
        bordered ? 'border-t border-(--border-subtle)' : ''
      }`}
    >
      <span className="imark h-6 w-6 flex-none rounded-sm">
        <PlatformMark platform={relation.platform} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span className="truncate font-sans text-[12.5px] font-semibold leading-normal">{title}</span>
        <span className="truncate font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
          {agentName}
        </span>
      </span>
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
  agentById,
  orgPath
}: {
  parent: SessionRelationDto | null
  children: SessionRelationDto[]
  agentById: ReadonlyMap<string, Agent>
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
          <SessionRelationLink relation={parent} agent={agentById.get(parent.agentId)} orgPath={orgPath} />
        </div>
      )}
      {children.length > 0 && (
        <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4 desktop:grid-cols-[118px_minmax(0,1fr)]">
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            {children.length === 1 ? 'Child session' : `Child sessions (${children.length})`}
          </span>
          <div className="min-w-0">
            {children.map((child, index) => (
              <SessionRelationLink
                key={child.id}
                relation={child}
                agent={agentById.get(child.agentId)}
                orgPath={orgPath}
                bordered={index > 0}
              />
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
  const {
    agents,
    allSessions,
    sessionsLoading,
    crons,
    daemons,
    members,
    sessionActivityVersionById,
    sessionStreamGeneration,
    revalidateSessionLists
  } = useConsoleData()
  const {
    getPgSession,
    getLiveSteps,
    reconcileLiveSteps,
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
  const { me } = useProfile()
  const [copied, setCopied] = useState(false)
  // Desktop header "Details" popover (run facts: status, duration, tokens, …).
  const [detailOpen, setDetailOpen] = useState(false)
  const [msgs, setMsgs] = useState<SessionMessageDto[] | null>(null)
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgPaging, setMsgPaging] = useState(false)
  const [msgErr, setMsgErr] = useState<string | null>(null)
  const [tailReady, setTailReady] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The visibility the user last chose for a bot turn's collapsed "work" panel (keyed
  // by turn index), overriding the default that turn's content implies. Stored as the
  // explicit desired state, so a hidden panel stays hidden when streaming flips the
  // default — see workPanelOpen().
  const [workOverride, setWorkOverride] = useState<ReadonlyMap<number, boolean>>(() => new Map())
  const toggleWork = (ti: number, autoOpen: boolean) => setWorkOverride((prev) => toggleWorkPanel(prev, ti, autoOpen))
  const [imagePreparing, setImagePreparing] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [composerMenuOpen, setComposerMenuOpen] = useState<ComposerMenuKey | null>(null)
  const [runtimeSelections, setRuntimeSelections] = useState<
    Record<string, { model?: string; effort?: string; permissionMode?: string; fast?: boolean }>
  >({})
  const imageInputRef = useRef<HTMLInputElement>(null)
  const liveCursorRef = useRef<string | null>(null)
  const tailSessionRef = useRef<string | null>(null)
  const tailReadyRef = useRef(false)
  const tailInFlightRef = useRef<Promise<void> | null>(null)
  const tailDirtyRef = useRef(false)

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
  const {
    data: sessionDetail,
    isLoading: sessionDetailLoading,
    mutate: mutateSessionDetail
  } = useSWR<SessionDetailDto>(
    consoleKeys.sessionDetail(activeOrg?.id, detailId),
    ([, orgId, , sessionId]) => fetchSessionDetail(sessionId as string, orgId as string),
    { refreshInterval: 30_000 }
  )
  const detailSession = sessionDetail ? sessionFromDetailDto(sessionDetail) : null
  // The cursor-loaded list row can predate the final Dream usage report. Keep
  // its local/live fields, but let the independently refreshed detail snapshot
  // supply the authoritative per-session token and cost totals.
  const sessionBase = localSession ? mergeSessionDetailUsage(localSession, detailSession) : detailSession
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const owner = sessionBase?.agentId ? agentById.get(sessionBase.agentId) : undefined
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
  const sessionBusyRef = useRef(sessionBusy)
  sessionBusyRef.current = sessionBusy

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
  const memberPictureByIdentity = useMemo(() => {
    const pictures = new Map<string, string>()
    for (const member of members) {
      if (!member.picture) continue
      pictures.set(member.userId, member.picture)
      if (member.email) pictures.set(member.email, member.picture)
    }
    return pictures
  }, [members])
  const attributedAgentIdBySender = useMemo(
    () => sessionAttributionAgentAuthors(session?.platform ?? '', msgs ?? [], agentById),
    [session?.platform, msgs, agentById]
  )
  const participantAgent = (sender: string, text: string, trustedAgentBot?: boolean): Agent | undefined => {
    const id = agentById.has(sender)
      ? sender
      : (sessionAttributionAgentId(session?.platform ?? '', { text, trustedAgentBot }, agentById) ??
        attributedAgentIdBySender.get(sender))
    return id ? agentById.get(id) : undefined
  }
  // The viewer's own webchat messages render as "You" (like the live playground) instead
  // of a raw id — see isSelfSender. Webchat-only: Slack senders never match /me.
  const isSelf = (sender?: string | null): boolean => isSelfSender(sender, me)
  const senderLabel = (sender: string | null | undefined, fallback?: string): string =>
    sessionSenderLabel(sender, fallback, agentNameById, memberNameByIdentity, me)

  useEffect(() => {
    if (!wantTranscript || !sid || !aid) return
    let active = true
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
    // Pull the WHOLE history, not just the newest frame-budgeted page: render the
    // first (newest) page immediately, then keep paging strictly older via
    // nextCursor, prepending each page. Bounded so a pathological session can't
    // keep the proxy busy forever.
    const MAX_PAGES = 40
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
  }, [wantTranscript, sid, aid, reconcileLiveSteps])

  const refreshTranscriptTail = useCallback((): Promise<void> => {
    if (!wantTranscript || !sid || !tailReadyRef.current || sessionBusyRef.current) return Promise.resolve()
    if (tailInFlightRef.current) {
      tailDirtyRef.current = true
      return tailInFlightRef.current
    }
    const platform = session?.platform ?? ''
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
        setMsgs((current) => mergeSessionMessages(current ?? [], page.messages, platform))
        if (page.liveCursor !== null) {
          cursor = page.liveCursor
          liveCursorRef.current = cursor
        }
        if (!page.liveMore || page.liveCursor === null) break
      }
      if (tailSessionRef.current === sid && !sessionBusyRef.current) reconcileLiveSteps(sid, persisted, aid)
    })()
      .catch(() => {
        // Keep the last good transcript. The next SSE signal, reconnect, or
        // safety poll retries without replacing visible history with an error.
      })
      .finally(() => {
        if (tailInFlightRef.current !== run) return
        tailInFlightRef.current = null
        const retry = tailDirtyRef.current && tailSessionRef.current === sid
        tailDirtyRef.current = false
        if (retry) void refreshTranscriptTail()
      })
    tailInFlightRef.current = run
    return run
  }, [wantTranscript, sid, aid, session?.platform, reconcileLiveSteps])

  const sessionActivityVersion = sid ? (sessionActivityVersionById[sid] ?? 0) : 0
  useEffect(() => {
    if (!tailReady || sessionBusy) return
    void refreshTranscriptTail()
  }, [tailReady, sessionBusy, sessionActivityVersion, sessionStreamGeneration, refreshTranscriptTail])

  useEffect(() => {
    if (!tailReady) return
    const timer = window.setInterval(() => void refreshTranscriptTail(), 15_000)
    return () => window.clearInterval(timer)
  }, [tailReady, refreshTranscriptTail])

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
  // Session visibility (session-visibility.md §4.3/§6). Rendered in the desktop
  // header and the mobile meta strip; null when there is nothing to show (an org
  // session the caller cannot re-classify, or a mock/legacy row).
  const visibilityControl =
    sessionDetail && detailId ? (
      <SessionVisibilityControl
        sessionId={detailId}
        visibility={sessionDetail.visibility ?? undefined}
        state={sessionDetail.visibilityState}
        canChange={sessionDetail.canChangeVisibility === true}
        externalProvider={sessionDetail.externalProvider}
        externalResolution={sessionDetail.externalResolution}
        // Native runtime memory has no per-session gate, so the copy must not
        // promise a memory boundary this tier cannot deliver.
        nativeMemory={owner?.memoryProvider === 'native'}
        onChanged={({ visibility, state }) => {
          // Reflect the new tier locally, then re-read: the detail row also
          // carries the authoritative pending/applied state, and the lists must
          // drop (or regain) the row for other members.
          void mutateSessionDetail(
            (current) => (current ? { ...current, visibility, visibilityState: state } : current),
            { revalidate: true }
          )
          void revalidateSessionLists()
        }}
      />
    ) : null
  const isPg = session.platform === 'playground'
  // A persisted webchat session is the same surface as the live playground — continue
  // it in place. `isLive` gates the composer/typing affordance for both.
  const isWebchat = session.platform === 'webchat'
  const sessionIntegration = sessionPlatform(session)
  // Header channel chip — resolves a headless `cron:<id>` channel to its schedule.
  const channelDisplay = sessionChannelDisplay(session, (id) => crons.find((c) => c.id === id)?.name)
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
        const cron = asCron(m.sender)
        const senderAgent = participantAgent(m.sender, m.text, m.trustedAgentBot)
        speakers.add(senderAgent?.id ?? m.sender)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const hookFallback = session.platform === 'hook' && m.sender?.startsWith('hook:') ? session.user : undefined
        turns.push({
          kind: 'user',
          sp: isSelf(m.sender)
            ? speaker('@you')
            : speaker(
                senderAgentName ?? m.sender,
                cron?.name ?? (cron ? 'Schedule' : senderLabel(m.sender, m.senderName ?? hookFallback))
              ),
          agent: senderAgent ?? null,
          avatarUrl: isSelf(m.sender) ? me?.picture : memberPictureByIdentity.get(m.sender),
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
        const cron = asCron(who)
        const senderAgent = participantAgent(who, stp.text)
        speakers.add(senderAgent?.id ?? who)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        turns.push({
          kind: 'user',
          sp: speaker(senderAgentName ?? who, cron?.name ?? (cron ? 'Schedule' : senderAgentName)),
          agent: senderAgent ?? null,
          avatarUrl: isSelf(who) ? me?.picture : memberPictureByIdentity.get(who),
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
        const senderAgent = participantAgent(who, stp.text)
        speakers.add(senderAgent?.id ?? who)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        turns.push({
          kind: 'user',
          sp: speaker(senderAgentName ?? who, senderAgentName),
          agent: senderAgent ?? null,
          avatarUrl: isSelf(who) ? me?.picture : memberPictureByIdentity.get(who),
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
  const setRuntimeSelection = (patch: { model?: string; effort?: string; permissionMode?: string; fast?: boolean }) =>
    setRuntimeSelections((current) => ({
      ...current,
      [session.id]: { ...current[session.id], ...patch }
    }))
  const runtimeProfile = owningDaemon?.runtimeModels.find((profile) => profile.runtime === agentRuntime)
  const runtimeCatalog = runtimeProfile?.modelCatalog ?? undefined
  const pgModel =
    runtimeSelection?.model ?? (session.model || owner?.model || preferredModelFor(owningDaemon, agentRuntime))
  const pgModels = session.availableModels ?? runtimeProfile?.models ?? []
  const pgModelOptions =
    pgModels.length > 0 && pgModel && !pgModels.includes(pgModel) ? [pgModel, ...pgModels] : pgModels
  const selectedModelCapability = modelCapability(owningDaemon, agentRuntime, pgModel)
  const pgEffortChoices = sessionEffortChoicesForSelection(
    agentRuntime,
    owningDaemon,
    pgModel,
    session.model,
    session.availableEfforts
  )
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
    runtimeSelection?.permissionMode ?? session.permissionMode ?? owner?.permissionMode ?? ''
  )
  const pgPermissionModes =
    livePermissionModes === undefined &&
    pgPermissionMode &&
    !selectablePermissionModes.some((choice) => choice.v === pgPermissionMode)
      ? [{ v: pgPermissionMode, l: permissionModeLabel(agentRuntime, pgPermissionMode) }, ...selectablePermissionModes]
      : selectablePermissionModes
  // Stage the fast selection locally like model/effort/permission: an adopted
  // (persisted webchat) session has no synthetic provider entry for pgSetFast to
  // mutate, and an idle daemon session emits no status frame — without this the
  // switch would render stale and every click would re-send the same value.
  const pgFastMode = runtimeSelection?.fast ?? session.fastMode ?? owner?.fastMode ?? false
  const pgFastModeAvailable =
    (pgModel === session.model ? session.fastModeAvailable : undefined) ??
    fastModeAvailableFor(agentRuntime, selectedModelCapability)
  // Run facts for the desktop header's "Details" popover — the stats that used to
  // live in the header cards (status, duration, usage) plus the run's identity rows.
  const headerFacts: { icon: string; label: string; value: string }[] = [
    { icon: 'activity', label: 'Status', value: session.statusLabel || ss.label },
    { icon: 'clock', label: 'Duration', value: displayDuration },
    { icon: 'coins', label: 'Tokens', value: session.tokens },
    { icon: 'circle-dollar-sign', label: 'Cost', value: session.cost },
    { icon: 'wrench', label: 'Tool calls', value: String(displayToolCount) }
  ]
  if (daemonName) headerFacts.push({ icon: 'server', label: 'Daemon', value: daemonName })
  if (session.runtime)
    headerFacts.push({ icon: 'cpu', label: 'Runtime', value: runtimeLabel(session.runtime, runtimeMeta?.name) })
  if (session.model) headerFacts.push({ icon: 'box', label: 'Model', value: modelLabel(session.model) })

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
    <div className="wrap flex min-h-full max-w-[880px] flex-col max-desktop:pb-6">
      {/* DESKTOP HEADER — slim single row (design): agent · channel · participants ·
          visibility · Details popover · copy-link. The title lives in the top-bar
          crumb, and the old stat/usage cards moved into the Details popover. The
          mobile title/status live in Shell's app bar, so this region is desktop-only. */}
      <div className="mt-[-9px] mb-[10px] hidden items-center gap-2 border-b border-(--border-subtle) pb-[7px] desktop:flex">
        {agentHref ? (
          <Link className="lnk min-w-0 flex-[0_1_auto] text-[12.5px] text-(--text-secondary)" href={orgPath(agentHref)}>
            <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">
              <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={18} />
            </span>
            <span className="truncate">{session.agentName}</span>
          </Link>
        ) : (
          <span className="lnk min-w-0 flex-[0_1_auto] cursor-default text-[12.5px] text-(--text-secondary)">
            <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">
              <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={18} />
            </span>
            <span className="truncate">{session.agentName}</span>
          </span>
        )}
        <span className="inline-flex min-w-0 flex-[0_1_auto] items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
          <span className="imark h-4 w-4 flex-none rounded-xs">
            <PlatformMark platform={channelDisplay.platform} fillPct={100} />
          </span>
          {session.threadUrl ? (
            <a
              className="lnk truncate font-mono text-[12px] font-medium leading-normal text-(--text-link)"
              href={session.threadUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open the ${platName(sessionIntegration)} thread`}
            >
              {channelDisplay.label}
            </a>
          ) : (
            <span className="mono truncate text-[12px]">{channelDisplay.label}</span>
          )}
        </span>
        {headerCron ? (
          <Link
            className="lnk min-w-0 flex-[0_1_auto] font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)"
            href={orgPath(`/crons/${headerCron.id}`)}
          >
            <Icon name="calendar-clock" size={13} className="flex-none" />
            <span className="truncate">{headerCron.name || 'Schedule'}</span>
          </Link>
        ) : (
          <span className="inline-flex min-w-0 flex-[0_1_auto] items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
            <Icon name="users" size={13} className="flex-none" />
            <span className="truncate">{participantsLabel}</span>
          </span>
        )}
        {visibilityControl}
        <div
          className="relative ml-[-3px] flex-none"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !detailOpen) return
            event.stopPropagation()
            setDetailOpen(false)
          }}
        >
          <button
            className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            onClick={() => setDetailOpen((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={detailOpen}
            title="Run details"
          >
            <Icon name="info" size={14} />
            Details
          </button>
          {detailOpen && (
            <>
              <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setDetailOpen(false)} />
              <div role="dialog" aria-label="Run details" className="fmenu z-50 min-w-[216px] px-0 py-[5px]">
                {headerFacts.map((f) => (
                  <div key={f.label} className="flex items-center gap-[9px] px-3 py-[5px]">
                    <Icon name={f.icon} size={13} color="var(--text-tertiary)" className="flex-none" />
                    <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                      {f.label}
                    </span>
                    <span className="mono whitespace-nowrap text-[12px] font-semibold text-(--text-primary)">
                      {f.value}
                    </span>
                  </div>
                ))}
                {usageEntries.length > 0 && (
                  <>
                    <div className="my-1 border-t border-(--border-subtle)" />
                    <div className="px-3 pt-1 pb-[2px] font-mono text-[10px] font-semibold uppercase tracking-[.06em] text-(--text-tertiary)">
                      Token usage
                    </div>
                    {usageEntries.map((e) => (
                      <div key={e.label} className="flex items-center gap-[9px] py-1 pr-3 pl-[34px]">
                        <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                          {e.label}
                        </span>
                        <span className="mono whitespace-nowrap text-[12px] font-semibold text-(--text-primary)">
                          {e.value}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <button
          className="ml-auto flex h-[19px] w-[19px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
          onClick={onCopyLink}
          title={copied ? 'Copied' : 'Copy a link to this session'}
          aria-label="Copy a link to this session"
        >
          <Icon name={copied ? 'check' : 'link'} size={12} />
        </button>
      </div>

      {sessionDetail?.accessSyncDegraded && (
        <div className="mb-3 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4 max-desktop:mt-3">
          Slack membership could not be verified. Related sessions remain hidden until access checks recover.
        </div>
      )}

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

      {/* MOBILE VISIBILITY ROW — the desktop header is `hidden desktop:flex`, so
          the badge/toggle needs its own place in the mobile meta strip. */}
      {visibilityControl && (
        <div className="flex items-center gap-[10px] border-b border-(--border-subtle) bg-(--surface-card) px-4 py-[10px] desktop:hidden">
          {visibilityControl}
        </div>
      )}

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
          agentById={agentById}
          orgPath={orgPath}
        />
      )}

      {owner?.canEdit && !owner.name.startsWith(MOCK_PREFIX) && session.agentId && (
        <ApprovalRequestsCard
          agentId={session.agentId}
          sessionId={session.realSessionId ?? session.id}
          hideWhenEmpty
          className="mx-4 mt-4 max-desktop:rounded-lg desktop:mx-0 desktop:mt-0 desktop:mb-4"
        />
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
          turns + live tail. The column grows to fill the page (flex-1 inside the
          min-h-full wrap) so the flex-1 spacer below can pin the composer to the
          bottom even when the transcript is short. */}
      <div className="flex flex-1 flex-col gap-4 p-4 desktop:gap-0 desktop:p-0">
        {turns.length > 0 && (
          <div className="flex flex-col gap-4 desktop:gap-[15px]">
            {turns.map((turn, ti) =>
              turn.kind === 'user' ? (
                // 2b: user turns are right-aligned brand-soft bubbles. A sender label
                // sits above the bubble only when it isn't you (platform user / cron).
                <div key={ti} className="flex items-start justify-end gap-[9px]">
                  <div className="flex min-w-0 max-w-[86%] flex-col items-end gap-[3px]">
                    {(turn.isCron || turn.sp.handle !== '@you') && (
                      <span className="flex items-center gap-[6px] pr-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
                        {turn.isCron && turn.cronId ? (
                          <Link className="lnk text-inherit" href={orgPath(`/crons/${turn.cronId}`)}>
                            {turn.sp.name}
                          </Link>
                        ) : (
                          <span>{turn.sp.name}</span>
                        )}
                        {turn.time && <span className="mono">{turn.time}</span>}
                      </span>
                    )}
                    <div className="max-w-full rounded-[12px_12px_4px_12px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)">
                      {turn.image && (
                        <img
                          src={`data:${turn.image.mimeType};base64,${turn.image.data}`}
                          alt={turn.image.name}
                          className={`max-h-[360px] max-w-full rounded-md object-contain ${turn.text ? 'mb-[10px]' : ''}`}
                        />
                      )}
                      {turn.text && <MessageText text={turn.text} />}
                    </div>
                  </div>
                  <ParticipantAvatar agent={turn.agent} avatarUrl={turn.avatarUrl} sp={turn.sp} isCron={turn.isCron} />
                </div>
              ) : (
                (() => {
                  // 2b: the spoken answer (MSG/DONE) is plain text; the agent's work
                  // (reasoning / plan / tool / edit) collapses behind a per-turn toggle.
                  const textSteps = turn.steps.filter((s) => !WORK_LANES.has(s.lane))
                  const workSteps = turn.steps.filter((s) => WORK_LANES.has(s.lane))
                  // Reasoning steps / tool commands / edited FILES (distinct paths across
                  // EDIT rows, since one EDIT row can touch several files).
                  const { thinkCount, toolCount, editCount } = workCounts(workSteps)
                  const summary = workSummary(thinkCount, toolCount, editCount)
                  // Auto-open while a turn has produced only work (mid-stream), so the
                  // live agent isn't hidden; collapse once its answer text lands. Either
                  // default stays user-overridable, so thinking-only turns can be closed.
                  const autoOpen = textSteps.length === 0
                  const openWork = workPanelOpen(workOverride.get(ti), autoOpen)
                  return (
                    <div key={ti} className="flex items-start gap-[9px]">
                      <span className="av h-[26px] w-[26px] flex-none rounded-md">
                        <AgentIconView icon={owner?.icon} runtime={agentRuntime || turn.model} size={26} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-[5px] flex items-center gap-[7px]">
                          <span className="font-sans text-[13px] font-semibold leading-normal">{turn.agentName}</span>
                          {turn.time && (
                            <span className="mono ml-auto shrink-0 whitespace-nowrap text-[11px] text-(--text-tertiary)">
                              {turn.time}
                            </span>
                          )}
                        </div>
                        {textSteps.map((st, si) => (
                          <div key={si} className={si > 0 ? 'mt-2' : ''}>
                            {st.text && (
                              <div className="font-sans text-[13.5px] leading-[1.6] whitespace-pre-wrap text-(--text-primary)">
                                <MessageText text={st.text} />
                              </div>
                            )}
                            <StepExtras step={st} sessionId={sid} />
                          </div>
                        ))}
                        {workSteps.length > 0 && (
                          <>
                            <button
                              type="button"
                              onClick={() => toggleWork(ti, autoOpen)}
                              className="mt-2 inline-flex items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
                              title={openWork ? 'Hide the agent’s work' : 'Show the agent’s work'}
                            >
                              <Icon
                                name={openWork ? 'chevron-down' : 'chevron-right'}
                                size={13}
                                color="var(--text-tertiary)"
                              />
                              {summary || 'Details'}
                            </button>
                            {openWork && (
                              <div className="mt-2 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-app)">
                                {workSteps.map((st, si) => (
                                  <div
                                    key={si}
                                    className={`flex items-start gap-[11px] px-[14px] py-[10px] ${
                                      si > 0 ? 'border-t border-(--border-subtle)' : ''
                                    }`}
                                  >
                                    <div className="flex w-[52px] flex-none items-center gap-[6px] pt-[1px]">
                                      <span className="dot h-[7px] w-[7px]" style={{ background: st.dot }} />
                                      <span
                                        className="mono text-[10px] font-semibold tracking-[.02em]"
                                        style={{ color: st.laneColor }}
                                      >
                                        {st.lane}
                                      </span>
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      {st.text && (
                                        <div
                                          className="font-sans text-[13px] leading-[1.5]"
                                          style={{ fontWeight: st.weight, color: st.textColor }}
                                        >
                                          <MessageText text={st.text} />
                                        </div>
                                      )}
                                      <StepExtras step={st} sessionId={sid} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })()
              )
            )}
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
            {activeOrg && session.agentId && /^[0-9a-f-]{36}$/i.test(session.channel) && (
              <WebchatMcpApprovalCard orgId={activeOrg.id} agentId={session.agentId} conversationId={session.channel} />
            )}
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
              <div className="desktop:mt-[6px]">
                <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-(--text-tertiary)">
                  Start with
                </div>
                <div className="flex flex-wrap gap-2">
                  {prompts.map((p) => (
                    <button key={p} className="chip whitespace-nowrap" onClick={() => onPgSend(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {imageError && (
              <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{imageError}</div>
            )}
            {/* Flexible spacer (design): pushes the composer to the bottom of the page
                when the transcript is short; collapses once content overflows. -mt-4
                cancels the mobile gutter's gap so a collapsed spacer adds no height. */}
            <div aria-hidden="true" className="-mt-4 flex-1 desktop:mt-0 desktop:min-h-[18px]" />
            {/* Sticky-to-bottom composer: pinned to the bottom of the scroll area so it's
                always reachable while scrolling the transcript. Its opaque page-colour
                background covers earlier turns scrolling behind it; the negative `bottom`
                + matching bottom padding pull it flush past `.content`'s bottom padding
                (else turns would show through that strip). A top gradient softens the
                seam where the transcript slides underneath. */}
            <div className="sticky z-10 bg-(--surface-app) bottom-[calc(-24px-env(safe-area-inset-bottom,0px))] pb-[calc(24px+env(safe-area-inset-bottom,0px))] pt-2 desktop:bottom-[-26px] desktop:pb-[26px] desktop:pt-3">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-b from-transparent to-(--surface-app)"
              />
              {/* Composer card (design "achero"): textarea on top, a toolbar row below
                  the divider — attach · model pill (fast toggle in its menu) · effort ·
                  permission · context ring · send. Tokens/cost live in the header's
                  Details popover, not here. */}
              <div
                className="relative min-w-0 rounded-[11px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--brand) focus-within:[box-shadow:0_0_0_3px_var(--brand-ring)]"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  setAttachMenuOpen(false)
                  setComposerMenuOpen(null)
                }}
              >
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void onImageFile(event.target.files?.[0])}
                />
                {pgImage && (
                  <div className="relative mx-[15px] mt-3 w-fit">
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
                  className="block max-h-[160px] min-h-[56px] w-full resize-none border-0 bg-transparent px-[15px] pt-[13px] pb-[2px] font-sans text-[14px] leading-[1.55] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
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
                    // Enter sends — but NOT while an IME is composing (that Enter
                    // just confirms the candidate), and Shift+Enter is a newline.
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      onPgSend()
                    }
                  }}
                />
                <div className="flex items-center gap-2 border-t border-(--border-subtle) py-[7px] pr-[9px] pl-[10px]">
                  <div className="relative flex-none">
                    <button
                      type="button"
                      className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
                      aria-label="Attach a file"
                      aria-haspopup="menu"
                      aria-expanded={attachMenuOpen}
                      title="Attach a file"
                      disabled={imagePreparing}
                      onClick={() => {
                        setComposerMenuOpen(null)
                        setAttachMenuOpen((open) => !open)
                      }}
                    >
                      {imagePreparing ? <Spinner size={14} /> : <Icon name="paperclip" size={15} />}
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
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {runtimeChangesEnabled && pgModelOptions.length > 0 ? (
                      <ComposerMenu
                        title="Model"
                        value={pgModel}
                        options={pgModelOptions.map((model) => ({ value: model, label: modelLabel(model) }))}
                        open={composerMenuOpen === 'model'}
                        align="left"
                        triggerClassName={COMPOSER_PILL}
                        tooltips={false}
                        leading={
                          <span className="inline-flex h-[14px] w-[14px] flex-none items-center justify-center">
                            <ModelMark model={pgModel} fallbackRuntime={agentRuntime} />
                          </span>
                        }
                        trailing={pgFastModeAvailable && pgFastMode ? <FastBadge /> : undefined}
                        footer={
                          pgFastModeAvailable ? (
                            <div className="flex items-center gap-[10px] px-[7px] pt-2 pb-[3px]">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={pgFastMode}
                                aria-label="Fast mode"
                                title="Fast mode trades depth for latency"
                                className={`relative h-[15px] w-[26px] flex-none cursor-pointer rounded-full border-0 p-0 transition-colors ${
                                  pgFastMode ? 'bg-(--brand)' : 'bg-(--border-strong)'
                                }`}
                                onClick={() => {
                                  const fast = !pgFastMode
                                  setRuntimeSelection({ fast })
                                  pgSetFast(session.id, session.agentId ?? '', fast, webchatConversationId)
                                }}
                              >
                                <span
                                  className={`absolute top-[1px] h-[13px] w-[13px] rounded-full bg-white transition-[left] ${
                                    pgFastMode ? 'left-3' : 'left-[1px]'
                                  }`}
                                />
                              </button>
                              <span className="flex-1 font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                                Fast mode
                              </span>
                              <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                                lower latency
                              </span>
                            </div>
                          ) : undefined
                        }
                        onOpenChange={(open) => {
                          setAttachMenuOpen(false)
                          setComposerMenuOpen(open ? 'model' : null)
                        }}
                        onChange={(model) => {
                          const currentEffort = runtimeSelection?.effort ?? session.effort ?? owner?.reasoning ?? ''
                          const effort = sessionEffortAfterModelChange(agentRuntime, owningDaemon, model, currentEffort)
                          setRuntimeSelection(effort === currentEffort ? { model } : { model, effort })
                          pgSetModel(session.id, session.agentId ?? '', model, webchatConversationId)
                          if (effort !== currentEffort) {
                            pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
                          }
                        }}
                      />
                    ) : (
                      pgModel && (
                        <span className={COMPOSER_PILL_STATIC} title="Model">
                          <span className="inline-flex h-[14px] w-[14px] flex-none items-center justify-center">
                            <ModelMark model={pgModel} fallbackRuntime={agentRuntime} />
                          </span>
                          {modelLabel(pgModel)}
                          {pgFastModeAvailable && pgFastMode && <FastBadge />}
                        </span>
                      )
                    )}
                    {runtimeChangesEnabled && pgEffortOptions.length > 0 ? (
                      <ComposerMenu
                        title="Effort"
                        value={pgEffort}
                        options={pgEffortOptions.map((effort) => ({
                          value: effort.value,
                          label: effort.label,
                          description: effort.description
                        }))}
                        open={composerMenuOpen === 'effort'}
                        align="left"
                        triggerClassName={COMPOSER_CHIP}
                        tooltips={false}
                        onOpenChange={(open) => {
                          setAttachMenuOpen(false)
                          setComposerMenuOpen(open ? 'effort' : null)
                        }}
                        onChange={(effort) => {
                          setRuntimeSelection({ effort })
                          pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
                        }}
                      />
                    ) : (
                      pgEffort && (
                        <span className={COMPOSER_CHIP_STATIC} title="Effort">
                          {pgEffortChoices.find((choice) => choice.value === pgEffort)?.label ??
                            effortLabel(agentRuntime, pgEffort)}
                        </span>
                      )
                    )}
                    {runtimeChangesEnabled && pgPermissionModes.length > 0 ? (
                      <ComposerMenu
                        title="Permission"
                        value={pgPermissionMode}
                        options={pgPermissionModes.map((mode) => ({
                          value: mode.v,
                          label: mode.l,
                          description: mode.description
                        }))}
                        open={composerMenuOpen === 'permission'}
                        align="left"
                        triggerClassName={COMPOSER_CHIP}
                        onOpenChange={(open) => {
                          setAttachMenuOpen(false)
                          setComposerMenuOpen(open ? 'permission' : null)
                        }}
                        onChange={(permissionMode) => {
                          setRuntimeSelection({ permissionMode })
                          pgSetPermissionMode(session.id, session.agentId ?? '', permissionMode, webchatConversationId)
                        }}
                      />
                    ) : (
                      pgPermissionMode && (
                        <span className={COMPOSER_CHIP_STATIC} title="Permission">
                          {agentPermissionDisplay(owningDaemon, agentRuntime, pgPermissionMode)}
                        </span>
                      )
                    )}
                  </div>
                  <ContextWindowIndicator used={u?.contextUsed} size={u?.contextSize} />
                  <button
                    className="sendbtn ml-1 h-[26px] w-[26px] flex-none rounded-[7px]"
                    aria-label={pgBusy ? 'Stop response' : 'Send message'}
                    onClick={() =>
                      pgBusy ? pgCancel(session.id, session.agentId ?? '', webchatConversationId) : onPgSend()
                    }
                    disabled={!pgBusy && (imagePreparing || (!pgInput.trim() && !pgImage))}
                  >
                    <Icon name={pgBusy ? 'square' : 'arrow-up'} size={pgBusy ? 10 : 14} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
