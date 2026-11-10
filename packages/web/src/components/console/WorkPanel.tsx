'use client'

// A turn's work rows and their captured tool bodies, shared by the session page and a task's thread.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchToolBody, type SessionMessageDto, type ToolBody } from '@/lib/api'
import { Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { McpAppCard, type McpAppCardProps } from '@/components/console/McpAppCard'
import { ComputerScreenshots } from '@/components/console/ComputerScreenshots'
import { screenshotRefsIn } from '@/lib/computer-screenshots'
import { StateIcon } from '@/components/console/StateIcon'
import { Icon } from '@/components/ui'
import {
  mcpAppCard,
  mergeFetchedAppCard,
  stepStatusMark,
  WORK_LANES,
  workCounts,
  workSummary
} from '@/components/console/session-work'
import type { FmtStep } from '@/components/console/transcript-steps'

// A step's extras (code block, file chips, captured tool body), the same in an answer and in a work row.
export function StepExtras({
  step,
  sessionId,
  autoOpenTool
}: {
  step: FmtStep
  sessionId?: string
  autoOpenTool?: boolean
}) {
  const toolSessionId = step.toolSessionId ?? sessionId
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
      {step.msg && toolSessionId && <ToolBodyDetail msg={step.msg} sessionId={toolSessionId} autoOpen={autoOpenTool} />}
    </>
  )
}

// What the dot before a work-step title means, surfaced on hover.
export const LANE_TITLE: Record<string, string> = {
  THINK: 'Reasoning',
  PLAN: 'Plan',
  TOOL: 'Tool command',
  EDIT: 'File edit'
}

// Drops paired markdown markers so a reasoning title never shows raw `**` or backticks.
export function stripMdMarkers(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

// One work step: a status mark and a one-line title that expands to its text and extras; a title-only row does not expand.
export function WorkStepRow({
  step,
  sessionId,
  divider,
  live
}: {
  step: FmtStep
  sessionId?: string
  divider: boolean
  // The turn still streams; a finished turn's unsettled tool shows its plain dot, not a spinner that never stops.
  live: boolean
}) {
  const t = useTranslations('Sessions.detail')
  const [open, setOpen] = useState(false)
  // Tool rows keep their title in `code`; trimStart so leading blank lines never blank the title.
  const rawTitle = (step.text || step.code || '').trimStart().split('\n', 1)[0]?.trim() || step.lane || 'Step'
  const title = step.text ? stripMdMarkers(rawTitle) : rawTitle
  // Single-line code with no text IS the title — expanding must not repeat it.
  const codeBeyondTitle = !!step.code && (!!step.text || step.code.includes('\n'))
  const expandable = !!step.msg || step.files.length > 0 || codeBeyondTitle || step.text.includes('\n')
  const failed = (step.msg?.toolStatus ?? '').toLowerCase() === 'failed'
  const status = stepStatusMark(step.msg?.toolStatus)
  const mark = status === 'running' && !live ? null : status
  const markLabel = mark === 'running' ? t('stepRunning') : mark === 'done' ? t('stepDone') : t('stepFailed')
  return (
    <div className={divider ? 'border-t border-(--border-subtle)' : ''} data-step-status={mark ?? undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!expandable}
        className={`flex w-full min-w-0 items-center gap-[8px] border-0 bg-transparent px-[14px] py-[10px] text-left ${
          expandable ? 'cursor-pointer hover:bg-(--surface-hover)' : ''
        }`}
      >
        {mark ? (
          <StateIcon state={mark} label={markLabel} />
        ) : (
          <span
            className="dot h-[7px] w-[7px] flex-none"
            style={{ background: step.dot }}
            title={LANE_TITLE[step.lane]}
          />
        )}
        <span
          className={`min-w-0 truncate leading-[1.5] ${step.text ? 'font-sans text-[13px]' : 'mono text-[12px]'}`}
          style={{ fontWeight: step.weight, color: failed ? 'var(--red-600)' : step.textColor }}
        >
          {title}
        </span>
        {/* The step's state in words at the row's right edge, as the mockup's "done" / "running". */}
        {mark && (
          <span
            data-step-meta=""
            className={`ml-auto flex-none pl-2 font-sans text-[12px] leading-normal font-normal ${
              mark === 'failed' ? 'text-(--status-error)' : 'text-(--text-tertiary)'
            }`}
          >
            {markLabel}
          </span>
        )}
        {expandable && (
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            size={13}
            color="var(--text-tertiary)"
            className="flex-none"
          />
        )}
      </button>
      {open && (
        <div className="px-[14px] pb-[12px] pl-[29px]">
          {step.text.includes('\n') && (
            <div className="whitespace-pre-wrap font-sans text-[13px] leading-[1.5]" style={{ color: step.textColor }}>
              <MessageText text={step.text} platform={step.platform} />
            </div>
          )}
          <StepExtras step={codeBeyondTitle ? step : { ...step, code: '' }} sessionId={sessionId} autoOpenTool />
        </div>
      )}
    </div>
  )
}

// ── captured tool body: a ≤32 KiB preview inline, the full ACP ToolCall body pulled on demand ──

// ACP status → badge colouring (completed green, failed red, in-flight amber).
export function statusBadge(s?: string): { bg: string; text: string; dot: string } | null {
  const v = (s || '').toLowerCase()
  if (!v) return null
  if (v === 'completed') return { bg: 'var(--status-online-soft)', text: 'var(--green-500)', dot: 'var(--green-500)' }
  if (v === 'failed') return { bg: 'var(--status-error-soft)', text: 'var(--red-600)', dot: 'var(--red-600)' }
  // pending / in_progress
  return { bg: 'var(--status-paused-soft)', text: 'var(--amber-500)', dot: 'var(--amber-500)' }
}

// Pretty-prints a free-form value: objects as indented JSON, strings verbatim.
export function fmtValue(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function CodeBlock({ children }: { children: string }) {
  return <div className="codeblk mt-[6px] max-h-80 overflow-auto">{children}</div>
}

export function DetailLabel({ children }: { children: string }) {
  return (
    <div className="mono mt-[10px] text-[10px] font-semibold tracking-[.04em] text-(--text-tertiary)">{children}</div>
  )
}

// One ACP ToolCallContent block (content, diff or terminal), opaque in the schema so narrowed here.
export function ContentBlock({ block }: { block: unknown }) {
  const t = useTranslations('Sessions.detail')
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
        <span className="scope">{t('terminal', { ref })}</span>
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

/** One MCP App card, re-reading the template a transcript page strips so a truncated row renders whole. */
export function McpAppRow({
  step,
  sessionId,
  onRpc,
  onReport,
  onClose
}: {
  step: FmtStep
  sessionId?: string
  onRpc?: McpAppCardProps['onRpc']
  onReport?: McpAppCardProps['onReport']
  onClose?: McpAppCardProps['onClose']
}) {
  const [full, setFull] = useState<NonNullable<FmtStep['app']> | null>(null)
  const app = step.app
  const appId = app?.appId
  const toolCallId = step.msg?.toolCallId
  const wants = !!appId && !!toolCallId && !!sessionId && !app?.html
  useEffect(() => {
    if (!wants) return
    let live = true
    fetchToolBody(sessionId!, toolCallId!).then(
      (body) => {
        const card = mcpAppCard(body)
        if (live && card?.appId === appId) setFull(card)
      },
      () => {
        // A card that cannot be fetched stays the preview it already is.
      }
    )
    return () => {
      live = false
    }
  }, [wants, sessionId, toolCallId, appId])
  // The fetch fills what the row shed; the row stays authoritative, so a closed card's `outcome` is never undone.
  const whole = app && full?.appId === app.appId && !app.html ? { ...step, app: mergeFetchedAppCard(app, full) } : step
  return (
    <McpAppCard
      step={whole}
      {...(onRpc ? { onRpc } : {})}
      {...(onReport ? { onReport } : {})}
      {...(onClose ? { onClose } : {})}
    />
  )
}

// A tool row's body panel: input, output, content and locations, with a full read when only a preview is inline.
export function ToolBodyDetail({
  msg,
  sessionId,
  autoOpen
}: {
  msg: SessionMessageDto
  sessionId: string
  autoOpen?: boolean
}) {
  const t = useTranslations('Sessions.detail')
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<{ source: SessionMessageDto; body: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Fence the fetched body by content (toolCallId + preview), so an older fetch never masks a newer live preview.
  const fullBody = full && full.source.toolCallId === msg.toolCallId && full.source.body === msg.body ? full.body : null
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
  // Screenshots a computer tool stored, named by hash in its result (computer-use.md §9).
  const screenshotRefs = useMemo(() => screenshotRefsIn(bodyStr, body?.screenshots), [bodyStr, body?.screenshots])
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

  // A live call's fetched body is a snapshot; a status flip refetches it so an open panel gains the output.
  const liveStale =
    open &&
    !loading &&
    msg.body == null &&
    full != null &&
    full.source.toolCallId === msg.toolCallId &&
    full.source.toolStatus !== msg.toolStatus
  useEffect(() => {
    if (liveStale) loadFull()
    // liveStale gates the refetch to one per status change, so it is deliberately the only dependency.
  }, [liveStale])

  // A live step has no inline preview, so opening it fetches the full body as View full does.
  const toggle = () => {
    if (!open && bodyStr == null) {
      loadFull()
      return
    }
    setOpen((o) => !o)
  }

  // An expanded work row shows the body straight away; a live row without a preview fetches it.
  useEffect(() => {
    if (!autoOpen) return
    if (bodyStr == null) loadFull()
    else setOpen(true)
    // The one-shot open must not re-fire on body/preview churn while open.
  }, [autoOpen])

  return (
    <div className="mt-[6px]">
      <div className="flex flex-wrap items-center gap-2">
        {autoOpen ? (
          loading && <Spinner size={13} />
        ) : (
          <button
            onClick={toggle}
            disabled={loading}
            className="inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)"
          >
            {loading ? <Spinner size={13} /> : <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
            {open ? 'Hide detail' : 'View detail'}
          </button>
        )}
        {err && bodyStr == null && (
          <span className="font-sans text-[10.5px] font-medium leading-normal text-(--red-600)">{err}</span>
        )}
        {/* "Search completed" as plain text — the status colours the words, no chips. */}
        {(kind || badge) && (
          <span
            className="font-sans text-[11.5px] font-medium leading-normal"
            style={{ color: badge?.text ?? 'var(--text-tertiary)' }}
          >
            {[kind && kind.charAt(0).toUpperCase() + kind.slice(1), body?.status ?? msg.toolStatus]
              .filter(Boolean)
              .join(' ')}
          </span>
        )}
        {truncated && bytes != null && (
          <span className="font-sans text-[10.5px] font-medium leading-normal text-(--text-tertiary)">
            {t('truncatedPreview', { size: kb(bytes) })}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-1">
          {parseErr ? (
            <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--red-600)">
              {t('toolBodyParseError')}
            </div>
          ) : body ? (
            <>
              {body.rawInput != null && (
                <>
                  <DetailLabel>{t('input')}</DetailLabel>
                  <CodeBlock>{fmtValue(body.rawInput)}</CodeBlock>
                </>
              )}
              {body.rawOutput != null && (
                <>
                  <DetailLabel>{t('output')}</DetailLabel>
                  <CodeBlock>{fmtValue(body.rawOutput)}</CodeBlock>
                </>
              )}
              {body.content && body.content.length > 0 && (
                <>
                  <DetailLabel>{t('content')}</DetailLabel>
                  {body.content.map((c, i) => (
                    <ContentBlock key={i} block={c} />
                  ))}
                </>
              )}
              {screenshotRefs.length > 0 && (
                <>
                  <DetailLabel>{t('screenshots')}</DetailLabel>
                  <ComputerScreenshots sessionId={sessionId} refs={screenshotRefs} />
                </>
              )}
              {body.locations && body.locations.length > 0 && (
                <>
                  <DetailLabel>{t('locations')}</DetailLabel>
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
                    {t('viewFull')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('noToolBody')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** What an agent turn's header reports about its work: the work rows, their summary, and how many tool calls failed. */
export function turnWork(steps: readonly FmtStep[]): { workSteps: FmtStep[]; summary: string; failed: number } {
  const workSteps = steps.filter((s) => WORK_LANES.has(s.lane))
  const { thinkCount, toolCount, editCount } = workCounts(workSteps)
  const failed = workSteps.filter((st) => st.lane === 'TOOL' && stepStatusMark(st.msg?.toolStatus) === 'failed').length
  return { workSteps, summary: workSummary(thinkCount, toolCount, editCount), failed }
}

/** A turn's open work panel: one row per step, under the header and before the answer. */
export function WorkStepList({
  steps,
  sessionId,
  live
}: {
  steps: readonly FmtStep[]
  sessionId?: string
  live: boolean
}) {
  return (
    <div className="overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-app)">
      {steps.map((st, si) => (
        <WorkStepRow
          // Keyed by tool identity so an open row survives new steps streaming in; THINK rows use the index.
          key={st.msg?.toolCallId ?? `i:${si}`}
          step={st}
          {...(sessionId ? { sessionId } : {})}
          divider={si > 0}
          live={live}
        />
      ))}
    </div>
  )
}
