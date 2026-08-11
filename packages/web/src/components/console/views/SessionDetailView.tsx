'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { liveBotTurnKey, sameBotSpeaker } from '@/lib/bot-turn-grouping'
import { mergeConversation, type MergeSource } from '@/lib/conversation-merge'
import { selfConversationPath } from '@/lib/conversation-addressing'
import { assembleConversationLineage, type ConversationLineage } from '@/lib/conversation-lineage'
import { encodeConversationKey } from '@/lib/conversation-key'
import { unverifiedConversationNotice } from '@/lib/session-access-notifications'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
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
  MOCK_MODE,
  MOCK_PREFIX,
  permissionModeLabel,
  pgPrompts,
  platName,
  preferredModelFor,
  rosterParticipantName,
  runtimeLabel,
  sessionChannelDisplay,
  sessionPlatform,
  speaker,
  status,
  type Agent,
  type Session,
  type SessionImage,
  type SessionStep
} from '@/lib/data'
import {
  ApiError,
  fetchConversationByKey,
  fetchMySessionIdentity,
  fetchSessionMessages,
  fetchSessionDetail,
  fetchToolBody,
  fmtCountCompact,
  fmtDate,
  memberDisplayName,
  mergeSessionDetailUsage,
  sessionFromDto,
  sessionFromDetailDto,
  type SessionProfileProvider,
  type SessionDetailDto,
  type SessionMessageDto,
  type SessionRelationDto,
  type ToolBody
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { agentToneColor } from '@/lib/agent-tone'
import { useProfile } from '@/lib/profile'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { AgentIconView, LoadingState, ModelMark, PlatformMark, SocialLoginMark, Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { NotFound } from '@/components/console/NotFound'
import { Avatar, Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { formatTranscriptRowTime, transcriptRowTimeMs } from '@/lib/transcript-time'
import { sessionResumeMembers, sessionResumeState } from '@/lib/session-resume'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { consoleKeys } from '@/lib/swr-keys'
import {
  sessionAttributionAgentAuthors,
  sessionAttributionAgentId,
  sessionSenderLabel,
  sessionTranscriptAgentIds
} from '@/lib/session-trigger'
import { platformTranscriptOrdering } from '@/components/console/platforms/registry'
import { mergeSessionMessages } from '@/lib/session-transcript'
import { useStickToBottom } from '@/lib/stick-to-bottom'
import { socialLoginProviders } from '@/lib/social-login-providers'
import { isAuthConfigured } from '@/lib/auth'
import { clipboardImageFile, prepareWebchatImage } from '@/lib/webchat-image'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import { ComposerMenu } from '@/components/console/ComposerMenu'
import { MentionMenu, type MentionOption } from '@/components/console/MentionMenu'
import { useMentionAutocomplete } from '@/components/console/useMentionAutocomplete'
import {
  WORK_LANES,
  sessionTurnInFlight,
  toggleWorkPanel,
  workCounts,
  workPanelOpen,
  workSummary
} from '@/components/console/session-work'
import { ApprovalRequestsCard } from '@/components/console/ApprovalRequestsCard'
import { SessionVisibilityControl } from '@/components/console/SessionVisibilityControl'
import { SessionAgentFocusMenu, type SessionAgentFocusOption } from '@/components/console/SessionAgentFocusMenu'
import { useCrumbSlot } from '@/components/console/Shell'
import { DockPanel, SessionDock, SessionDockSlot, type DockTab } from '@/components/console/dock/SessionDock'
import { SessionsPanel, sessionsTabStatus } from '@/components/console/dock/SessionsPanel'
import { FilesPanel, filesTabStatus } from '@/components/console/dock/FilesPanel'
import { GitPanel, gitTabStatus, type GitPanelVerdict } from '@/components/console/dock/GitPanel'
import { SessionViewer, viewerModeFromParam, type ViewerMode } from '@/components/console/viewer/SessionViewer'
import {
  EMPTY_RAIL_AGENT_FILTER,
  railAgentFilterQuery,
  railSeedAgentIds,
  railSeedKey,
  railSeedShouldWiden,
  seedRailAgentFilter,
  type RailAgentFilter
} from '@/lib/session-rail-filter'
import { useSessionList } from '@/lib/use-session-list'
import { isFlatSessionView } from '@/lib/session-list-view'
import { WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'
import {
  sessionEffortAfterModelChange,
  sessionEffortChoicesForSelection,
  sessionPermissionChoices,
  sessionPermissionSelection,
  sessionRuntimeChangesEnabled
} from '@/lib/session-runtime-controls'

type ComposerMenuKey = 'permission' | 'model' | 'effort' | 'addAgent'

// Transcript speech bubbles. Utilities, not globals.css classes (STYLE.md §12) —
// only the theme-dependent numbers live as tokens (`--bubble-*`, defined in both
// theme blocks), so nothing here has to branch on the theme.
//
// AGENT_BUBBLE is tinted with the SPEAKING agent's accent (`--agent-accent`, set per
// turn from lib/agent-tone.ts): the accent is mixed INTO the live surface rather than
// used as a background, which is what lets one hex read correctly in both themes and
// makes a new hue cost one array entry instead of a second colour table. The `var()`
// fallback matters — an invalid var() inside color-mix drops the whole declaration,
// so a turn with no accent gets an indigo-tinted bubble, never an invisible one
// (not --brand: magenta's tint reads as a warning/error banner, see agent-tone.ts).
// AGENT_NAME pulls that accent 62% toward the text colour: gold or green at full
// strength fails contrast on the light surface.
// SELF_BUBBLE is the reader's own, deliberately neutral, tail corner mirrored.
// Full literal strings so Tailwind's scanner sees them (STYLE.md §8).
// The 35px right inset is the user side's mark column (26px avatar + 9px gap): it
// stops a long agent bubble short of where the reader's own avatar sits, so the two
// columns of bubbles share one right edge instead of the bot side running under it.
const AGENT_BUBBLE =
  'w-fit max-w-[calc(100%-35px)] rounded-[12px_12px_12px_4px] border px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary) border-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_var(--bubble-edge),var(--surface-card))] bg-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_var(--bubble-tint),var(--surface-card))]'
const AGENT_NAME =
  'font-sans text-[13px] font-semibold leading-normal text-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_62%,var(--text-primary))]'
const SELF_BUBBLE =
  'max-w-full rounded-[12px_12px_4px_12px] border border-(--bubble-self-edge) bg-(--bubble-self) px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)'

// Design composer selectors (session composer, mirrors HomeView): the model is a
// "pill" with a leading mark, effort/permission are plain chips. Full literal
// strings so Tailwind's scanner sees them (STYLE.md §8).
const COMPOSER_CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
const COMPOSER_CHIP_STATIC =
  'inline-flex h-7 min-w-0 items-center gap-[6px] rounded-md px-[9px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'
const COMPOSER_PILL =
  'inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-mono text-[11.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)'
const COMPOSER_PILL_STATIC =
  'inline-flex h-7 min-w-0 items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-mono text-[11.5px] font-medium leading-normal text-(--text-primary)'

// A conversation whose cross-room lineage has not landed yet. Stable identity so
// the family it feeds is not a new object on every render while the multi-request
// lineage fetch is in flight.
const EMPTY_CONVERSATION_FAMILY: ConversationLineage['family'] = { parentSessions: [], childSessions: [] }

// The "fast" tag shown inside the model pill when fast mode is on.
function FastBadge() {
  return (
    <span className="rounded-sm bg-(--brand-soft) px-[5px] py-px font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-(--brand-soft-text)">
      fast
    </span>
  )
}

// Shared open/dismiss state for the header's hover-or-tap popovers (Details,
// Requests). `tapped` is the touch path: a tap neither hovers nor reliably
// focuses a button (Safari does not focus one on tap), so the mobile triggers
// toggle this latch instead of relying on the desktop hover presence. Escape
// dismisses until every presence signal drops.
function useHeaderPopover() {
  const [state, setState] = useState({ hovered: false, focused: false, tapped: false, dismissed: false })
  const open = (state.hovered || state.focused || state.tapped) && !state.dismissed
  const setPresence = (key: 'hovered' | 'focused', value: boolean) =>
    setState((current) => {
      const next = { ...current, [key]: value }
      return { ...next, dismissed: next.hovered || next.focused || next.tapped ? current.dismissed : false }
    })
  const closeTap = () => setState((current) => ({ ...current, tapped: false, dismissed: false }))
  const toggleTap = () => setState((current) => ({ ...current, tapped: !current.tapped, dismissed: false }))
  // Stable (setState identity), so session-switch reset effects can depend on it.
  const reset = useCallback(() => setState({ hovered: false, focused: false, tapped: false, dismissed: false }), [])
  // Hover does not move focus to the trigger, so Escape has to be observed while
  // the popover is open rather than only on the button.
  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setState((current) => ({ ...current, tapped: false, dismissed: true }))
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [open])
  return { open, setPresence, closeTap, toggleTap, reset }
}

// The composer's textarea, isolated so a keystroke re-renders ONLY this node:
// the draft lives outside the playground context (usePgDraft subscription), and
// SessionDetailView rebuilds the whole transcript on every render — routing
// keystrokes through it made typing lag on long sessions.
function ComposerTextarea({
  sessionId,
  placeholder,
  onSend,
  onImageFile,
  mentionCandidates,
  onPickMention,
  onMentionJoiningChange
}: {
  sessionId: string
  placeholder: string
  onSend: () => void
  onImageFile: (file: File) => void
  mentionCandidates: MentionOption[]
  onPickMention: (option: MentionOption) => void | Promise<boolean>
  /** Mirrors `mention.joining` up to the parent so the (separately isolated)
   *  Send button can disable itself too — see the effect below. */
  onMentionJoiningChange: (joining: boolean) => void
}) {
  const draft = usePgDraft(sessionId)
  const { setPgInput } = usePlayground()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // @mention picker (webchat-multi-agents.md §9.1/§9.2) — same contract as the
  // Home composer's: picking a candidate inserts "@Name " and typedMentionIds()
  // resolves that text back into a structural mention on send.
  const mention = useMentionAutocomplete({
    ref: textareaRef,
    value: draft,
    setValue: (v) => setPgInput(sessionId, v),
    candidates: mentionCandidates,
    onPick: onPickMention
  })
  useEffect(() => onMentionJoiningChange(mention.joining), [mention.joining, onMentionJoiningChange])
  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        className="block max-h-[160px] min-h-[56px] w-full resize-none border-0 bg-transparent px-[15px] pt-[13px] pb-[2px] font-sans text-[14px] leading-[1.55] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          setPgInput(sessionId, e.target.value)
          mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={(e) => {
          // Re-derives the anchor on every caret move, not just typing — see
          // the Home composer's identical handler for why.
          const el = e.currentTarget
          mention.sync(el.value, el.selectionStart ?? el.value.length)
        }}
        onPaste={(event) => {
          const image = clipboardImageFile(event.clipboardData)
          if (!image) return
          event.preventDefault()
          onImageFile(image)
        }}
        onKeyDown={(e) => {
          if (mention.handleKeyDown(e)) return
          // Enter sends — but NOT while an IME is composing (that Enter
          // just confirms the candidate), while a mention join is still in
          // flight (see onMentionJoiningChange), and Shift+Enter is a newline.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !mention.joining) {
            e.preventDefault()
            onSend()
          }
        }}
      />
      <MentionMenu
        options={mention.matches}
        activeIndex={mention.activeIndex}
        coords={mention.coords}
        onHover={mention.setActiveIndex}
        onPick={mention.pick}
      />
    </div>
  )
}

// Send/stop toggle, isolated for the same reason as ComposerTextarea: the
// empty↔non-empty draft flip that enables it must not re-render the whole
// detail view (that rebuilds the transcript, so the FIRST keystroke into an
// empty composer lagged on long sessions).
function ComposerSendButton({
  sessionId,
  busy,
  imagePreparing,
  hasImage,
  mentionJoining,
  onSend,
  onStop
}: {
  sessionId: string
  busy: boolean
  imagePreparing: boolean
  hasImage: boolean
  /** A picked @mention's mid-conversation join is still in flight — see
   *  ComposerTextarea's onMentionJoiningChange for why Send holds off too. */
  mentionJoining: boolean
  onSend: () => void
  onStop: () => void
}) {
  const hasText = usePgDraftHasText(sessionId)
  return (
    <button
      className="sendbtn ml-1 h-[26px] w-[26px] flex-none rounded-[7px]"
      aria-label={busy ? 'Stop response' : 'Send message'}
      onClick={() => (busy ? onStop() : onSend())}
      disabled={!busy && (imagePreparing || mentionJoining || (!hasText && !hasImage))}
    >
      <Icon name={busy ? 'square' : 'arrow-up'} size={busy ? 10 : 14} />
    </button>
  )
}

// One agent-turn step rendered from a real transcript message. Maps the daemon
// transcript kind (text | tool | reasoning) onto the existing lane styling.
function msgStep(m: SessionMessageDto, toolSessionId?: string, platform?: string): FmtStep {
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
      time: formatTranscriptRowTime(m),
      ...(platform ? { platform } : {}),
      // Carry the raw message so the row can render the captured tool body (input /
      // output / content / diff / locations) below the title, on demand.
      ...(m.body ? { msg: m, ...(toolSessionId ? { toolSessionId } : {}) } : {})
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
      time: formatTranscriptRowTime(m),
      ...(platform ? { platform } : {})
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
    time: formatTranscriptRowTime(m),
    ...(platform ? { platform } : {})
  }
}

/** Whether a member-source read failure may surface in the offline notice.
 *  Only a CONFIRMED daemon-offline response counts (the CP answers 503 when
 *  the owning daemon has no connection; 502/504 are its gateway shapes).
 *  Everything else stays silent — above all the authorization answers
 *  (403/404): a visibility change racing the roster snapshot must never
 *  disclose that a protected source exists (§7). */
function countsAsOfflineSource(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 502 || error.status === 503 || error.status === 504)
}

/** Render input for conversation mode: mergeConversation over the CURRENT
 *  per-member row map (merged-conversation-view.md §6). Preserve each row's
 *  object identity while indexing its source out-of-band: ToolBodyDetail uses
 *  exact-row identity to fence a previously fetched full body. */
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
  // A peer participant's message attachment (rendered like the user bubble's).
  image?: SessionImage
  // Present only on real-transcript tool rows that carry a captured body.
  msg?: SessionMessageDto
  // Conversation rows keep their owning session out-of-band so full-body reads
  // do not accidentally target the representative member.
  toolSessionId?: string
  // The platform this row was authored on — the key `MessageText` resolves its
  // renderer under (§10). Per STEP, not per turn or per page: a merged
  // conversation interleaves sources, so neighbouring rows can differ.
  platform?: string
}

// A bare text step (no lane chrome) — how a peer participant's message renders
// inside its agent block.
function plainStep(text: string, time?: string, image?: SessionImage, platform?: string): FmtStep {
  return {
    lane: '',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 400,
    textColor: 'var(--text-primary)',
    codeColor: 'var(--text-secondary)',
    text,
    code: '',
    files: [],
    ...(time ? { time } : {}),
    ...(image ? { image } : {}),
    ...(platform ? { platform } : {})
  }
}

// A daemon background-task wake (`background-task:<taskId>` author, see the
// daemon's deferred-wake dispatch) is agent machinery, not a message from any
// person — it must never render as a right-side human bubble.
function isBgTaskWake(sender: string | undefined | null): boolean {
  return !!sender?.startsWith('background-task:')
}

// A THINK-lane work row built from bare text — how a background-task wake
// renders inside the owner agent's turn (same styling as msgStep's reasoning).
function thinkStep(text: string, time?: string, platform?: string): FmtStep {
  return {
    lane: 'THINK',
    laneColor: 'var(--brand)',
    dot: 'var(--brand)',
    weight: 500,
    textColor: 'var(--text-tertiary)',
    codeColor: 'var(--text-secondary)',
    text,
    code: '',
    files: [],
    ...(time ? { time } : {}),
    ...(platform ? { platform } : {})
  }
}

// Hover-revealed copy-to-clipboard for a FINISHED chat bubble (the call sites
// skip it while the turn streams). Visibility rides the turn container's
// `group/turn` hover, so the affordance stays out of the transcript until
// pointed at; keyboard focus reveals it too.
function CopyTurnButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text)?.catch?.(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      title={copied ? 'Copied' : 'Copy message'}
      className="inline-flex h-[20px] w-[20px] flex-none items-center justify-center rounded-sm border-0 bg-transparent p-0 text-(--text-tertiary) opacity-0 transition-opacity hover:text-(--text-secondary) focus-visible:opacity-100 group-hover/turn:opacity-100 max-desktop:opacity-100"
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  )
}

// A step's non-text extras (code block, file chips, captured tool body) — rendered
// identically in a turn's plain answer and in its collapsed "work" rows.
function StepExtras({ step, sessionId }: { step: FmtStep; sessionId?: string }) {
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
      {step.msg && toolSessionId && <ToolBodyDetail msg={step.msg} sessionId={toolSessionId} />}
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
    const t = transcriptRowTimeMs(m)
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

function fmtStep(stp: SessionStep, platform?: string): FmtStep {
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
    time: stp.time ?? '',
    ...(platform ? { platform } : {}),
    // The live wire frame carries no body (kept off the hot path); attach just
    // enough of a SessionMessageDto shape for ToolBodyDetail to pull the same
    // full body a history row shows, via `fetchToolBody` (no inline preview yet,
    // so it fetches on open rather than rendering one immediately).
    ...(stp.kind === 'tool' && stp.toolCallId
      ? {
          msg: {
            seq: 0,
            sender: '',
            ts: '',
            kind: 'tool',
            text: stp.text,
            toolCallId: stp.toolCallId,
            toolStatus: stp.toolStatus
          } satisfies SessionMessageDto,
          // A member participant's call lives in ITS daemon session, not the
          // row's primary — carry it so StepExtras targets the right session.
          ...(stp.toolSessionId ? { toolSessionId: stp.toolSessionId } : {})
        }
      : {})
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

  // A same-seq live update replaces `msg` with a fresher preview; fence the fetched
  // full body against the (toolCallId, preview) it was fetched under so an older
  // full response can never mask the new preview. Compared by CONTENT, not object
  // identity: a live-streamed step rebuilds its `msg` on every render (fmtStep), so
  // an identity fence would discard the fetch the moment the next chunk repaints.
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

  // Live-only refresh: a fetched body is a point-in-time snapshot of a still-running
  // call (rawOutput lands only on completion). The streamed tool_update flips
  // `msg.toolStatus`; use that as the refetch signal so an open panel fills in the
  // OUTPUT without waiting for the turn-end transcript reconciliation. Persisted
  // rows (msg.body present) keep their own preview lifecycle and never refetch here.
  const liveStale =
    open &&
    !loading &&
    msg.body == null &&
    full != null &&
    full.source.toolCallId === msg.toolCallId &&
    full.source.toolStatus !== msg.toolStatus
  useEffect(() => {
    if (liveStale) loadFull()
    // loadFull is redefined per render (plain closure); liveStale already gates the
    // refetch to one flip per status change, so it is deliberately the only dep.
  }, [liveStale])

  // A live step carries no inline preview at all (the hot-path frame never ships
  // one) — opening it has nothing to show yet, so fetch the full body the same
  // way the "View full" affordance does for a truncated persisted preview.
  const toggle = () => {
    if (!open && bodyStr == null) {
      loadFull()
      return
    }
    setOpen((o) => !o)
  }

  return (
    <div className="mt-[6px]">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={toggle}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)"
        >
          {loading ? <Spinner size={13} /> : <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
          {open ? 'Hide detail' : 'View detail'}
        </button>
        {err && bodyStr == null && (
          <span className="font-sans text-[10.5px] font-medium leading-normal text-(--red-600)">{err}</span>
        )}
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
      avatarInitials?: string
      sourceLabel: string
      time: string
      text: string
      image?: SessionImage
      isCron: boolean
      cronId: string | null
      /** The platform this message was authored on — see `FmtStep.platform`. */
      platform?: string
    }
  // `wake` marks a block opened by a background-task wake that no reply has
  // merged into yet — the run that follows binds to it, then clears the flag.
  | { kind: 'bot'; agentName: string; agentId?: string; model: string; time: string; steps: FmtStep[]; wake?: boolean }

type SessionParticipant = {
  id: string
  sp: ReturnType<typeof speaker>
  agent: Agent | null
  avatarUrl?: string | null
  avatarInitials?: string
  isCron: boolean
}

/** Whether a user turn prints a sender line above its bubble — it does only when the
 *  sender is not you (a platform user or a schedule). Shared with the avatar's
 *  alignment, which follows the label when there is one and the bubble when not. */
function showsSenderLabel(turn: { isCron: boolean; sp: { handle: string } }): boolean {
  return turn.isCron || turn.sp.handle !== '@you'
}

function ParticipantAvatar({
  agent,
  avatarUrl,
  avatarInitials,
  platformMark,
  sp,
  isCron,
  className = ''
}: {
  agent: Agent | null
  avatarUrl?: string | null
  avatarInitials?: string
  platformMark?: string
  sp: ReturnType<typeof speaker>
  isCron: boolean
  /** Caller-side box tweaks — today only the transcript's vertical nudge. */
  className?: string
}) {
  return (
    <span
      className={`av flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md font-sans text-[9.5px] font-semibold leading-normal ${
        !agent && !isCron ? 'bg-transparent' : ''
      } ${className}`}
      title={sp.name}
    >
      {agent ? (
        <AgentIconView icon={agent.icon} runtime={agent.runtime} size={26} />
      ) : isCron ? (
        <Icon name="calendar-clock" size={14} color="var(--text-secondary)" />
      ) : platformMark && !avatarUrl && !avatarInitials ? (
        <span
          className="flex h-full w-full items-center justify-center rounded-[inherit]"
          style={{ background: sp.avBg, color: sp.avText }}
        >
          <PlatformMark platform={platformMark} />
        </span>
      ) : (
        <Avatar
          src={avatarUrl}
          initials={avatarInitials || sp.initials || '?'}
          size={26}
          bg={sp.avBg}
          fg={sp.avText}
          fontSize={9.5}
        />
      )}
    </span>
  )
}

function SessionHumanFaces({ participants }: { participants: SessionParticipant[] }) {
  const names = participants.map((participant) => participant.sp.name)
  return (
    <span
      role="group"
      className="flex flex-none items-center -space-x-[5px]"
      aria-label={`People: ${names.join(', ')}`}
    >
      {participants.map((participant) => (
        <span
          key={participant.id}
          title={participant.sp.name}
          className="inline-flex flex-none rounded-full border-[1.5px] border-(--surface-card)"
        >
          <Avatar
            src={participant.avatarUrl}
            initials={participant.avatarInitials || participant.sp.initials || '?'}
            size={24}
            bg={participant.sp.avBg}
            fg={participant.sp.avText}
            fontSize={9}
          />
        </span>
      ))}
    </span>
  )
}

function SessionRelationLink({
  relation,
  agent,
  orgPath,
  flatView = false,
  bordered = false
}: {
  relation: SessionRelationDto
  agent?: Agent
  orgPath: (path: string) => string
  flatView?: boolean
  bordered?: boolean
}) {
  const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
  const agentName = agent ? agentLabel(agent) : (relation.agentName ?? relation.agentId)
  return (
    <Link
      href={orgPath(`/sessions/${encodeURIComponent(relation.id)}${flatView ? '?view=flat' : ''}`)}
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

function MobileSessionFamilyLinks({
  parents,
  siblings,
  children,
  agentById,
  orgPath,
  conversation = false,
  flatView = false,
  childOriginById
}: {
  /** Whatever woke this page. A session has at most one parent; a merged
   *  conversation has one per member woken from another room, and they are all
   *  parents — none of them is a sibling of anything. */
  parents: SessionRelationDto[]
  /** LINEAGE siblings: the other children of this session's parent. A
   *  conversation has no such relation and passes none. */
  siblings: SessionRelationDto[]
  children: SessionRelationDto[]
  agentById: ReadonlyMap<string, Agent>
  orgPath: (path: string) => string
  /** Conversation-level lineage (merged-conversation-view.md §9.2): relabels
   *  the sections and groups delegations by their waking member. */
  conversation?: boolean
  flatView?: boolean
  /** Delegation target id → waking member agentId (conversation mode). */
  childOriginById?: ReadonlyMap<string, string>
}) {
  if (parents.length === 0 && siblings.length === 0 && children.length === 0) return null
  return (
    <div className="card mx-4 mt-4 overflow-hidden desktop:hidden">
      {parents.length > 0 && (
        <div
          className={`grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4 ${
            siblings.length > 0 || children.length > 0 ? 'border-b border-(--border-subtle)' : ''
          }`}
        >
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            {conversation
              ? parents.length === 1
                ? 'Parent conversation'
                : `Parent conversations (${parents.length})`
              : 'Parent session'}
          </span>
          <div className="min-w-0">
            {parents.map((parent, index) => (
              <SessionRelationLink
                key={parent.id}
                relation={parent}
                agent={agentById.get(parent.agentId)}
                orgPath={orgPath}
                flatView={flatView}
                bordered={index > 0}
              />
            ))}
          </div>
        </div>
      )}
      {siblings.length > 0 && (
        <div
          className={`grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4 ${
            children.length > 0 ? 'border-b border-(--border-subtle)' : ''
          }`}
        >
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            {siblings.length === 1 ? 'Sibling session' : `Sibling sessions (${siblings.length})`}
          </span>
          <div className="min-w-0">
            {siblings.map((sibling, index) => (
              <SessionRelationLink
                key={sibling.id}
                relation={sibling}
                agent={agentById.get(sibling.agentId)}
                orgPath={orgPath}
                flatView={flatView}
                bordered={index > 0}
              />
            ))}
          </div>
        </div>
      )}
      {children.length > 0 && (
        <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-4">
          <span className="py-[10px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
            {conversation
              ? children.length === 1
                ? 'Delegation'
                : `Delegations (${children.length})`
              : children.length === 1
                ? 'Child session'
                : `Child sessions (${children.length})`}
          </span>
          <div className="min-w-0">
            {children.map((child, index) => {
              const origin = childOriginById?.get(child.id)
              const previousOrigin = index > 0 ? childOriginById?.get(children[index - 1]!.id) : undefined
              const originAgent = origin ? agentById.get(origin) : undefined
              const newGroup = origin !== undefined && origin !== previousOrigin
              return (
                <div key={child.id}>
                  {newGroup && (
                    <div className="pt-[8px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-(--text-tertiary)">
                      via {originAgent ? agentLabel(originAgent) : origin}
                    </div>
                  )}
                  <SessionRelationLink
                    relation={child}
                    agent={agentById.get(child.agentId)}
                    orgPath={orgPath}
                    flatView={flatView}
                    bordered={index > 0 && !newGroup}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** The dock's tabs. PR / Tasks are each one more entry (§9), not a stub; Sessions' §1 `plus` action awaits a new-session flow. */
const DOCK_TABS: DockTab[] = [
  { key: 'sessions', label: 'Sessions', icon: 'messages-square' },
  { key: 'files', label: 'Files', icon: 'folder-tree', actionIcon: 'refresh-cw', actionLabel: 'Refresh files' },
  {
    key: 'git',
    label: 'Git',
    icon: 'git-commit-horizontal',
    actionIcon: 'refresh-cw',
    actionLabel: 'Refresh git status'
  }
]

/** Loading keeps the same dock + body tracks as the transcript; a resolved 404 opts out, so its card gets the whole content wrap. */
function SessionDetailFrame({ children, withDock = true }: { children: ReactNode; withDock?: boolean }) {
  return (
    <div className="flex min-h-full items-stretch gap-[26px]">
      <div
        className={
          withDock
            ? 'mx-auto flex min-h-full min-w-0 max-w-[880px] flex-1 flex-col max-desktop:p-4'
            : 'flex min-h-full min-w-0 flex-1 flex-col max-desktop:p-4'
        }
      >
        {children}
      </div>
      {withDock ? <SessionDockSlot /> : null}
    </div>
  )
}

function sessionUnavailableReasons(providerName: string | undefined, profileLinked: boolean | undefined): string[] {
  if (!providerName) {
    return ['The session doesn’t exist or has been removed.']
  }
  if (profileLinked === false) {
    return ['The session doesn’t exist or has been removed.', `Your ${providerName} profile isn’t linked.`]
  }
  if (profileLinked === true) {
    return [
      'The session doesn’t exist or has been removed.',
      `Your linked ${providerName} profile belongs to a different workspace.`
    ]
  }
  return [
    'The session doesn’t exist or has been removed.',
    `Your ${providerName} profile isn’t linked or belongs to a different workspace.`
  ]
}

export default function SessionDetailView() {
  const acpRegistry = useAcpRegistry()
  const { activeOrg, orgPath } = useOrgs()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const flatView = isFlatSessionView(searchParams)
  const { id: routeId, key: conversationKeyParam } = useParams<{ id?: string; key?: string }>()
  // Which file the viewer holds, and the ONLY place that answer lives (§4): "look at this file" is a link a reviewer sends, so the pane mode is addressable and survives a reload. Derived from the route rather than mirrored into state — that is also what makes it per-session for free, since a session link carries no `file`.
  // NOT trimmed: a POSIX filename may legitimately begin or end with whitespace, and `URLSearchParams` round-trips those bytes faithfully — trimming would ask the daemon for a different file, or close the viewer outright on a name made only of spaces. Only an absent or empty param means "no file".
  const viewerPath = searchParams.get('file') || null
  // Which workspace that path was read from. A merged conversation's header focus is component state that defaults to the current REPRESENTATIVE, and the representative changes as another participant becomes newest — so without this a link copied while focused on agent B reopens B's path against A's checkout.
  const viewerAgentParam = searchParams.get('agent')
  // Which read of that path is on screen (§4's M2 addition to the same param set): the file, its unstaged diff, or its staged diff. A value this console does not know degrades to File mode — the one read every workspace can answer — rather than to an error.
  const viewerMode = viewerModeFromParam(searchParams.get('mode'))
  // REPLACE, never push. The viewer is a pane mode inside one route, not a place: pushing would spend a history entry per tree click, so a reader who read six files would need seven Back presses to leave the session, and Back would stop meaning "leave this session". The cost, accepted: Back does not step file-by-file within a visit. Writing through URLSearchParams is also what makes a path with slashes and spaces round-trip — `router.replace` on `.toString()`, `searchParams.get` back.
  const setViewerFile = useCallback(
    (next: string | null, agentId?: string | null, mode: ViewerMode = 'file') => {
      const query = new URLSearchParams(searchParams)
      if (next) query.set('file', next)
      else query.delete('file')
      // The workspace travels with the path, so the link resolves to the checkout it was made from rather than to whichever agent the header happens to focus on reopening.
      if (next && agentId) query.set('agent', agentId)
      else query.delete('agent')
      // File mode is the DEFAULT, so it writes no parameter at all: an M1 link stays byte-identical, and closing the viewer takes the mode with the path rather than leaving a mode behind for the next file opened.
      if (next && mode !== 'file') query.set('mode', mode)
      else query.delete('mode')
      const search = query.toString()
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )
  // Merged conversation mode (merged-conversation-view.md §5.3): /conversations/:key
  // resolves the roster through the bounded key-addressed resolver; the
  // REPRESENTATIVE (newest visible member) then drives every session-scoped
  // affordance below — detail metadata, live adoption, the composer target —
  // exactly like a /sessions/:id load. Peer members only feed the transcript
  // fan-out and the participants roster.
  const conversationKey = conversationKeyParam ? decodeURIComponent(conversationKeyParam) : null
  const {
    data: conversationResolution,
    error: conversationError,
    isLoading: conversationLoading,
    mutate: retryConversation
  } = useSWR(
    conversationKey && activeOrg?.id ? (['conversation-by-key', activeOrg.id, conversationKey] as const) : null,
    ([, orgId, key]) => fetchConversationByKey(key, orgId)
  )
  // Unwrap to the roster the rest of this view reads, keeping the two states it
  // distinguishes: `undefined` is still "in flight", `null` still "the resolver
  // answered with nothing". Degradation rides alongside rather than collapsing
  // into either — an empty answer the CP could not verify is not an absence.
  const conversationRoster = conversationResolution === undefined ? undefined : conversationResolution.conversation
  const conversationAccessDegraded = conversationResolution?.accessSyncDegraded === true
  // Why it could not be verified, which decides whether the blocked state below
  // is worth retrying or worth acting on.
  const conversationAccessIssues = conversationResolution?.accessIssues ?? []
  const conversationMembers = conversationKey ? (conversationRoster?.sessions ?? null) : null
  const id = conversationKey ? (conversationMembers?.[0]?.sessionId ?? '') : (routeId ?? '')
  const conversationSourceKey =
    conversationMembers
      ?.map((m) => m.sessionId)
      .sort()
      .join(',') ?? ''
  // Conversation-level lineage lift (merged-conversation-view.md §9.2): union
  // the members' parent/child links, keep the ones worth drawing, and link
  // targets as /sessions/:id — the §5.3 self-redirect forwards
  // multi-participant targets to THEIR merged page. Each lifted delegation
  // preserves its waking member so the UI groups delegations by origin.
  //
  // §9.2 originally dropped every intra-room edge, on the reasoning that both
  // ends are already merged into this transcript. They are — but the transcript
  // interleaves them by TIME, so the one thing it cannot show is which of them
  // woke the other. That left the delegation structure visible only by
  // accident: a roster that came back short (a member failed closed by a
  // degraded access check) flipped `conversationMode` off, and the family prop
  // fell through to the representative's own unfiltered detail — so the same
  // conversation showed lineage or not depending on how many members happened
  // to resolve. Keeping participant edges makes the answer the same either way.
  const conversationMode = !!conversationKey && (conversationMembers?.length ?? 0) > 1
  const { data: conversationLineage, error: conversationLineageError } = useSWR(
    conversationMode && activeOrg?.id
      ? (['conversation-lineage', activeOrg.id, conversationKey, conversationSourceKey] as const)
      : null,
    async ([, orgId]) => {
      const details = await Promise.all(
        (conversationMembers ?? []).map((member) => fetchSessionDetail(member.sessionId, orgId).catch(() => null))
      )
      // Location lookup: fetch each candidate target's own conversation key so
      // the assembly below can tell navigation (elsewhere) from attribution
      // (a fellow participant). A target whose detail can't be read is dropped
      // — fail closed, the caller couldn't open it anyway.
      const candidateIds = [
        ...new Set(
          details.flatMap((detail) =>
            detail
              ? [...(detail.parentSession ? [detail.parentSession.id] : []), ...detail.childSessions.map((c) => c.id)]
              : []
          )
        )
      ]
      // Three-way sentinel: an encoded key, 'singleton' (readable target with
      // no groupable channel/thread — necessarily cross-conversation relative
      // to this merged page), or 'unreadable' (fail closed).
      const targetKeys = new Map<
        string,
        { kind: 'key'; key: string } | { kind: 'singleton' } | { kind: 'unreadable' }
      >()
      await Promise.all(
        candidateIds.map(async (targetId) => {
          try {
            const target = await fetchSessionDetail(targetId, orgId)
            const key = encodeConversationKey({
              platform: target.platform ?? 'slack',
              tenantScope: target.tenantScope ?? null,
              channel: target.channel,
              thread: target.thread
            })
            targetKeys.set(targetId, key === null ? { kind: 'singleton' } : { kind: 'key', key })
          } catch {
            targetKeys.set(targetId, { kind: 'unreadable' })
          }
        })
      )
      return assembleConversationLineage({
        conversationKey,
        members: conversationMembers ?? [],
        details,
        targetLocations: targetKeys
      })
    },
    { revalidateOnFocus: false }
  )
  // Conversation mode NEVER falls back to the representative's raw family —
  // an empty aggregate means "no cross-room edges", not "show the intra-room
  // links the filter just removed".
  const conversationFamily = conversationMode ? (conversationLineage?.family ?? EMPTY_CONVERSATION_FAMILY) : undefined
  const {
    agents,
    allSessions,
    getSessions,
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
    getBusyLaneAgentIds,
    reconcileLiveSteps,
    getPgImage,
    getPgWorktree,
    isPgBusy,
    setPgImage,
    pgSend,
    getPgQueue,
    pgCancelQueued,
    pgAddAgent,
    pgSetModel,
    pgSetEffort,
    pgSetPermissionPreset,
    pgSetFast,
    pgSetWorktree,
    pgCancel
  } = usePlayground()
  const { user: viewer, me } = useProfile()
  const [copied, setCopied] = useState(false)
  const detailTooltipId = useId()
  const requestsTooltipId = useId()
  const {
    open: detailOpen,
    setPresence: updateDetailPresence,
    closeTap: closeDetailTap,
    toggleTap: toggleDetailTap,
    reset: resetDetailPopover
  } = useHeaderPopover()
  const requestsPopover = useHeaderPopover()
  const [msgs, setMsgs] = useState<SessionMessageDto[] | null>(null)
  // Conversation mode: per-member fetched rows + live cursors; the rendered
  // transcript is always mergeConversation() over the CURRENT map, so every
  // update path (initial load, tail pages) stays consistent by construction.
  const conversationSourcesRef = useRef<{
    rows: Map<string, SessionMessageDto[]>
    cursors: Map<string, string | null>
    older: Map<string, string | null>
  }>({ rows: new Map(), cursors: new Map(), older: new Map() })
  const conversationSourceSessionByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  const conversationSourceTurnByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  // Each merged row's OWN platform (§10) — the key its text renderer resolves
  // under. Out-of-band like the two above so the row objects keep their
  // identity, and per row because sources interleave by event time.
  const conversationSourcePlatformByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  // Owning member agent of a merged-conversation row — a background-task wake
  // from a peer member must render as THAT agent's work, not the representative's.
  const conversationSourceAgentByMessageRef = useRef(new WeakMap<SessionMessageDto, string>())
  const [conversationHasEarlier, setConversationHasEarlier] = useState(false)
  const [conversationPagingEarlier, setConversationPagingEarlier] = useState(false)
  // Which conversation key the CURRENT fan-out state belongs to — the focus
  // effect's readiness signal. Null while a (new) key is loading, so a
  // key-to-key navigation in the persistent layout can never act on the
  // previous conversation's leftover msgs/cursors.
  const [conversationLoadedKey, setConversationLoadedKey] = useState<string | null>(null)
  // A resolver NULL that persists past the grace window is a real not-found
  // (invisible or nonexistent, indistinguishable by design §7); within it,
  // null is treated as still-loading so a just-created conversation racing
  // event/session sync never flashes a premature not-found.
  const [conversationUnresolved, setConversationUnresolved] = useState(false)
  useEffect(() => {
    if (!conversationKey || conversationRoster !== null) {
      setConversationUnresolved(false)
      return
    }
    const timer = window.setTimeout(() => setConversationUnresolved(true), 15_000)
    return () => window.clearTimeout(timer)
  }, [conversationKey, conversationRoster])
  const conversationMembersRef = useRef<{ sessionId: string; agentId: string; platform: string }[] | null>(null)
  // Merge sources in CANONICAL order — sessionId sort, decoupled from the
  // resolver's representative-first response, whose activity-based order is
  // mutable: a 30s roster refresh must never swap which recipient copy wins
  // the first-source rule in mergeConversation().
  conversationMembersRef.current = conversationMembers
    ? [...conversationMembers]
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
        .map((m) => ({
          sessionId: m.sessionId,
          agentId: m.agentId ?? '',
          platform: conversationRoster?.platform ?? 'slack'
        }))
    : null
  const [conversationOffline, setConversationOffline] = useState(0)
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgPaging, setMsgPaging] = useState(false)
  const [msgErr, setMsgErr] = useState<string | null>(null)
  const [tailReady, setTailReady] = useState(false)
  const [transcriptSessionId, setTranscriptSessionId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The visibility the user last chose for a bot turn's collapsed "work" panel (keyed
  // by turn index). Every panel starts collapsed — streaming included — see
  // workPanelOpen(). The toggle records the opposite of the EFFECTIVE on-screen state.
  const [workOverride, setWorkOverride] = useState<ReadonlyMap<number, boolean>>(() => new Map())
  const toggleWork = (ti: number, currentOpen: boolean) =>
    setWorkOverride((prev) => toggleWorkPanel(prev, ti, currentOpen))
  const [imagePreparing, setImagePreparing] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [composerMenuOpen, setComposerMenuOpen] = useState<ComposerMenuKey | null>(null)
  // Mirrors ComposerTextarea's mention.joining (isolated from this component
  // to keep typing cheap) — true while a picked @mention's mid-conversation
  // join is still in flight, so the separately-isolated Send button can
  // disable itself for the same reason ComposerTextarea holds off Enter-send.
  const [mentionJoining, setMentionJoining] = useState(false)
  const [runtimeSelections, setRuntimeSelections] = useState<
    Record<string, { model?: string; effort?: string; permissionPreset?: string; fast?: boolean }>
  >({})
  const [worktreeSelections, setWorktreeSelections] = useState<Record<string, boolean>>({})
  // A rail row already carries enough metadata to paint the next session while
  // its detail/transcript requests catch up. Keeping it here also holds the
  // agent-filtered rail steady instead of briefly dropping it between ids.
  const [routeSession, setRouteSession] = useState<Session | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imagePrepareGenerationRef = useRef(0)
  const liveCursorRef = useRef<string | null>(null)
  const tailSessionRef = useRef<string | null>(null)
  const tailReadyRef = useRef(false)
  const tailInFlightRef = useRef<Promise<void> | null>(null)
  const tailDirtyRef = useRef(false)

  const localSession =
    getPgSession(id) ??
    allSessions.find((s) => s.id === id) ??
    (routeSession && (routeSession.id === id || routeSession.realSessionId === id) ? routeSession : null)
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
    error: sessionDetailError,
    isLoading: sessionDetailLoading,
    mutate: mutateSessionDetail
  } = useSWR<SessionDetailDto>(consoleKeys.sessionDetail(activeOrg?.id, detailId), ([, orgId, , sessionId]) =>
    fetchSessionDetail(sessionId as string, orgId as string)
  )
  // Provider-rendered links use `source`; links opened from the Sessions list
  // can also retain its `integration` filter. Both are caller-known hints only:
  // neither changes authorization, so unknown and unauthorized 404s stay
  // equivalent.
  const source = searchParams.get('source')
  const integration = searchParams.get('integration')
  const profileProviderHint = (value: string | null): SessionProfileProvider | undefined =>
    value === 'slack' || value === 'github' || value === 'lark' || value === 'feishu' ? value : undefined
  const hintedProvider = profileProviderHint(source) ?? profileProviderHint(integration)
  const profileLinkProvider =
    hintedProvider && socialLoginProviders().some((provider) => provider.target === hintedProvider)
      ? hintedProvider
      : undefined
  const profileLinkProviderName = socialLoginProviders().find(
    (provider) => provider.target === profileLinkProvider
  )?.name
  // Start the caller's identity lookup as soon as the provider hint is known,
  // alongside the session request. The hint still affects presentation only:
  // the recovery action cannot render until the protected session read is a 404.
  const profileIdentityProvider = isAuthConfigured() ? profileLinkProvider : undefined
  const {
    data: profileIdentity,
    error: profileIdentityError,
    isLoading: profileIdentityLoading
  } = useSWR(
    profileIdentityProvider ? (['logto-session-identity', profileIdentityProvider] as const) : null,
    ([, provider]) => fetchMySessionIdentity(provider),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false
    }
  )
  const profileLinkCandidate =
    sessionDetailError instanceof ApiError && sessionDetailError.status === 404 && profileIdentityProvider !== undefined
  const profileIdentityReady =
    profileLinkCandidate &&
    !profileIdentityLoading &&
    profileIdentityError === undefined &&
    profileIdentity !== undefined
  const profileLinked = profileIdentityReady ? profileIdentity.linked : undefined
  const profileNeedsLink = profileLinked === false
  const unavailableReasons = sessionUnavailableReasons(profileLinkProviderName, profileLinked)
  // SWR normally clears data when its key changes. Keep the id check explicit
  // because this view now persists across route ids and must never merge a
  // retained previous snapshot into the newly selected rail row.
  const currentSessionDetail = sessionDetail?.id === detailId ? sessionDetail : null
  const detailSession = currentSessionDetail ? sessionFromDetailDto(currentSessionDetail) : null
  // The cursor-loaded list row can predate the final Dream usage report. Keep
  // its local/live fields, but let the independently refreshed detail snapshot
  // supply the authoritative per-session token and cost totals.
  const sessionMerged = localSession ? mergeSessionDetailUsage(localSession, detailSession) : detailSession
  // The conversation roster only exists on the detail snapshot (list rows and
  // adopted local state don't carry it); a live playground session's own roster
  // (which tracks mid-conversation joins) stays authoritative when present.
  // Conversation mode synthesizes the roster from the resolver's members when
  // the detail snapshot carries none (Slack threads have no explicit roster);
  // names resolve at render time from the org agent list.
  const conversationParticipants =
    conversationKey && conversationMembers && conversationMembers.length > 1
      ? conversationMembers.map((m, i) => ({
          agentId: m.agentId ?? '',
          name: m.agentId ?? '',
          ...(i === 0 ? { primary: true } : {})
        }))
      : null
  const rosterParticipants = detailSession?.participants ?? conversationParticipants ?? undefined
  const sessionBase =
    sessionMerged && !sessionMerged.participants && rosterParticipants
      ? { ...sessionMerged, participants: rosterParticipants }
      : sessionMerged
  // Session mode: does this session belong to a multi-participant conversation?
  // One bounded resolver probe per detail view (same SWR cache family as
  // conversation mode). A normal route redirects on a hit (§5.3); the diagnostic
  // flat route stays put but still needs the full roster for safe resume gating.
  const selfKey = useMemo(() => {
    if (conversationKey || !currentSessionDetail || currentSessionDetail.platform === 'playground') {
      return null
    }
    return encodeConversationKey({
      platform: currentSessionDetail.platform ?? 'slack',
      tenantScope: currentSessionDetail.tenantScope ?? null,
      channel: currentSessionDetail.channel,
      thread: currentSessionDetail.thread
    })
  }, [conversationKey, currentSessionDetail])
  const { data: selfConversationResolution, isLoading: selfConversationLoading } = useSWR(
    selfKey && activeOrg?.id ? (['conversation-by-key', activeOrg.id, selfKey] as const) : null,
    ([, orgId, key]) => fetchConversationByKey(key, orgId),
    { revalidateOnFocus: false }
  )
  // Same unwrap as the conversation-mode roster above: `undefined` stays
  // in-flight, so the §5.3 redirect still waits rather than reading a probe that
  // has not answered as a single-participant thread.
  const selfConversation =
    selfConversationResolution === undefined ? undefined : selfConversationResolution.conversation
  const selfConversationPathname = selfConversationPath({
    flatView,
    conversationKey: selfKey,
    memberCount: selfConversation?.sessions.length ?? 0
  })
  const selfConversationRedirect = selfConversationPathname ? orgPath(selfConversationPathname) : null
  useEffect(() => {
    if (selfConversationRedirect) router.replace(selfConversationRedirect)
  }, [selfConversationRedirect, router])
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const owner = sessionBase?.agentId ? agentById.get(sessionBase.agentId) : undefined
  const session =
    sessionBase && !localSession
      ? {
          ...sessionBase,
          agentName: owner ? agentLabel(owner) : (sessionBase.agentName ?? sessionBase.agentId),
          model: sessionBase.model ?? (sessionBase.runtime ? '' : (owner?.model ?? '—')),
          runtime: sessionBase.runtime ?? owner?.runtime ?? '',
          daemon: sessionBase.daemon ?? owner?.daemon
        }
      : sessionBase
  const agentRuntime = session?.runtime || owner?.runtime || ''

  // The lineage links the Sessions panel and the mobile card draw, in their three levels rather than either source's wire shape: what woke the open row, the row itself, what it woke.
  // A conversation contributes no lineage SIBLINGS: "the other children of my parent session" is a per-session fact the CP derives and a room has no version of, so the slot stays absent rather than carrying this page's additional parent conversations under a name that means something else — those are parents and render as parents.
  const familyLinks = useMemo(() => {
    if (conversationFamily) {
      return { parentSessions: conversationFamily.parentSessions, childSessions: conversationFamily.childSessions }
    }
    if (!currentSessionDetail || currentSessionDetail.id !== session?.id) return undefined
    return {
      parentSessions: currentSessionDetail.parentSession ? [currentSessionDetail.parentSession] : [],
      siblingSessions: currentSessionDetail.siblingSessions ?? [],
      childSessions: currentSessionDetail.childSessions
    }
  }, [conversationFamily, currentSessionDetail, session?.id])

  // A non-flat single-session transcript can contain messages from visible A2A
  // relatives without becoming a same-coordinate merged conversation. Surface
  // only related Agents that actually authored a row here; unrelated lineage
  // stays out of the focus menu, while `view=flat` keeps the owning Agent alone.
  const relatedTranscriptAgentIds = useMemo(
    () =>
      !flatView && !conversationKey && transcriptSessionId === id && msgs
        ? sessionTranscriptAgentIds(session?.platform ?? '', msgs, agentById)
        : new Set<string>(),
    [agentById, conversationKey, flatView, id, msgs, session?.platform, transcriptSessionId]
  )

  // Header focus is presentation-only: it selects which participant owns the
  // Workspace, Visibility, and Details affordances without changing the merged
  // transcript or the conversation-wide composer target.
  const headerFocusOptions = useMemo<
    Array<SessionAgentFocusOption & { sessionId?: string; snapshot?: Session }>
  >(() => {
    const candidates: Array<{ agentId: string; name?: string; sessionId?: string; snapshot?: Session }> = []
    if (conversationMembers?.length) {
      for (const member of conversationMembers) {
        candidates.push({
          agentId: member.agentId,
          name: member.agentName ?? undefined,
          sessionId: member.sessionId,
          snapshot: sessionFromDto(member)
        })
      }
    } else if (session?.participants?.length) {
      for (const participant of session.participants) {
        candidates.push({
          agentId: participant.agentId,
          name: participant.name,
          ...(participant.agentId === session.agentId
            ? { sessionId: session.realSessionId ?? session.id, snapshot: session }
            : {})
        })
      }
    } else if (session?.agentId) {
      candidates.push({
        agentId: session.agentId,
        name: session.agentName,
        sessionId: session.realSessionId ?? session.id,
        snapshot: session
      })
    }

    if (!flatView && !conversationKey && currentSessionDetail) {
      const related = [
        currentSessionDetail.parentSession,
        ...(currentSessionDetail.siblingSessions ?? []),
        ...currentSessionDetail.childSessions
      ]
      for (const relation of related) {
        if (!relation || !relatedTranscriptAgentIds.has(relation.agentId)) continue
        candidates.push({
          agentId: relation.agentId,
          name: relation.agentName ?? undefined,
          sessionId: relation.id
        })
      }
    }

    const seen = new Set<string>()
    return candidates.flatMap((candidate) => {
      if (!candidate.agentId || seen.has(candidate.agentId)) return []
      seen.add(candidate.agentId)
      const agent = agentById.get(candidate.agentId)
      const label = rosterParticipantName(candidate, agent)
      return [
        {
          agentId: candidate.agentId,
          label,
          ...(agent ? { href: orgPath(`/agents/${candidate.agentId}`) } : {}),
          avatar: (
            <AgentIconView
              icon={agent?.icon}
              runtime={agent?.runtime || candidate.snapshot?.runtime || candidate.snapshot?.model || ''}
              size={18}
            />
          ),
          ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
          ...(candidate.snapshot ? { snapshot: candidate.snapshot } : {})
        }
      ]
    })
  }, [
    agentById,
    conversationKey,
    conversationMembers,
    currentSessionDetail,
    flatView,
    orgPath,
    relatedTranscriptAgentIds,
    session
  ])
  // The persistent layout survives route-to-route navigation without remounting
  // this view. Scope the selection to the current route target so it supersedes
  // the last explicit menu choice, while ordinary rerenders keep the selection.
  const headerFocusScope = conversationKey ?? session?.id ?? id
  const headerFocusOptionIds = headerFocusOptions.map((option) => option.agentId).join('|')
  const defaultHeaderFocusAgentId = session?.agentId ?? headerFocusOptions[0]?.agentId ?? ''
  const [headerFocusSelection, setHeaderFocusSelection] = useState({ scope: '', agentId: '' })
  const storedHeaderFocusValid =
    headerFocusSelection.scope === headerFocusScope &&
    headerFocusOptions.some((option) => option.agentId === headerFocusSelection.agentId)
  // A deep link's `agent` outranks both the stored selection and the default while it names an agent this conversation actually has.
  const linkedFocusAgentId =
    viewerAgentParam && headerFocusOptions.some((option) => option.agentId === viewerAgentParam)
      ? viewerAgentParam
      : null
  // An `agent` that is PRESENT but does not resolve fails CLOSED. Falling back to the default here would read the linked path from a different checkout and draw plausible-but-wrong content — exactly the ambiguity this parameter exists to remove. Only a link without `agent` at all gets the legacy default. Held until the roster has options, since an empty list means "not known yet", not "not there".
  const linkedFocusStale = viewerAgentParam !== null && linkedFocusAgentId === null && headerFocusOptions.length > 0
  const headerFocusAgentId =
    linkedFocusAgentId ?? (storedHeaderFocusValid ? headerFocusSelection.agentId : defaultHeaderFocusAgentId)
  // Both focus menus go through here, because a `?file=` with an `agent` OUTRANKS the local selection: writing only the selection would make the control a no-op — the menu closes and the URL's agent renders again. So the URL moves with the reader, and the open path follows them into the checkout they picked (where the viewer's own not-found state covers a path that agent does not have).
  const changeHeaderFocus = useCallback(
    (agentId: string) => {
      setHeaderFocusSelection({ scope: headerFocusScope, agentId })
      // The MODE travels with the path: a reader comparing one agent's diff to another's must not be dropped into File mode by the act of switching.
      if (viewerPath !== null) setViewerFile(viewerPath, agentId, viewerMode)
    },
    [headerFocusScope, setViewerFile, viewerMode, viewerPath]
  )
  useEffect(() => {
    if (!defaultHeaderFocusAgentId) return
    setHeaderFocusSelection((current) =>
      current.scope === headerFocusScope && headerFocusOptionIds.split('|').includes(current.agentId)
        ? current
        : { scope: headerFocusScope, agentId: defaultHeaderFocusAgentId }
    )
  }, [defaultHeaderFocusAgentId, headerFocusOptionIds, headerFocusScope])
  // Whose checkout the Files tab and the viewer read: the agent the header is focused on. Empty on a session with no agent at all, and then there is no workspace to offer a tab for.
  const filesAgentId = headerFocusAgentId || null
  const headerFocusOption = headerFocusOptions.find((option) => option.agentId === headerFocusAgentId)
  const headerFocusSessionId = headerFocusOption?.sessionId
  const extraHeaderDetailId =
    headerFocusSessionId && headerFocusSessionId !== currentSessionDetail?.id && !syntheticPlayground
      ? headerFocusSessionId
      : null
  const {
    data: extraHeaderDetail,
    error: extraHeaderDetailError,
    mutate: mutateExtraHeaderDetail
  } = useSWR<SessionDetailDto>(
    consoleKeys.sessionDetail(activeOrg?.id, extraHeaderDetailId),
    ([, orgId, , sessionId]) => fetchSessionDetail(sessionId as string, orgId as string)
  )
  const focusedSessionDetail =
    headerFocusSessionId === currentSessionDetail?.id
      ? currentSessionDetail
      : extraHeaderDetail?.id === headerFocusSessionId
        ? extraHeaderDetail
        : null
  const focusedDetailSession = focusedSessionDetail ? sessionFromDetailDto(focusedSessionDetail) : null
  const focusedSessionBase = headerFocusOption?.snapshot
    ? mergeSessionDetailUsage(headerFocusOption.snapshot, focusedDetailSession)
    : focusedDetailSession
  const focusedAgent = headerFocusAgentId ? agentById.get(headerFocusAgentId) : undefined
  const focusedSession = focusedSessionBase
    ? {
        ...focusedSessionBase,
        agentName: focusedAgent ? agentLabel(focusedAgent) : headerFocusOption?.label,
        model: focusedSessionBase.model ?? (focusedSessionBase.runtime ? '' : (focusedAgent?.model ?? '—')),
        runtime: focusedSessionBase.runtime ?? focusedAgent?.runtime ?? '',
        daemon: focusedSessionBase.daemon ?? focusedAgent?.daemon
      }
    : null
  // Whether the focused session's workspace isolation has an ANSWER yet. A related session in the focus menu has an id but no detail until its own round trip lands, and both isolation sources read undefined until then — so a surface mounted now would take "not isolated" for an answer and read the agent's primary checkout instead of the worktree the session actually owns. Withhold rather than guess.
  const filesScopeReady =
    !headerFocusSessionId ||
    extraHeaderDetailId === null ||
    extraHeaderDetail !== undefined ||
    focusedSession?.workspaceIsolation !== undefined
  // A REJECTED isolation read is not a pending one. The checkout still may not be read — the answer is unknown either way — but a spinner that never resolves is a worse lie than saying so, so this state gets its own copy and the tab counts as answered.
  const filesScopeFailed = !filesScopeReady && extraHeaderDetailError !== undefined
  const focusedAgentRuntime = focusedSession?.runtime || focusedAgent?.runtime || ''
  const focusedRuntimeMeta = acpRuntime(acpRegistry, focusedAgentRuntime)

  // Other sessions for the dock's Sessions panel, scoped by that panel's own agent filter — see lib/session-rail-filter.ts for why an untouched filter follows the route and an edited one does not.
  // Joined into a string so the roster's fresh array identity per render, rebuilt from the detail snapshot, cannot churn the memo below.
  const liveSeedAgentIds = (session?.participants ?? []).map((p) => p.agentId).join(',')
  // The seed is the whole conversation roster (`railSeedAgentIds`): the resolver's members — in session mode its §5.3 redirect probe — then this browser's own live roster, then the lone owning agent.
  const seedAgentIds = useMemo(
    () =>
      railSeedAgentIds(
        conversationKey ? conversationMembers : selfConversation?.sessions,
        liveSeedAgentIds ? liveSeedAgentIds.split(',') : [],
        session?.agentId
      ),
    [conversationKey, conversationMembers, selfConversation, liveSeedAgentIds, session?.agentId]
  )
  const [chosenRailFilter, setChosenRailFilter] = useState<RailAgentFilter>(EMPTY_RAIL_AGENT_FILTER)
  // Seeded DURING RENDER: an effect would commit one frame of "All agents" over org-wide rows and fire the unfiltered request first, and `seedRailAgentFilter` is pure — state only ever holds the reader's own choice, the seed is recomputed from the route.
  const railFilter = seedRailAgentFilter(chosenRailFilter, seedAgentIds)
  const setRailAgentIds = useCallback((agentIds: string[]) => setChosenRailFilter({ agentIds, touched: true }), [])

  // With agents selected this reads a FILTERED page, not the org-wide `allSessions` window — a busy org's newest 50 may not include them at all, leaving the panel empty on an agent that has plenty of runs.
  // Cleared, the unfiltered page IS the question; `null` means the filter has nothing to say yet (no session, untouched), so the org key stays null and no page is fetched to be thrown away.
  const railQuery = railAgentFilterQuery(railFilter)
  const railAgentIds = railQuery?.agentId ?? []
  // The panel's list is conversation-shaped as the detail route is; an explicit flat route keeps the same raw-session mode, so navigating the panel cannot silently return to the grouped list or re-hide superseded sessions.
  const {
    sessions: seededRailRows,
    total: seededRailTotal,
    isLoading: seededRailLoading
  } = useSessionList(MOCK_MODE || !railQuery ? null : activeOrg?.id, railQuery ?? {}, { grouped: !flatView })
  // Which panel is on screen. Sessions is where a session page opens; every other tab is one the reader asked for.
  const [dockTab, setDockTab] = useState(DOCK_TABS[0]!.key)
  // The Files tab's `refresh-cw` action: re-reads the tree and the git status without remounting the panel, so the reader's filter and expanded folders survive it.
  const [filesRefreshTick, setFilesRefreshTick] = useState(0)
  // Reported by the panel, like the Sessions verdict: only it knows whether its first root listing has answered.
  const [filesRootSettled, setFilesRootSettled] = useState(false)
  // The Git tab's own `refresh-cw`, and the verdict it reports — its settle state feeds the tab status, its changed count the tab's badge.
  const [gitRefreshTick, setGitRefreshTick] = useState(0)
  const [gitVerdict, setGitVerdict] = useState<GitPanelVerdict>({ settled: false, changed: null })
  // A seed narrowed to the conversation already on screen hides the list AND the picker that could widen it, so re-ask it unfiltered.
  const railSeedKeyNow = railSeedKey(railFilter)
  // Waited on because an in-flight family reads as EMPTY, not `undefined`: latching there widens a list about to grow a Related tree.
  const railFamilySettled = conversationMode
    ? conversationLineage !== undefined || conversationLineageError !== undefined
    : !sessionDetailLoading
  // Latched to the SEED, not held as a boolean: widening replaces the rows, so the collapse that justified it stops being observable.
  const [widenedSeed, setWidenedSeed] = useState<string | null>(null)
  // The same verdict as a live boolean for the tab status — `null` until the panel has reported one, which is not the answer `true` is.
  const [sessionsWouldHide, setSessionsWouldHide] = useState<boolean | null>(null)
  // Reported by the panel rather than re-derived here: only it can reach the whole verdict, its page merged with globally hydrated pins and the open row.
  const handleSessionsWouldHide = useCallback(
    (wouldHide: boolean) => {
      setSessionsWouldHide(wouldHide)
      if (!railSeedShouldWiden(railSeedKeyNow, wouldHide, !seededRailLoading && railFamilySettled)) return
      setWidenedSeed(railSeedKeyNow)
    },
    [railSeedKeyNow, seededRailLoading, railFamilySettled]
  )
  // What tells "the list is still coming" from "there is no list": the dock withholds its chrome and holds its track for either, and the two only differ in the placeholder a sibling-tab-ready dock shows.
  const sessionsStatus = sessionsTabStatus(sessionsWouldHide, !seededRailLoading && railFamilySettled)
  // `loading` also covers "we do not know which checkout yet": a related session's isolation is a round trip behind, and reading before it lands would read the wrong one. A failed isolation read is `ready` instead — it has copy to draw, and it is never going to resolve on its own.
  const filesStatus = filesScopeFailed ? 'ready' : filesScopeReady ? filesTabStatus(filesRootSettled) : 'loading'
  // Same three states for Git, and for the same reasons: an unknown checkout is `loading`, a failed isolation read is answered copy.
  const gitStatus = filesScopeFailed ? 'ready' : filesScopeReady ? gitTabStatus(gitVerdict.settled) : 'loading'
  // Each tab's own verdict, spliced onto the static descriptors. Files is dropped outright rather than left `loading` forever when there is no agent behind it — a tab that can never answer is not a tab — and the demo tour has no daemon to read a checkout from at all, so it does not get one either.
  const dockTabs = useMemo<DockTab[]>(
    () =>
      DOCK_TABS.filter(
        (tab) => (tab.key !== 'files' && tab.key !== 'git') || (filesAgentId !== null && !MOCK_MODE)
      ).map((tab) =>
        tab.key === 'sessions'
          ? { ...tab, status: sessionsStatus }
          : tab.key === 'files'
            ? { ...tab, status: filesStatus }
            : tab.key === 'git'
              ? {
                  ...tab,
                  status: gitStatus,
                  // The badge is the changed-file count, omitted rather than shown as `0`: a clean tree wears no pill, and neither does a workspace whose status could not be read.
                  ...(gitVerdict.changed ? { badge: gitVerdict.changed } : {})
                }
              : tab
      ),
    [filesAgentId, filesStatus, gitStatus, gitVerdict.changed, sessionsStatus]
  )
  // The active tab has to be one that exists: a Files tab dropped under the reader would otherwise leave the dock with no active tab and an unlabelled panel.
  const dockTabKey = dockTabs.some((tab) => tab.key === dockTab) ? dockTab : DOCK_TABS[0]!.key
  const railSeedWidened = !MOCK_MODE && railSeedKeyNow !== '' && widenedSeed === railSeedKeyNow
  const { sessions: widenedRailRows, total: widenedRailTotal } = useSessionList(
    railSeedWidened ? activeOrg?.id : null,
    {},
    { grouped: !flatView }
  )
  const railSessionRows = railSeedWidened ? widenedRailRows : seededRailRows
  const railSessionTotal = railSeedWidened ? widenedRailTotal : seededRailTotal
  // The chips describe the list on screen, and a widened rail is unfiltered — leaving the seed's chips up would misname it.
  const railDisplayAgentIds = railSeedWidened ? [] : railFilter.agentIds
  const railSessions = useMemo(() => {
    if (!MOCK_MODE) return railSessionRows
    if (!railQuery) return []
    if (railAgentIds.length === 0) return allSessions
    if (railAgentIds.length === 1) return getSessions(railAgentIds[0]!)
    // The demo fixtures carry no conversation grouping, so the channel stands in for it — enough for the multi-agent filter to behave like the real one.
    const channelsOf = (agentId: string) => new Set(getSessions(agentId).map((s) => `${s.platform}\0${s.channel}`))
    const shared = railAgentIds.map(channelsOf).reduce((a, b) => new Set([...a].filter((c) => b.has(c))))
    return allSessions.filter(
      (s) => railAgentIds.includes(s.agentId ?? '') && shared.has(`${s.platform}\0${s.channel}`)
    )
  }, [allSessions, getSessions, railAgentIds, railQuery, railSessionRows])
  // The open row as the Sessions panel sees it: its conversation and, where the resolver has answered, that conversation's full membership — both identity the panel matches on, and neither on the session row itself.
  const railCurrentKey = conversationKey ?? selfKey
  const railCurrentMemberIds = useMemo(() => {
    const roster = conversationKey ? conversationMembers : (selfConversation?.sessions ?? null)
    return roster?.map((member) => member.sessionId) ?? null
  }, [conversationKey, conversationMembers, selfConversation])
  const railCurrent = useMemo(
    () =>
      session && (railCurrentKey || railCurrentMemberIds)
        ? {
            ...session,
            ...(railCurrentKey ? { conversationKey: railCurrentKey } : {}),
            ...(railCurrentMemberIds ? { memberSessionIds: railCurrentMemberIds } : {})
          }
        : session,
    [session, railCurrentKey, railCurrentMemberIds]
  )
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
    // A multi-participant conversation's canonical URL is the merged page —
    // refresh must land where the live Playground already looks merged
    // (merged-conversation-view.md §5.3). channelId is the conversation id.
    const conversationId = !flatView && (session?.participants?.length ?? 0) > 1 ? session?.channelId : undefined
    if (conversationId) {
      // ADDRESS BAR ONLY (Next shallow history update): a router.replace to
      // /conversations/:key would remount into persisted conversation mode
      // MID-STREAM — killing the live canvas and racing the CP's
      // session_meta sync. The live view stays; only a real refresh loads
      // the merged page.
      window.history.replaceState(
        null,
        '',
        `${orgPath(`/conversations/${encodeURIComponent(conversationId)}`)}${window.location.search}`
      )
      return
    }
    router.replace(`${orgPath(`/sessions/${encodeURIComponent(realSessionId)}`)}${window.location.search}`, {
      scroll: false
    })
  }, [
    id,
    flatView,
    orgPath,
    router,
    session?.platform,
    session?.realSessionId,
    session?.participants?.length,
    session?.channelId
  ])

  // A real (CP) session arrives with an empty `steps` — its transcript is a
  // separate on-demand pull from the owning daemon. Playground + mock sessions
  // carry their own steps, so they never fetch.
  const sid = session?.id
  // The CP-resolvable id: a playground/webchat session starts under its synthetic
  // local id (`pg_...`) and only gets a `realSessionId` once the daemon creates the
  // real ACP session — `fetchToolBody` targets the CP, which never knows the
  // synthetic id, so a live tool row's full-body fetch must key off this instead of
  // `sid` (matches the `session.realSessionId ?? session.id` idiom used elsewhere
  // in this file for the same daemon-proxied reads).
  const toolSid = session?.realSessionId ?? sid
  const aid = session?.agentId
  const wantTranscript = !!session && session.platform !== 'playground' && session.steps.length === 0 && !!aid
  // This component now survives id changes. Do not paint session A's transcript
  // for one frame under session B's header before the loading effect clears it.
  const transcriptMatchesSession = !wantTranscript || transcriptSessionId === sid
  const visibleMsgs = transcriptMatchesSession ? msgs : null
  const visibleMsgLoading = transcriptMatchesSession ? msgLoading : wantTranscript
  const visibleMsgPaging = wantTranscript && transcriptMatchesSession && msgPaging
  const visibleMsgErr = wantTranscript && transcriptMatchesSession ? msgErr : null
  const visibleTailReady = wantTranscript && transcriptMatchesSession && tailReady
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
    () => sessionAttributionAgentAuthors(session?.platform ?? '', visibleMsgs ?? [], agentById),
    [session?.platform, visibleMsgs, agentById]
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
    // Pull the WHOLE history, not just the newest frame-budgeted page: render the
    // first (newest) page immediately, then keep paging strictly older via
    // nextCursor, prepending each page. Bounded so a pathological session can't
    // keep the proxy busy forever.
    const MAX_PAGES = 40
    if (conversationKey) {
      // Merged conversation (merged-conversation-view.md §4/§6): pull every
      // member's history through the SAME bounded per-session reads, then
      // render mergeConversation() over the union. A member whose read fails
      // (daemon offline) degrades to a partial merge with a notice — never a
      // page-level failure; authorization-hidden members never reached the
      // roster in the first place.
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
              // Newest window only — one page per member (C3 §5.2). Older
              // history loads on demand via the per-source cursors below,
              // capping a cold open at N requests instead of N × MAX_PAGES.
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
        setMsgs(
          mergeConversationRows(
            sources,
            rowsBySession,
            conversationSourceSessionByMessageRef.current,
            conversationSourceTurnByMessageRef.current,
            conversationSourcePlatformByMessageRef.current,
            conversationSourceAgentByMessageRef.current
          )
        )
        setMsgLoading(false)
        setMsgPaging(false)
        liveCursorRef.current = cursors.get(sid) ?? null
        tailReadyRef.current = true
        setTailReady(true)
        const repRows = rowsBySession.get(sid)
        if (repRows && !sessionBusyRef.current) reconcileLiveSteps(sid, repRows, aid)
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
    // conversationSourceKey keys the fan-out on the member SET — a roster
    // refresh with identical members must not refetch every transcript.
  }, [wantTranscript, sid, aid, reconcileLiveSteps, conversationKey, conversationSourceKey])

  const refreshTranscriptTail = useCallback((): Promise<void> => {
    if (!wantTranscript || !sid || !tailReadyRef.current || sessionBusyRef.current) return Promise.resolve()
    if (tailInFlightRef.current) {
      tailDirtyRef.current = true
      return tailInFlightRef.current
    }
    const platform = session?.platform ?? ''
    if (conversationKey) {
      const sources = conversationMembersRef.current ?? []
      const run = (async () => {
        const state = conversationSourcesRef.current
        const repRows: SessionMessageDto[] = []
        // Per-source isolation, mirroring the initial fan-out: one member's
        // daemon going offline mid-conversation must degrade THAT source to
        // the partial-merge notice, never stall the whole tail round.
        let failed = 0
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
              if (src.sessionId === sid) repRows.push(...page.messages)
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
        if (tailSessionRef.current === sid && !sessionBusyRef.current && repRows.length > 0)
          reconcileLiveSteps(sid, repRows, aid)
      })()
        .catch(() => {
          // Keep the last good transcript; the next signal retries.
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
      if (tailSessionRef.current === sid && !sessionBusyRef.current) reconcileLiveSteps(sid, persisted, aid)
    })()
      .catch(() => {
        // Keep the last good transcript. The next SSE signal or reconnect
        // retries without replacing visible history with an error.
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
  }, [wantTranscript, sid, aid, session?.platform, reconcileLiveSteps, conversationKey])

  // C3 §5.2 cross-source "load earlier": one strictly-older page per member
  // that still has history, prepended per source, then re-merged.
  const loadEarlierConversation = useCallback(async (): Promise<void> => {
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

  const sessionActivityVersion = sid ? (sessionActivityVersionById[sid] ?? 0) : 0
  useEffect(() => {
    if (!visibleTailReady || sessionBusy) return
    void refreshTranscriptTail()
  }, [visibleTailReady, sessionBusy, sessionActivityVersion, sessionStreamGeneration, refreshTranscriptTail])

  // Everything above only APPENDS rows; nothing ever moved the viewport, so a
  // live session's newest output landed below the fold. Follow it — but only for
  // a reader who is already at the bottom (see lib/stick-to-bottom).
  const stickToBottom = useStickToBottom(conversationKey ?? sid ?? null)

  useEffect(() => {
    if (!session || (session.platform !== 'playground' && session.platform !== 'webchat') || !sessionBusy) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [session?.id, session?.platform, sessionBusy])

  // Publish title + status to the shell's crumb. Both have to come from here, not from
  // `allSessions`: a deep link (or a parent/child link) to a session outside the loaded
  // cursor pages only exists as the `fetchSessionDetail`-backed row above. Without the
  // title the crumb collapses to the bare "Sessions" label — taking the status badge
  // nested inside it down with it — and the Details popover no longer carries a status
  // the desktop could fall back to.
  // The slot carries the route id it describes: the shell renders the next route before
  // this effect's cleanup runs, so without it session A's crumb paints on session B.
  const { register: registerCrumb } = useCrumbSlot()
  const crumbTitle = session?.title ?? ''
  const crumbStatusKey = session?.status ?? ''
  const crumbStatusLabel = session?.statusLabel || (crumbStatusKey ? status(crumbStatusKey).label : '')
  // The desktop title row renders the same pair the crumb used to badge.
  const headerStatus = status(crumbStatusKey)
  const headerStatusLabel = crumbStatusLabel
  useEffect(() => {
    if (!crumbTitle) return
    registerCrumb({ id, title: crumbTitle, status: crumbStatusKey, statusLabel: crumbStatusLabel })
    return () => registerCrumb(null)
  }, [registerCrumb, id, crumbTitle, crumbStatusKey, crumbStatusLabel])

  // Page-local popovers and turn expansion choices must not leak from one
  // session into the next now that the shared route layout preserves this
  // component instance.
  useEffect(() => {
    imagePrepareGenerationRef.current += 1
    setCopied(false)
    resetDetailPopover()
    requestsPopover.reset()
    setWorkOverride(new Map())
    setImagePreparing(false)
    setImageError(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
    setAttachMenuOpen(false)
    setComposerMenuOpen(null)
  }, [id])

  // A multi-participant conversation is surfaced ONLY at /conversations/:key
  // (merged-conversation-view.md §5.3): a session deep link into one redirects,
  // preserving whose perspective was linked as ?focus.
  if (!conversationKey && selfConversationRedirect) {
    return (
      <SessionDetailFrame>
        <LoadingState fill />
      </SessionDetailFrame>
    )
  }
  // `undefined` = first fetch in flight; `null` = the resolver ANSWERED empty
  // (a just-created conversation racing event/session sync, or one the caller
  // cannot see). Both keep the loading affordance — the fast poll above
  // resolves the just-created case within seconds — but null never renders a
  // premature not-found flash for a conversation that is about to exist.
  if (
    conversationKey &&
    !conversationError &&
    (conversationLoading ||
      conversationRoster === undefined ||
      (conversationRoster === null && !conversationUnresolved))
  ) {
    return (
      <SessionDetailFrame>
        <LoadingState fill />
      </SessionDetailFrame>
    )
  }
  // A failed read and an unverifiable one are NOT absence, and saying "not found
  // — or not visible to you" for either states an authorization verdict the
  // console never actually got. The request erroring is self-evidently not an
  // answer; a DEGRADED answer is subtler — the CP fails external access checks
  // closed, so a Slack API blip omits the very members it could not check and
  // the roster arrives empty with `accessSyncDegraded` set.
  //
  // What is NOT true of both is that they are transient. This page used to say
  // so unconditionally and offer a retry, which for a short app grant is a
  // button that cannot ever succeed — and because a resolved verdict is cached
  // for a couple of minutes, the permanent failure even reads as flakiness. The
  // cause now picks the words and the way out; `accessIssues` rode along on this
  // response the whole time (see `unverifiedConversationNotice`).
  if (conversationKey && (conversationError || (conversationAccessDegraded && !conversationRoster))) {
    const notice = unverifiedConversationNotice(Boolean(conversationError), conversationAccessIssues, orgPath)
    return (
      <SessionDetailFrame withDock={false}>
        <div className="card p-6">
          <div className="font-sans text-[13.5px] leading-[1.55] text-(--text-secondary)">{notice.message}</div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {notice.retry && <Button onClick={() => void retryConversation()}>Try again</Button>}
            {notice.action && (
              <Link className="dsbtn dsbtn-primary no-underline" href={notice.action.href}>
                {notice.action.label}
              </Link>
            )}
            <Link className="lnk font-sans text-[12.5px] font-medium leading-normal" href={orgPath('/sessions')}>
              Back to sessions
            </Link>
          </div>
        </div>
      </SessionDetailFrame>
    )
  }
  if (conversationKey && (!conversationRoster || conversationRoster.sessions.length === 0)) {
    // A grace-expired null or a resolved-but-empty roster, with the access
    // checks themselves healthy — so absence here is a real answer.
    return (
      <SessionDetailFrame withDock={false}>
        <NotFound
          icon="message-square-off"
          kind="CONVERSATION"
          title="Conversation not found"
          pre="No conversation "
          chip={conversationKey}
          post=" in this organization — or none of its participants are visible to you."
          actionLabel="Back to sessions"
          actionHref={orgPath('/sessions')}
        />
      </SessionDetailFrame>
    )
  }

  if (!session) {
    // Shell owns detail navigation at both breakpoints; this branch only renders the
    // loading or not-found body.
    // Still pulling the sessions list — it's not "not found" until that settles.
    if (sessionsLoading || (detailId !== null && sessionDetailLoading)) {
      return (
        <SessionDetailFrame>
          <LoadingState fill />
        </SessionDetailFrame>
      )
    }
    return (
      <SessionDetailFrame withDock={false}>
        <NotFound
          icon="message-square-off"
          kind="SESSION"
          title="Session unavailable"
          pre="Session "
          chip={id}
          post={
            <>
              <span className="desktop:whitespace-nowrap"> isn’t available to you.</span>
              <div className="mx-auto mt-3 w-fit max-w-full text-left">
                <div className="font-medium text-(--text-primary)">Possible reasons:</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {unavailableReasons.map((reason) => (
                    <li key={reason} className="desktop:whitespace-nowrap">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          }
          actionLabel="Back to sessions"
          actionHref={orgPath('/sessions')}
          secondaryAction={
            profileIdentityReady && profileLinkProviderName && profileLinkProvider
              ? {
                  label: `${profileNeedsLink ? 'Link' : 'Review'} ${profileLinkProviderName} profile`,
                  href: orgPath('/profile#sign-in-methods'),
                  icon: <SocialLoginMark target={profileLinkProvider} size={15} />
                }
              : undefined
          }
          showSearch={false}
        />
      </SessionDetailFrame>
    )
  }

  // Session visibility (session-visibility.md §4.3/§6). Rendered in the desktop
  // header and the mobile meta strip. Playground is fail-closed Private by
  // contract, so hold that stable placeholder while its persisted detail row
  // catches up instead of inserting the whole control later.
  const visibilityLoading = focusedSession?.platform === 'playground' && !focusedSessionDetail
  const visibilityControl =
    headerFocusSessionId && (focusedSessionDetail || focusedSession?.visibility || visibilityLoading) ? (
      <SessionVisibilityControl
        key={headerFocusSessionId}
        sessionId={headerFocusSessionId}
        visibility={
          focusedSessionDetail?.visibility ?? focusedSession?.visibility ?? (visibilityLoading ? 'private' : undefined)
        }
        state={focusedSessionDetail?.visibilityState}
        canChange={focusedSessionDetail?.canChangeVisibility === true}
        loading={visibilityLoading}
        externalProvider={focusedSessionDetail?.externalProvider}
        externalResolution={focusedSessionDetail?.externalResolution}
        feishuRegion={focusedSessionDetail?.feishuRegion}
        // Native runtime memory has no per-session gate, so the copy must not
        // promise a memory boundary this tier cannot deliver.
        nativeMemory={focusedAgent?.memoryProvider === 'native'}
        onChanged={({ visibility, state }) => {
          // Reflect the new tier locally, then re-read: the detail row also
          // carries the authoritative pending/applied state, and the lists must
          // drop (or regain) the row for other members.
          const mutateFocusedDetail =
            headerFocusSessionId === currentSessionDetail?.id ? mutateSessionDetail : mutateExtraHeaderDetail
          void mutateFocusedDetail(
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
  const currentDaemonByAgent = new Map(
    agents.map((agent) => [agent.id, agent.daemon === '—' ? undefined : agent.daemon])
  )
  const resumeConversationMembers = conversationKey ? conversationMembers : selfConversation?.sessions
  const resumeConversationLookupPending = conversationKey
    ? conversationLoading
    : Boolean(selfKey && selfConversationLoading)
  const resumeConversationLookupRequired = Boolean(conversationKey || selfKey)
  const persistedResumeMembers = isWebchat
    ? sessionResumeMembers(
        resumeConversationMembers?.map((member) => ({ agentId: member.agentId, daemonId: member.daemonId })),
        currentSessionDetail
          ? { agentId: currentSessionDetail.agentId, daemonId: currentSessionDetail.daemonId }
          : null,
        resumeConversationLookupRequired,
        resumeConversationLookupPending
      )
    : []
  const resumeState = isPg ? 'available' : sessionResumeState(persistedResumeMembers, currentDaemonByAgent)
  const resumeDisabled = isWebchat && resumeState !== 'available'
  // Composer state is per-session in the provider — bind it to THIS session's id so a
  // different live conversation streaming in the background can't disable or clear it.
  const pgBusy = sessionBusy
  const pgImage = getPgImage(session.id)
  const pgQueue = getPgQueue(session.id)
  const hasSessionWorktree =
    focusedAgent?.workspace.mode === 'github' &&
    (focusedSessionDetail?.workspaceIsolation ?? focusedSession?.workspaceIsolation) === 'session' &&
    !(focusedSessionDetail?.contentPurgedAt ?? focusedSession?.contentPurgedAt)
  const workspaceHref =
    focusedAgent && headerFocusAgentId
      ? `/agents/${headerFocusAgentId}?tab=workspace${
          hasSessionWorktree && headerFocusSessionId ? `&worktree=${encodeURIComponent(headerFocusSessionId)}` : ''
        }`
      : null
  const workspaceIcon = focusedAgent?.workspace.mode === 'github' ? 'git-branch' : 'folder'
  const focusedAgentLabel = focusedAgent ? agentLabel(focusedAgent) : (headerFocusOption?.label ?? 'agent')
  const workspaceTitle = hasSessionWorktree
    ? `Open ${focusedAgentLabel}’s session worktree`
    : `Open ${focusedAgentLabel}’s workspace`
  // Scoped to this session's OWN worktree only where it has one. `hasSessionWorktree` is the same gate the Workspace link above uses, and it is load-bearing for the reads: the daemon answers a shared workspace's sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline".
  const filesSessionId = hasSessionWorktree && headerFocusSessionId ? headerFocusSessionId : undefined
  const filesWorkdir = focusedAgent && focusedAgent.workdir !== '—' ? focusedAgent.workdir : undefined
  // A `?file=` on a session with no agent to read it from has nothing to open, so the conversation stays: the viewer never renders without a checkout behind it, nor before that checkout's scope is known, nor when the link named a workspace this conversation does not have.
  const viewerOpen = viewerPath !== null && filesAgentId !== null && filesScopeReady && !linkedFocusStale
  const liveSteps = isWebchat ? getLiveSteps(session.id) : []

  // The conversation roster, for EVERY live surface — the synthetic playground and
  // a resumed (or merged) webchat conversation alike. Scoping it to the playground
  // left resume showing the primary agent's single-agent composer over a
  // multi-agent conversation, which contradicts both §9.3 ("no in-conversation
  // runtime controls in a multi-agent conversation" — each participant runs its own
  // configured defaults, so those pills cannot speak for the turn) and §9.4
  // ("resume reopens the merged conversation view with the roster in the header").
  //
  // Names resolve HERE, from the org agent list: a conversation-mode roster is
  // synthesized from member ids alone and an adopted session's detail roster can
  // only carry a short-id fallback, so the raw `name` would render — and
  // @mention-match — as a uuid.
  const liveRoster = isLive
    ? (
        session.participants ??
        (session.agentId ? [{ agentId: session.agentId, name: session.agentName ?? '', primary: true }] : [])
      ).map((p) => ({ ...p, name: rosterParticipantName(p, agentById.get(p.agentId)) }))
    : []
  const multiLive = liveRoster.length > 1
  const resumePlaceholder =
    resumeState === 'checking'
      ? 'Checking whether this conversation can continue…'
      : multiLive
        ? 'This conversation can’t continue because one or more agents moved to another daemon.'
        : 'This conversation can’t continue because the agent moved to another daemon.'

  // Resume the webchat conversation by its id (session.channelId == the conversationId);
  // a synthetic playground turn omits it (the CP mints a fresh id).
  const onPgSend = (text?: string) => {
    if (imagePreparing || mentionJoining) return
    setImageError(null)
    // Pass the fetched roster: an adopted webchat session has no provider-side
    // state, and without it a multi-agent send can't pre-create stream lanes or
    // narrow by @mention (the relay would apply its all-participants default).
    // Named, not raw: mention narrowing matches on the display name the composer
    // chips show.
    const sent = pgSend(
      session.id,
      session.agentId ?? '',
      text,
      isWebchat ? session.channelId : undefined,
      isWebchat ? liveRoster : undefined
    )
    // Writing ends reading: someone who scrolled up through history and then
    // sends must not have their own message — or the reply to it — land
    // off-screen, so re-arm the bottom-follow regardless of scroll position.
    // Only on an ACCEPTED send, though: Enter on an empty composer, or while a
    // turn is still streaming, sends nothing, and yanking a reader out of
    // history for a no-op would break the very guarantee this makes.
    if (sent) stickToBottom()
  }
  const onImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || imagePreparing) return
    const generation = ++imagePrepareGenerationRef.current
    setAttachMenuOpen(false)
    setImagePreparing(true)
    setImageError(null)
    try {
      const image = await prepareWebchatImage(file)
      if (imagePrepareGenerationRef.current !== generation) return
      setPgImage(session.id, image)
    } catch (error) {
      if (imagePrepareGenerationRef.current !== generation) return
      setImageError(error instanceof Error ? error.message : 'Couldn’t prepare that image.')
    } finally {
      if (imagePrepareGenerationRef.current === generation) {
        setImagePreparing(false)
        if (imageInputRef.current) imageInputRef.current.value = ''
      }
    }
  }
  const webchatConversationId = isLive ? session.channelId : undefined
  // Mid-conversation join (webchat-multi-agents.md §3.1): a live playground
  // conversation may GROW its roster; removal stays unsupported. The join is
  // still playground-only — `pgAddAgent` mutates provider-side session state that
  // an adopted webchat session never had — so a resumed conversation shows its
  // roster (above) without the `+`.
  const pgWorktree =
    worktreeSelections[session.id] ??
    getPgWorktree(session.id) ??
    (owner?.workspace?.mode === 'github' && owner.workspace.worktree === true)
  const canChooseWorktree =
    isPg && !multiLive && owner?.workspace?.mode === 'github' && !session.steps.some((step) => step.kind === 'msg')
  const addAgentOptions = isPg
    ? agents
        .filter((a) => !liveRoster.some((p) => p.agentId === a.id))
        .map((a) => ({
          value: a.id,
          label: agentLabel(a),
          description: 'Add to this conversation',
          leading: (
            <span className="av h-[18px] w-[18px] flex-none rounded-xs">
              <AgentIconView icon={a.icon} runtime={a.runtime} size={18} />
            </span>
          )
        }))
    : []
  // Same candidate pool as addAgentOptions (isPg can invite; an adopted session
  // can only narrow among the roster it already has), reshaped for the
  // @mention picker — see ComposerTextarea's `mention` above.
  const mentionCandidates: MentionOption[] = isPg
    ? agents.map((a) => ({
        id: a.id,
        name: liveRoster.find((p) => p.agentId === a.id)?.name ?? agentLabel(a),
        icon: a.icon,
        runtime: a.runtime,
        inRoster: liveRoster.some((p) => p.agentId === a.id)
      }))
    : multiLive
      ? liveRoster.flatMap((p) => {
          const a = agents.find((x) => x.id === p.agentId)
          return a ? [{ id: a.id, name: p.name, icon: a.icon, runtime: a.runtime, inRoster: true }] : []
        })
      : []
  // Returns the join's promise (not fire-and-forget): pgAddAgent awaits the
  // HTTP request before the roster reflects the new participant, and the
  // composer holds Enter-send off until it settles — sending against the OLD
  // roster would find no typed mention for the just-picked name and silently
  // fall back to messaging every existing participant instead (or, on a
  // failed join, leave the inserted "@Name" text pointing at nobody).
  const onPickMention = (option: MentionOption): Promise<boolean> | void => {
    if (option.inRoster) return
    const picked = agents.find((a) => a.id === option.id)
    return picked ? pgAddAgent(session.id, picked) : undefined
  }
  const onCopyLink = () => {
    try {
      const canonicalId = session.realSessionId ?? session.id
      const link =
        window.location.origin + orgPath(`/sessions/${encodeURIComponent(canonicalId)}${flatView ? '?view=flat' : ''}`)
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
  const speakers = new Map<string, SessionParticipant>()
  const rememberParticipant = (id: string, participant: Omit<SessionParticipant, 'id'>): void => {
    const current = speakers.get(id)
    speakers.set(id, {
      id,
      ...participant,
      agent: participant.agent ?? current?.agent ?? null,
      avatarUrl: participant.avatarUrl ?? current?.avatarUrl,
      avatarInitials: participant.avatarInitials ?? current?.avatarInitials
    })
  }
  const rememberAgentParticipant = (id: string, name: string, agent: Agent | null): void => {
    rememberParticipant(id, { sp: speaker(id, name), agent, isCron: false })
  }
  const pushUserTurn = (id: string, turn: Extract<Turn, { kind: 'user' }>): void => {
    rememberParticipant(id, {
      sp: turn.sp,
      agent: turn.agent,
      avatarUrl: turn.avatarUrl,
      avatarInitials: turn.avatarInitials,
      isCron: turn.isCron
    })
    turns.push(turn)
  }
  const botTurnByKey = new Map<string, Extract<Turn, { kind: 'bot' }>>()
  // Another agent speaking in this session — a webchat peer participant or a
  // trusted a2a bot — renders as its own left-side agent block: the right side
  // is reserved for humans. Conversation rows retain their source-local turn;
  // live rows retain their stream turn; untagged legacy rows group by adjacency.
  const pushAgentTurn = (agent: Agent, step: FmtStep, turnKey?: string): void => {
    const name = agentLabel(agent)
    rememberAgentParticipant(agent.id, name, agent)
    let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
    last = bindWakeBlock(last, { agentId: agent.id, agentName: name }, turnKey)
    if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: agent.id, agentName: name })) {
      // `model` is the icon-runtime fallback for turns whose agent is missing from
      // `agentById`; a peer turn's agent came FROM that map, so it stays empty.
      last = { kind: 'bot', agentName: name, agentId: agent.id, model: '', time: '', steps: [] }
      turns.push(last)
      if (turnKey) botTurnByKey.set(turnKey, last)
    }
    last.steps.push(step)
    if (last.wake) last.wake = false
    if (!last.time && step.time) last.time = step.time
  }
  // A background-task wake lands in its owner agent's lane as a collapsed work
  // row. The wake is the INPUT that starts a fresh model run, so it opens a new
  // `wake`-flagged block instead of extending the previous finished reply; only
  // consecutive still-unanswered wakes for the same owner share one. The run
  // that follows binds to the block and clears the flag (see bindWakeBlock).
  // `ownerAgentId` is the merged-conversation source member — a wake from a
  // peer member is THAT agent's work, not the representative's; plain sessions
  // fall back to the session owner.
  const pushOwnerWakeTurn = (step: FmtStep, turnKey?: string, ownerAgentId?: string): void => {
    const agentId = ownerAgentId ?? session.agentId
    const agent = agentId ? agentById.get(agentId) : undefined
    const name = agent ? agentLabel(agent) : agentId === session.agentId ? (session.agentName ?? '') : (agentId ?? '')
    const prev = turns[turns.length - 1]
    let last = turnKey ? botTurnByKey.get(turnKey) : undefined
    if (!last && prev?.kind === 'bot' && prev.wake && sameBotSpeaker(prev, { agentId, agentName: name })) last = prev
    if (!last || last.kind !== 'bot') {
      last = {
        kind: 'bot',
        wake: true,
        agentName: name,
        ...(agentId ? { agentId } : {}),
        model: agentId === session.agentId ? (session.model ?? '') : '',
        time: '',
        steps: []
      }
      turns.push(last)
      if (turnKey) botTurnByKey.set(turnKey, last)
    }
    last.steps.push(step)
    if (!last.time && step.time) last.time = step.time
  }
  // The run that follows a wake block answers it. When a keyed lookup found no
  // block of its own (the wake row itself never carries a source turn key),
  // bind the run to the trailing unanswered wake block and register the run's
  // key on it so the rest of the run lands there too.
  const bindWakeBlock = (
    found: Turn | undefined,
    speaker: { agentId?: string; agentName: string },
    turnKey?: string
  ): Turn | undefined => {
    if (found) return found
    const prev = turns[turns.length - 1]
    if (prev?.kind === 'bot' && prev.wake && sameBotSpeaker(prev, speaker)) {
      if (turnKey) botTurnByKey.set(turnKey, prev)
      return prev
    }
    return undefined
  }
  if (wantTranscript) {
    // Real transcript: agent output carries `sender === agentId`; everything else
    // is a human/cron author. Group consecutive agent messages into one turn.
    for (const m of visibleMsgs ?? []) {
      const toolSessionId = conversationSourceSessionByMessageRef.current.get(m)
      const sourceTurnKey = conversationSourceTurnByMessageRef.current.get(m)
      // A merged conversation stamps every row with the platform of the source
      // it came from; a single-session page has one platform for all of them.
      const rowPlatform = conversationSourcePlatformByMessageRef.current.get(m) ?? session.platform
      if (m.sender === session.agentId) {
        const ownerName = session.agentName ?? ''
        let last = sourceTurnKey ? botTurnByKey.get(sourceTurnKey) : turns[turns.length - 1]
        last = bindWakeBlock(last, { agentId: m.sender, agentName: ownerName }, sourceTurnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: m.sender, agentName: ownerName })) {
          last = {
            kind: 'bot',
            agentName: ownerName,
            agentId: m.sender,
            model: session.model ?? '',
            time: '',
            steps: []
          }
          turns.push(last)
          if (sourceTurnKey) botTurnByKey.set(sourceTurnKey, last)
        }
        const step = msgStep(m, toolSessionId, rowPlatform)
        last.steps.push(step)
        if (last.wake) last.wake = false
        if (!last.time && step.time) last.time = step.time
      } else {
        // Daemon background-task wakes belong to the owning agent, not to a person —
        // in a merged conversation that is the SOURCE member's agent.
        if (isBgTaskWake(m.sender)) {
          pushOwnerWakeTurn(
            thinkStep(m.text, formatTranscriptRowTime(m), rowPlatform),
            sourceTurnKey,
            conversationSourceAgentByMessageRef.current.get(m)
          )
          continue
        }
        // Count participants by stable sender id — two people can share a display name.
        const cron = asCron(m.sender)
        const senderAgent = participantAgent(m.sender, m.text, m.trustedAgentBot)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const hookFallback = session.platform === 'hook' && m.sender?.startsWith('hook:') ? session.user : undefined
        const self = isSelf(m.sender)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            {
              ...msgStep(m, toolSessionId, rowPlatform),
              ...(m.attachments?.[0] ? { image: m.attachments[0] } : {})
            },
            sourceTurnKey
          )
          continue
        }
        const participant = self
          ? speaker('@you')
          : speaker(
              senderAgentName ?? m.sender,
              cron?.name ?? (cron ? 'Schedule' : senderLabel(m.sender, m.senderName ?? hookFallback))
            )
        pushUserTurn(senderAgent?.id ?? m.sender, {
          kind: 'user',
          sp: participant,
          agent: senderAgent ?? null,
          avatarUrl: m.senderAvatarUrl ?? (self ? viewer.picture : memberPictureByIdentity.get(m.sender)),
          avatarInitials: self ? viewer.initials : undefined,
          sourceLabel: platName(sessionIntegration),
          time: formatTranscriptRowTime(m),
          text: m.text,
          image: m.attachments?.[0],
          isCron: !!cron,
          cronId: cron?.id ?? null,
          platform: rowPlatform
        })
      }
    }
  } else {
    let firstMsg = true
    session.steps.forEach((stp) => {
      if (stp.kind === 'msg') {
        const who = stp.who ?? session.user
        if (isBgTaskWake(stp.who)) {
          pushOwnerWakeTurn(
            thinkStep(stp.text, stp.time, session.platform),
            liveBotTurnKey(stp.turnId, session.agentId)
          )
          firstMsg = false
          return
        }
        const cron = asCron(who)
        const senderAgent = participantAgent(who, stp.text)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const self = isSelf(who)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            plainStep(stp.text, stp.time ?? (firstMsg ? session.time : ''), stp.image, session.platform),
            liveBotTurnKey(stp.turnId, senderAgent.id)
          )
          firstMsg = false
          return
        }
        const participant = self
          ? speaker('@you')
          : speaker(senderAgentName ?? who, cron?.name ?? (cron ? 'Schedule' : senderAgentName))
        pushUserTurn(senderAgent?.id ?? who, {
          kind: 'user',
          sp: participant,
          agent: senderAgent ?? null,
          avatarUrl: self ? viewer.picture : memberPictureByIdentity.get(who),
          avatarInitials: self ? viewer.initials : undefined,
          sourceLabel: platName(sessionIntegration),
          time: stp.time ?? (firstMsg ? session.time : ''),
          text: stp.text,
          image: stp.image,
          isCron: !!cron,
          cronId: cron?.id ?? null,
          platform: session.platform
        })
        firstMsg = false
      } else {
        // Multi-agent conversations attribute live steps per participant. The
        // lane's `agentId` is authoritative (stamped from the stream cursor);
        // resolve its display name at RENDER time from the org agent list —
        // stream-time `who` can be missing (the socket closure predates the
        // session state) and adopted sessions never had a roster.
        const stepAgent = stp.agentId ? agentById.get(stp.agentId) : undefined
        const stepAgentName = (stepAgent ? agentLabel(stepAgent) : stp.who) ?? session.agentName ?? ''
        if (stp.agentId && stp.agentId !== session.agentId) {
          rememberAgentParticipant(stp.agentId, stepAgentName, stepAgent ?? null)
        }
        const turnKey = liveBotTurnKey(stp.turnId, stp.agentId)
        let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
        last = bindWakeBlock(last, { agentId: stp.agentId, agentName: stepAgentName }, turnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: stp.agentId, agentName: stepAgentName })) {
          last = {
            kind: 'bot',
            agentName: stepAgentName,
            ...(stp.agentId ? { agentId: stp.agentId } : {}),
            model: session.model ?? '',
            time: '',
            steps: []
          }
          turns.push(last)
          if (turnKey) botTurnByKey.set(turnKey, last)
        } else if (stp.agentId && last.agentId === undefined) {
          // A tagged step continuing an untagged block names its author retroactively.
          last.agentId = stp.agentId
        }
        const step = fmtStep(stp, session.platform)
        last.steps.push(step)
        if (last.wake) last.wake = false
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
        if (isBgTaskWake(stp.who)) {
          pushOwnerWakeTurn(
            thinkStep(stp.text, stp.time, session.platform),
            liveBotTurnKey(stp.turnId, session.agentId)
          )
          continue
        }
        const senderAgent = participantAgent(who, stp.text)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const self = isSelf(who)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            plainStep(stp.text, stp.time ?? '', stp.image, session.platform),
            liveBotTurnKey(stp.turnId, senderAgent.id)
          )
          continue
        }
        const participant = self ? speaker('@you') : speaker(senderAgentName ?? who, senderAgentName)
        pushUserTurn(senderAgent?.id ?? who, {
          kind: 'user',
          sp: participant,
          agent: senderAgent ?? null,
          avatarUrl: self ? viewer.picture : memberPictureByIdentity.get(who),
          avatarInitials: self ? viewer.initials : undefined,
          sourceLabel: platName(sessionIntegration),
          time: stp.time ?? '',
          text: stp.text,
          image: stp.image,
          isCron: false,
          cronId: null,
          platform: session.platform
        })
      } else {
        const stepAgent = stp.agentId ? agentById.get(stp.agentId) : undefined
        const stepAgentName = (stepAgent ? agentLabel(stepAgent) : stp.who) ?? session.agentName ?? ''
        if (stp.agentId && stp.agentId !== session.agentId) {
          rememberAgentParticipant(stp.agentId, stepAgentName, stepAgent ?? null)
        }
        const turnKey = liveBotTurnKey(stp.turnId, stp.agentId)
        let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
        last = bindWakeBlock(last, { agentId: stp.agentId, agentName: stepAgentName }, turnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: stp.agentId, agentName: stepAgentName })) {
          last = {
            kind: 'bot',
            agentName: stepAgentName,
            ...(stp.agentId ? { agentId: stp.agentId } : {}),
            model: session.model ?? '',
            time: '',
            steps: []
          }
          turns.push(last)
          if (turnKey) botTurnByKey.set(turnKey, last)
        } else if (stp.agentId && last.agentId === undefined) {
          // A tagged step continuing an untagged block names its author retroactively.
          last.agentId = stp.agentId
        }
        const step = fmtStep(stp, session.platform)
        last.steps.push(step)
        if (last.wake) last.wake = false
        if (!last.time && step.time) last.time = step.time
      }
    }
  }

  // The last rendered turn of each tagged agent. A busy reply lane marks ONLY
  // that turn as streaming — every earlier turn from the same agent shares its
  // `agentId`, so matching on the lane alone would flip the agent's whole
  // history to "streaming" while it generates a new turn.
  const lastBotTurnIndexByAgent = new Map<string, number>()
  turns.forEach((t, i) => {
    if (t.kind === 'bot' && t.agentId) lastBotTurnIndexByAgent.set(t.agentId, i)
  })

  // Transcript visibility is presentation-only: keep the complete turn list for
  // usage/duration accounting, and derive a filtered tree for rendering. Live PLAN
  // steps are the playground equivalent of persisted THINK messages.
  // Agent membership already has its own focus menu; this adjacent face stack is
  // only for human speakers observed in the transcript.
  const agentParticipantIds = new Set((session.participants ?? []).map((participant) => participant.agentId))
  const humanParticipants = [...speakers.values()].filter(
    (participant) =>
      !participant.agent &&
      !participant.isCron &&
      !participant.id.startsWith('hook:') &&
      !agentParticipantIds.has(participant.id)
  )
  const soleAuthor = senderLabel(session.triggeredBy, session.user)
  const soleSpeaker = speakers.size === 1 ? speakers.entries().next().value : undefined
  // The session's `daemon` is the owning agent's daemonId (or '—' when unplaced);
  // resolve it to the daemon's display name — never surface the raw id/host
  // (short-id fallback when it isn't in the fleet), matching the Agents list.
  const owningDaemonId = session.daemon && session.daemon !== '—' ? session.daemon : owner?.daemon
  const owningDaemon =
    owningDaemonId && owningDaemonId !== '—' ? daemons.find((d) => d.daemonId === owningDaemonId) : undefined
  const focusedDaemonId =
    focusedSession?.daemon && focusedSession.daemon !== '—' ? focusedSession.daemon : focusedAgent?.daemon
  const focusedDaemon =
    focusedDaemonId && focusedDaemonId !== '—' ? daemons.find((d) => d.daemonId === focusedDaemonId) : undefined
  const focusedDaemonName =
    focusedDaemonId && focusedDaemonId !== '—'
      ? (focusedDaemon?.name ?? (focusedDaemonId.length > 12 ? focusedDaemonId.slice(0, 8) : focusedDaemonId))
      : ''
  // A cron-triggered session carries `user === "cron:<scheduleId>"`. When that's the
  // shown participant, render the chip as a link back to the owning schedule
  // (name-first once the crons list resolves it; the raw `cron:<id>` still links if
  // it hasn't).
  const headerCron = soleSpeaker
    ? asCron(soleSpeaker[0])
    : speakers.size === 0 && soleAuthor === session.user
      ? asCron(session.user)
      : null
  const pgEmpty = isPg && session.steps.length === 0 && !pgBusy
  // "No messages" only when nothing is rendered — a resumed webchat turn folds into
  // `turns`, so once you've sent one the empty card gives way to the transcript.
  const transcriptEmpty =
    wantTranscript && !visibleMsgLoading && !visibleMsgErr && (visibleMsgs?.length ?? 0) === 0 && turns.length === 0
  // ── retention GC (#485) ─────────────────────────────────────────────────────
  // The mark belongs to each SESSION whose content was deleted, so in merged mode
  // it must come from the ROSTER, not from `session` (the representative alone):
  // `turns` is the union of every member, so a purged peer would otherwise be
  // invisible, and a purged representative would be silenced by any surviving
  // member's turn. Both cases would put us back to rendering a deleted transcript
  // as "that participant said nothing".
  const purgedMemberDates = (
    conversationMembers
      ? conversationMembers.map((member) => member.contentPurgedAt ?? null)
      : [session.contentPurgedAt ?? null]
  ).filter((at): at is string => !!at)
  // The notice states one date; the earliest is when this view's history first
  // started going away.
  const purgedAt = purgedMemberDates.length > 0 ? purgedMemberDates.slice().sort()[0]! : null
  const purgedMemberCount = purgedMemberDates.length
  const memberCount = conversationMembers ? conversationMembers.length : 1
  // Nothing survives AND nothing is rendered ⇒ the emptiness is FINAL, not pending.
  // Replaces both the "no messages yet" card (nothing is coming) and the offline
  // error (reconnecting would not bring the transcript back).
  const transcriptPurged =
    wantTranscript && purgedMemberCount > 0 && purgedMemberCount === memberCount && turns.length === 0
  // Some history was deleted but the view still renders turns — from surviving
  // members, or from the live tail. Say so ALONGSIDE the transcript rather than
  // instead of it, so a partial record is never read as the whole record.
  const transcriptPartiallyPurged = !isPg && purgedMemberCount > 0 && !transcriptPurged
  const prompts = pgPrompts(session.agentId ?? '')
  // Per-agent activity must use that session's rows before mergeConversation()
  // deduplicates shared provider/human messages onto one canonical source.
  const focusedMessages =
    conversationKey && headerFocusSessionId
      ? conversationLoadedKey === conversationKey
        ? (conversationSourcesRef.current.rows.get(headerFocusSessionId) ?? [])
        : null
      : visibleMsgs
  const stepsForFocusedAgent = (steps: SessionStep[]) =>
    headerFocusOptions.length <= 1
      ? steps
      : steps.filter((step) =>
          step.agentId ? step.agentId === headerFocusAgentId : headerFocusAgentId === session.agentId
        )
  const focusedTranscriptStats =
    wantTranscript && focusedMessages !== null ? activityStatsFromTranscript(focusedMessages) : null
  const focusedLiveActivityStats = isPg
    ? activityStatsFromSteps(stepsForFocusedAgent(session.steps))
    : activityStatsFromSteps(stepsForFocusedAgent(liveSteps))
  const durationFirst = minTime(focusedTranscriptStats?.firstMs, focusedLiveActivityStats.firstMs)
  const durationLast = maxTime(
    focusedTranscriptStats?.lastMs,
    focusedLiveActivityStats.lastMs,
    pgBusy && headerFocusAgentId === session.agentId && durationFirst != null ? nowMs : null
  )
  const displayDuration =
    durationFirst != null && durationLast != null
      ? fmtTranscriptDuration(durationLast - durationFirst)
      : (focusedSession?.duration ?? '—')
  const displayToolCount = focusedTranscriptStats
    ? fmtCountCompact(focusedTranscriptStats.toolCalls + focusedLiveActivityStats.toolCalls)
    : focusedLiveActivityStats.toolCalls > 0 || isPg
      ? fmtCountCompact(focusedLiveActivityStats.toolCalls)
      : (focusedSession?.toolCount ?? '—')

  // Token-usage breakdown for the detail card — only the fields the runtime reported.
  const u = focusedSession?.usage
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
  const setRuntimeSelection = (patch: { model?: string; effort?: string; permissionPreset?: string; fast?: boolean }) =>
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
  const pgPermissionPreset = sessionPermissionSelection(
    agentRuntime,
    runtimeCatalog,
    livePermissionModes,
    runtimeSelection?.permissionPreset ?? session.permissionMode ?? owner?.permissionMode ?? '',
    owner?.approvalsReviewer ?? 'user'
  )
  const pgPermissionPresets =
    livePermissionModes === undefined &&
    pgPermissionPreset &&
    !selectablePermissionModes.some((choice) => choice.v === pgPermissionPreset)
      ? [
          { v: pgPermissionPreset, l: permissionModeLabel(agentRuntime, pgPermissionPreset) },
          ...selectablePermissionModes
        ]
      : selectablePermissionModes
  // Stage the fast selection locally like model/effort/permission: an adopted
  // (persisted webchat) session has no synthetic provider entry for pgSetFast to
  // mutate, and an idle daemon session emits no status frame — without this the
  // switch would render stale and every click would re-send the same value.
  const pgFastMode = runtimeSelection?.fast ?? session.fastMode ?? owner?.fastMode ?? false
  const pgFastModeAvailable =
    (pgModel === session.model ? session.fastModeAvailable : undefined) ??
    fastModeAvailableFor(agentRuntime, selectedModelCapability)
  // Run facts for the header's "Details" popover — the stats that used to live in
  // the header cards (duration, usage) plus the run's identity rows. Status is not
  // here: it rides the top-bar crumb as a pill next to the session name. Both form
  // factors read this one list (see detailPanel below).
  const headerFacts: { icon: string; label: string; value: string }[] = [
    { icon: 'clock', label: 'Duration', value: displayDuration },
    { icon: 'coins', label: 'Tokens', value: focusedSession?.tokens ?? '—' },
    { icon: 'circle-dollar-sign', label: 'Cost', value: focusedSession?.cost ?? '—' },
    { icon: 'wrench', label: 'Tool calls', value: String(displayToolCount) }
  ]
  if (focusedDaemonName) headerFacts.push({ icon: 'server', label: 'Daemon', value: focusedDaemonName })
  if (focusedAgentRuntime)
    headerFacts.push({
      icon: 'cpu',
      label: 'Runtime',
      value: runtimeLabel(focusedAgentRuntime, focusedRuntimeMeta?.name)
    })
  if (focusedSession?.model ?? focusedAgent?.model)
    headerFacts.push({
      icon: 'box',
      label: 'Model',
      value: modelLabel(focusedSession?.model ?? focusedAgent?.model ?? '')
    })

  // The popover's contents — one definition behind both triggers (desktop hover,
  // mobile tap), so a fact can never show up on one form factor and not the other.
  const detailPanel = (
    <>
      {headerFacts.map((f) => (
        <div key={f.label} className="flex items-center gap-[9px] px-3 py-[5px]">
          <Icon name={f.icon} size={13} color="var(--text-tertiary)" className="flex-none" />
          <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
            {f.label}
          </span>
          <span className="mono whitespace-nowrap text-[12px] font-semibold text-(--text-primary)">{f.value}</span>
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
              <span className="mono whitespace-nowrap text-[12px] font-semibold text-(--text-primary)">{e.value}</span>
            </div>
          ))}
        </>
      )}
    </>
  )

  // ── one responsive tree ─────────────────────────────────────────────────────
  // ≤768px renders the native push-screen body (Shell owns the 56px app bar:
  // back · title · status-dot/channel · link): header row (agent · visibility ·
  // Details) → transcript → live. ≥769px renders the classic page: header →
  // meta row → transcript. Both form factors put the run's numbers behind the
  // same Details popover. Breakpoint differences are CSS-gated (desktop: /
  // max-desktop:), never JS-forked.
  // Approval requests are an action the user has to answer, so on a live session
  // they ride inside the sticky composer footer (always above the input, never
  // scrolled away). A non-live session has no composer — it keeps the top slot.
  // Either way the strip shows only while something is PENDING; the full history
  // (answered included) lives behind the header's Requests popover.
  const canReviewApprovals = Boolean(owner?.canEdit && !owner.name.startsWith(MOCK_PREFIX) && session.agentId)
  const approvalCard = (className: string) =>
    canReviewApprovals && session.agentId ? (
      <ApprovalRequestsCard
        key={session.id}
        agentId={session.agentId}
        sessionId={session.realSessionId ?? session.id}
        pendingOnly
        className={className}
      />
    ) : null
  const requestsPanel =
    canReviewApprovals && session.agentId ? (
      <ApprovalRequestsCard bare agentId={session.agentId} sessionId={session.realSessionId ?? session.id} />
    ) : null

  return (
    // Body · dock track, 26px apart in a full-width row: the −30px bleed reaches the page's right edge while the 880px body centres in what remains, and the track is a column only above `wide:` (below it the dock is an overlay and spends nothing) but holds that column in every tab status, so the body's position is a constant of the band — keep in step with SessionDetailFrame, whose slot holds the identical box while the session loads.
    <div className="flex min-h-full items-stretch gap-[26px]">
      {/* No bottom padding here on mobile: the sticky composer cancels exactly
          `.content`'s bottom inset (see its negative `bottom`), so any padding
          BELOW it becomes a strip the composer can never reach — it stops short
          of the screen edge at the end of the scroll. */}
      {/* The viewer is full-width in every band (§7) — a file wants the columns a transcript does not. The 880px cap is the only geometry that changes: the dock's reserved TRACK keeps its column either way, which is the one thing §7 forbids trading. */}
      <div
        className={
          viewerOpen
            ? 'flex min-h-full min-w-0 flex-1 flex-col'
            : 'mx-auto flex min-h-full min-w-0 max-w-[880px] flex-1 flex-col'
        }
      >
        {/* DESKTOP TITLE ROW — the session name + its status badge. These used to live
          in the top-bar crumb; with the crumb gone the page has to name itself. The
          mobile title/status live in Shell's app bar, so this region is desktop-only. */}
        <div className="mt-[-4px] mb-2 hidden min-w-0 items-center gap-[10px] desktop:flex">
          <h1
            title={session.title}
            className="m-0 min-w-0 truncate font-sans text-[17px] font-semibold leading-normal tracking-[-.01em] text-(--text-primary)"
          >
            {session.title}
          </h1>
          {headerStatusLabel && (
            <span className="badge flex-none" style={{ background: headerStatus.bg, color: headerStatus.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: headerStatus.dot }} />
              {headerStatusLabel}
            </span>
          )}
          <span className="inline-flex min-w-0 flex-[0_1_auto] items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
            <span className="imark h-5 w-5 flex-none rounded-xs">
              <PlatformMark platform={channelDisplay.platform} />
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
        </div>
        {/* DESKTOP META ROW — focused agent · people · workspace · visibility · Details
          popover · copy-link. The old stat/usage cards moved into the Details popover. */}
        <div className="mt-0 mb-[10px] hidden items-center gap-2 border-b border-(--border-subtle) pb-[7px] desktop:flex">
          <SessionAgentFocusMenu
            options={headerFocusOptions}
            value={headerFocusAgentId}
            onChange={(agentId) => changeHeaderFocus(agentId)}
          />
          {headerCron ? (
            <Link
              className="lnk min-w-0 flex-[0_1_auto] font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)"
              href={orgPath(`/crons/${headerCron.id}`)}
            >
              <Icon name="calendar-clock" size={13} className="flex-none" />
              <span className="truncate">{headerCron.name || 'Schedule'}</span>
            </Link>
          ) : humanParticipants.length > 0 ? (
            <SessionHumanFaces participants={humanParticipants} />
          ) : null}
          {workspaceHref ? (
            <Link
              className="lnk flex-none text-[12.5px] text-(--text-secondary)"
              href={orgPath(workspaceHref)}
              title={workspaceTitle}
            >
              <Icon name={workspaceIcon} size={13} />
              Workspace
            </Link>
          ) : null}
          {visibilityControl}
          {/* `flex` on the wrapper: an inline-flex button in a block div sits on a text
            baseline, and the descender gap under it pushed the button off the row's
            centre line. The transparent top padding bridges the trigger/panel gap so
            the hover target remains continuous. */}
          <div
            className="relative ml-[-3px] flex flex-none items-center"
            onMouseEnter={() => updateDetailPresence('hovered', true)}
            onMouseLeave={() => updateDetailPresence('hovered', false)}
            onFocus={() => updateDetailPresence('focused', true)}
            // Focus moving BETWEEN descendants (trigger → panel) must not drop
            // presence, or keyboard users can never reach the panel's contents.
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return
              updateDetailPresence('focused', false)
            }}
          >
            <button
              type="button"
              className="inline-flex h-[22px] items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
              aria-describedby={detailTooltipId}
            >
              <Icon name="info" size={14} />
              Details
            </button>
            <div
              id={detailTooltipId}
              role="tooltip"
              className={`absolute top-full left-0 z-50 w-max pt-[5px] transition-[opacity,visibility] ${
                detailOpen ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'
              }`}
            >
              <div className="max-h-[340px] min-w-[216px] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) px-0 py-[5px] shadow-(--shadow-lg)">
                {detailPanel}
              </div>
            </div>
          </div>
          {requestsPanel && (
            // Same hover-or-tap affordance as Details: the approval history
            // (answered requests included) reachable without scrolling the page.
            <div
              className="relative ml-[-3px] flex flex-none items-center"
              onMouseEnter={() => requestsPopover.setPresence('hovered', true)}
              onMouseLeave={() => requestsPopover.setPresence('hovered', false)}
              onFocus={() => requestsPopover.setPresence('focused', true)}
              // Same as Details: ignore focus transitions that stay inside the
              // wrapper, so tabbing from the trigger into Allow/Deny works.
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return
                requestsPopover.setPresence('focused', false)
              }}
            >
              <button
                type="button"
                className="inline-flex h-[22px] items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
                aria-haspopup="dialog"
                aria-expanded={requestsPopover.open}
                aria-controls={requestsTooltipId}
              >
                <Icon name="shield-check" size={14} />
                Requests
              </button>
              {/* dialog, not tooltip: Allow/Deny live inside, and a tooltip role
                misrepresents interactive content to assistive tech. */}
              <div
                id={requestsTooltipId}
                role="dialog"
                aria-label="Approval requests"
                className={`absolute top-full left-0 z-50 pt-[5px] transition-[opacity,visibility] ${
                  requestsPopover.open
                    ? 'pointer-events-auto visible opacity-100'
                    : 'pointer-events-none invisible opacity-0'
                }`}
              >
                <div className="max-h-[340px] w-[min(420px,calc(100vw-64px))] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-lg)">
                  {requestsPanel}
                </div>
              </div>
            </div>
          )}
          <button
            className="ml-auto flex h-[19px] w-[19px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            onClick={onCopyLink}
            title={copied ? 'Copied' : 'Copy a link to this session'}
            aria-label="Copy a link to this session"
          >
            <Icon name={copied ? 'check' : 'link'} size={12} />
          </button>
        </div>

        {currentSessionDetail?.accessSyncDegraded && (
          <div className="mb-3 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4 max-desktop:mt-3">
            External access could not be verified. Related sessions remain hidden until access checks succeed.
          </div>
        )}

        {/* The link named a workspace this conversation does not have. Saying so beats opening the same path against whichever agent the header would otherwise focus — that reads plausible and is wrong. */}
        {linkedFocusStale && viewerPath !== null && (
          <div
            data-viewer-stale-link=""
            className="mb-3 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4 max-desktop:mt-3"
          >
            This link points at an agent that is not part of this conversation, so its file was not opened. Pick an
            agent in the header and open the file from the Files tab.
          </div>
        )}

        {/* MOBILE HEADER ROW — the desktop meta row's shape at 390px: the focused
          agent, workspace, visibility, and everything numeric collapsed behind
          the SAME Details popover. It replaces the old 4-up stat strip and the
          daemon/runtime/model config line, both of which now live in the popover;
          three stacked bands of chrome above the transcript were the phone's whole
          first screen. Tap toggles (`tapped`) — there is no hover to lean on. */}
        <div className="relative flex items-center gap-2 border-b border-(--border-subtle) bg-(--surface-card) px-4 py-[9px] desktop:hidden">
          <span className="flex min-w-0 flex-1">
            <SessionAgentFocusMenu
              options={headerFocusOptions}
              value={headerFocusAgentId}
              onChange={(agentId) => changeHeaderFocus(agentId)}
            />
          </span>
          {workspaceHref ? (
            // Borderless on purpose (no `iconbtn`): a boxed button in this strip of
            // plain text triggers reads as the odd one out and eats width.
            <Link
              href={orgPath(workspaceHref)}
              className="flex h-[26px] w-[22px] flex-none items-center justify-center rounded-md text-(--text-secondary) no-underline active:bg-(--surface-active)"
              title={workspaceTitle}
              aria-label={workspaceTitle}
            >
              <Icon name={workspaceIcon} size={14} />
            </Link>
          ) : null}
          {visibilityControl}
          <button
            type="button"
            onClick={toggleDetailTap}
            aria-expanded={detailOpen}
            // Its own id: the desktop tooltip stays in the DOM (hidden by CSS, not
            // unmounted), so sharing one would put a duplicate id on the page.
            aria-controls={`${detailTooltipId}-mobile`}
            className="inline-flex h-[26px] flex-none items-center gap-1 rounded-md border-0 bg-transparent px-0 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) active:bg-(--surface-active)"
          >
            <Icon name="info" size={14} />
            Details
          </button>
          {requestsPanel && (
            <button
              type="button"
              onClick={requestsPopover.toggleTap}
              aria-expanded={requestsPopover.open}
              aria-controls={`${requestsTooltipId}-mobile`}
              aria-label="Approval requests"
              className="inline-flex h-[26px] flex-none items-center gap-1 rounded-md border-0 bg-transparent px-0 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) active:bg-(--surface-active)"
            >
              <Icon name="shield-check" size={14} />
            </button>
          )}
          {detailOpen && (
            <>
              {/* Tap-away close: a popover a phone cannot dismiss without hitting the
                  same 26px trigger again is a trap. */}
              <div className="fixed inset-0 z-40" onClick={closeDetailTap} aria-hidden="true" />
              <div
                id={`${detailTooltipId}-mobile`}
                role="dialog"
                aria-label="Session details"
                className="absolute top-full right-4 z-50 max-h-[60vh] w-[min(280px,calc(100vw-32px))] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[5px] shadow-(--shadow-lg)"
              >
                {detailPanel}
              </div>
            </>
          )}
          {requestsPanel && requestsPopover.open && (
            <>
              <div className="fixed inset-0 z-40" onClick={requestsPopover.closeTap} aria-hidden="true" />
              <div
                id={`${requestsTooltipId}-mobile`}
                role="dialog"
                aria-label="Approval requests"
                className="absolute top-full right-4 z-50 max-h-[60vh] w-[min(360px,calc(100vw-32px))] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-lg)"
              >
                {requestsPanel}
              </div>
            </>
          )}
        </div>

        {familyLinks && (
          <MobileSessionFamilyLinks
            parents={familyLinks.parentSessions}
            siblings={familyLinks.siblingSessions ?? []}
            children={familyLinks.childSessions}
            agentById={agentById}
            orgPath={orgPath}
            conversation={conversationMode}
            flatView={flatView}
            childOriginById={conversationLineage?.childOriginById}
          />
        )}

        {!isLive && approvalCard('mx-4 mt-4 max-desktop:rounded-lg desktop:mx-0 desktop:mt-0 desktop:mb-4')}

        {viewerOpen && viewerPath && filesAgentId ? (
          // Keyed on the whole WORKSPACE SCOPE, not just the path: the viewer resets its slice in a passive effect, which runs AFTER paint, so without a fresh mount one committed frame draws the previous read's bytes — and its line count and size — under the new heading. The path alone is not that scope: switching header focus from one agent to another while `?file=` holds still is the same stale paint. Same hazard `transcriptMatchesSession` guards for the transcript; nothing inside the viewer is worth carrying across either axis.
          <SessionViewer
            key={`${filesAgentId}:${filesSessionId ?? 'primary'}:${viewerPath}`}
            agentId={filesAgentId}
            {...(filesSessionId ? { sessionId: filesSessionId } : {})}
            path={viewerPath}
            // NOT part of the mount key: the pill must redraw the pane it already has, and a remount would re-read the file (and the diff) on every toggle.
            mode={viewerMode}
            onModeChange={(mode) => setViewerFile(viewerPath, filesAgentId, mode)}
            onClose={() => setViewerFile(null)}
          />
        ) : null}

        {/* CONVERSATION MODE, concealed rather than unmounted. Everything below belongs to the transcript and the composer, and all of it is state a session round trip must not spend: every expanded tool body and its refetch, the composer's caret and any open @mention menu (with the `mentionJoining` latch it reports upward, which has no owner left to clear it once the composer is gone), and the approval cards' poll. `contents` keeps the flex layout it has today exactly — an active box here would be a second flex item in the column.
          The cost, accepted: a pending webchat MCP write approval is concealed with the composer and has no header twin the way permission requests do (those stay in the Requests popover). A reader who opened a file sees the agent stall until they come back. */}
        <div data-conversation-pane="" className={viewerOpen ? 'hidden' : 'contents'}>
          {wantTranscript && visibleMsgLoading && (
            <div className="flex justify-center py-10">
              <Spinner size={30} />
            </div>
          )}
          {conversationOffline > 0 && (
            <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
              <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
              <span>
                Some participants&apos; records are on an offline daemon — this view may be missing part of the
                conversation until it reconnects.
              </span>
            </div>
          )}
          {wantTranscript && visibleMsgErr && !transcriptPurged && (
            <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
              <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
              <span>
                Couldn&apos;t load the transcript — the owning daemon may be offline. Session history is pulled live
                from the daemon, so it&apos;s unavailable while that machine is disconnected.
              </span>
            </div>
          )}
          {transcriptPurged && (
            <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
              <Icon name="trash-2" size={15} color="var(--text-tertiary)" />
              <span>
                This transcript was deleted on {fmtDate(purgedAt)} by the session retention policy, together with any
                workspace created just for it. The details on this page are all that remain.
              </span>
            </div>
          )}
          {transcriptPartiallyPurged && (
            <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
              <Icon name="trash-2" size={15} color="var(--text-tertiary)" />
              <span>
                Part of this history is missing:{' '}
                {memberCount > 1
                  ? `${purgedMemberCount} of ${memberCount} participants had their transcript deleted`
                  : 'this transcript was deleted'}{' '}
                on {fmtDate(purgedAt)} by the session retention policy. What you see below is the remaining record.
              </span>
            </div>
          )}
          {transcriptEmpty && !transcriptPurged && (
            <div className="card m-4 flex flex-col items-center gap-[6px] px-6 py-[34px] text-center desktop:m-0">
              <Icon name="message-square-dashed" size={20} color="var(--text-tertiary)" />
              <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                No messages in this session yet.
              </div>
            </div>
          )}

          {conversationKey && conversationHasEarlier && (
            <div className="flex items-center justify-center pt-[10px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary) desktop:pt-1 desktop:pb-3">
              <button
                className="lnk text-[12px]"
                onClick={() => void loadEarlierConversation()}
                disabled={conversationPagingEarlier}
              >
                {conversationPagingEarlier ? 'Loading earlier activity…' : 'Load earlier activity'}
              </button>
            </div>
          )}
          {visibleMsgPaging && (
            <div className="flex items-center justify-center gap-2 pt-[10px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary) desktop:pt-1 desktop:pb-3">
              <Spinner size={14} />
              Loading earlier activity…
            </div>
          )}
          {/* TRANSCRIPT — one shared tree. Mobile adds the 16px gutter column around
          turns + live tail. The column grows to fill the page (flex-1 inside the
          min-h-full wrap) so the flex-1 spacer below can pin the composer to the
          bottom even when the transcript is short. */}
          {/* `max-desktop:pb-0` for the same reason as the wrap above: this column's
          last child is the sticky composer, and a bottom gutter under it is a strip
          the composer stops short of. (Longhand `pb-*` always sorts after shorthand
          `p-*`, so the cancel wins — STYLE.md §8.) */}
          <div className="flex flex-1 flex-col gap-4 p-4 max-desktop:pb-0 desktop:gap-0 desktop:p-0">
            {turns.length > 0 && (
              <div className="flex flex-col gap-4 desktop:gap-[15px]">
                {turns.map((turn, ti) => (
                  // The turn's clock time is its own centred line above the message —
                  // a shared separator for both sides, instead of a label-row tail
                  // that never lines up with the bubble edge on either side.
                  <div key={`${session.id}:${ti}`} className="flex flex-col gap-[5px]">
                    {turn.time && (
                      <div className="mono text-center text-[11px] leading-normal text-(--text-tertiary)">
                        {turn.time}
                      </div>
                    )}
                    {turn.kind === 'user' ? (
                      // 2b: user turns are right-aligned brand-soft bubbles. A sender label
                      // sits above the bubble only when it isn't you (platform user / cron).
                      <div key={`${session.id}:${ti}`} className="group/turn flex items-start justify-end gap-[9px]">
                        <div className="relative flex min-w-0 max-w-[86%] flex-col items-end gap-[3px]">
                          {showsSenderLabel(turn) && (
                            <span className="flex items-center gap-[6px] pr-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
                              {turn.isCron && turn.cronId ? (
                                <Link className="lnk text-inherit" href={orgPath(`/crons/${turn.cronId}`)}>
                                  {turn.sp.name}
                                </Link>
                              ) : (
                                <span>{turn.sp.name}</span>
                              )}
                            </span>
                          )}
                          <div className={SELF_BUBBLE}>
                            {turn.image && (
                              <img
                                src={`data:${turn.image.mimeType};base64,${turn.image.data}`}
                                alt={turn.image.name}
                                className={`max-h-[360px] max-w-full rounded-md object-contain ${turn.text ? 'mb-[10px]' : ''}`}
                              />
                            )}
                            {turn.text && <MessageText text={turn.text} platform={turn.platform} />}
                          </div>
                          {/* Sent bubbles are complete by definition — the copy affordance
                        (hover-revealed, right-aligned under the bubble) always mounts.
                        Absolutely positioned into the inter-turn gap so revealing it
                        never changes the row's height. */}
                          {turn.text && (
                            <span className="absolute right-0 top-full">
                              <CopyTurnButton text={turn.text} />
                            </span>
                          )}
                        </div>
                        <ParticipantAvatar
                          agent={turn.agent}
                          avatarUrl={turn.avatarUrl}
                          avatarInitials={turn.avatarInitials}
                          platformMark={usesIntegrationAvatar ? sessionIntegration : undefined}
                          sp={turn.sp}
                          isCron={turn.isCron}
                          // Optically centre the 26px mark on the bubble's FIRST LINE, not
                          // on the bubble's top edge: 9px of padding plus half of a 21px
                          // line puts that centre 19.5px down, while a top-aligned mark
                          // centres at 13px — the 6px it looked too high by. A labelled row
                          // keeps the mark level with its label instead, like the bot side.
                          className={showsSenderLabel(turn) ? '' : 'mt-[6px]'}
                        />
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
                        // Is this turn still streaming? A multi-agent live webchat runs
                        // several reply lanes at once, so a TAGGED turn asks its own lane
                        // (an earlier still-active participant must not show the copy
                        // affordance or lose its live line just because a later turn renders
                        // below it). Lane-less/single-agent streams keep the trailing-turn
                        // fallback. statusLabel carries the RAW session state — the
                        // active-turn predicate lives (and is tested) in session-work.ts.
                        const turnInFlight = sessionTurnInFlight(pgBusy, session.statusLabel)
                        const busyLanes = turnInFlight ? getBusyLaneAgentIds(session.id) : []
                        // The lane only says WHICH AGENT is busy — restrict the match to that
                        // agent's LAST turn so its finished history stays non-streaming.
                        const streaming =
                          turnInFlight &&
                          (turn.agentId && busyLanes.length > 0
                            ? busyLanes.includes(turn.agentId) && lastBotTurnIndexByAgent.get(turn.agentId) === ti
                            : ti === turns.length - 1)
                        const openWork = workPanelOpen(workOverride.get(ti))
                        // Is the WORK itself still running? `streaming` alone is turn-level —
                        // it stays true while the spoken answer streams AFTER the last tool
                        // finished, which must not keep the live line alive. ACP tool calls
                        // can also run in PARALLEL, each update replacing its original row
                        // in place (keyed by toolCallId) — so "the newest row is finished"
                        // does not mean the work is: any non-terminal tool row keeps the
                        // work running, and the LATEST such row is what the toggle line
                        // reports. With no active tool, a trailing unfinished work step
                        // still counts (THINK rows carry no status and run until
                        // superseded); a trailing text step means the agent moved on to its
                        // answer.
                        const stepDone = (st?: FmtStep) =>
                          ['completed', 'failed'].includes((st?.msg?.toolStatus ?? '').toLowerCase())
                        const activeTool = [...workSteps].reverse().find((st) => st.msg?.toolCallId && !stepDone(st))
                        const lastStep = turn.steps[turn.steps.length - 1]
                        const tailRunning = !!lastStep && WORK_LANES.has(lastStep.lane) && !stepDone(lastStep)
                        const liveStep = activeTool ?? (tailRunning ? lastStep : undefined)
                        const workRunning = streaming && liveStep !== undefined
                        // While work runs, the toggle line also carries what is running RIGHT
                        // NOW — the live step's first line (tool rows keep the command in
                        // `code`) — so a collapsed panel still shows live progress.
                        const liveLine =
                          workRunning && liveStep
                            ? (liveStep.text || liveStep.code)?.split('\n', 1)[0]?.trim()
                            : undefined
                        // Step identity for the fade-in key: two consecutive steps can show
                        // the SAME first line, and a keyed-by-text span would keep its DOM
                        // node and never replay the animation.
                        const liveKey =
                          liveStep && liveLine
                            ? `${liveStep.msg?.toolCallId ?? turn.steps.indexOf(liveStep)}:${liveLine}`
                            : undefined
                        // Keyed by agent id where there is one so the colour survives a
                        // rename; a mock/playground row without an id falls back to the
                        // display name, which is stable for as long as the row is.
                        const turnTone = agentToneColor(turn.agentId || turn.agentName)
                        // What the bubble-level copy button copies: the spoken answer.
                        const answerText = textSteps
                          .map((st) => st.text)
                          .filter(Boolean)
                          .join('\n\n')
                        return (
                          <div key={`${session.id}:${ti}`} className="group/turn flex items-start gap-[10px]">
                            <span className="av h-[26px] w-[26px] flex-none rounded-md">
                              <AgentIconView
                                icon={((turn.agentId ? agentById.get(turn.agentId) : owner) ?? owner)?.icon}
                                runtime={
                                  (turn.agentId ? agentById.get(turn.agentId)?.runtime : undefined) ??
                                  (agentRuntime || turn.model)
                                }
                                size={26}
                              />
                            </span>
                            <div className="min-w-0 flex-1" style={{ '--agent-accent': turnTone } as CSSProperties}>
                              <div className="mb-[5px] flex items-center gap-[7px]">
                                <span className={AGENT_NAME}>{turn.agentName}</span>
                              </div>
                              {/* One bubble PER text step, not one around the set: each step is
                            its own delivered message (a turn that answers in two chunks
                            arrives as two), so bubbling them together would merge messages
                            the platform kept apart. `w-fit` keeps a short reply from
                            drawing a full-width card. */}
                              {textSteps.map((st, si) => (
                                <div key={si} className={`${AGENT_BUBBLE} ${si > 0 ? 'mt-2' : ''}`}>
                                  {st.image && (
                                    <img
                                      src={`data:${st.image.mimeType};base64,${st.image.data}`}
                                      alt={st.image.name}
                                      className={`max-h-[360px] max-w-full rounded-md object-contain ${st.text ? 'mb-[10px]' : ''}`}
                                    />
                                  )}
                                  {st.text && (
                                    <div className="whitespace-pre-wrap">
                                      <MessageText text={st.text} platform={st.platform} />
                                    </div>
                                  )}
                                  <StepExtras step={st} sessionId={toolSid} />
                                </div>
                              ))}
                              {workSteps.length > 0 && (
                                <>
                                  {/* One row: the work toggle, with the bubble's copy button at
                                the line's end — mounted only once the turn has finished. */}
                                  <div className="mt-2 flex min-w-0 items-center gap-[6px]">
                                    <button
                                      type="button"
                                      onClick={() => toggleWork(ti, openWork)}
                                      className="inline-flex min-w-0 items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
                                      title={openWork ? 'Hide the agent’s work' : 'Show the agent’s work'}
                                    >
                                      <Icon
                                        name={openWork ? 'chevron-down' : 'chevron-right'}
                                        size={13}
                                        color="var(--text-tertiary)"
                                      />
                                      <span className="flex-none">{summary || 'Details'}</span>
                                      {liveLine && (
                                        // Keyed by step identity + content: a new step (or a new
                                        // first line within one) remounts the span, replaying the
                                        // ac-rise fade-in (honors reduced-motion in globals.css).
                                        <span key={liveKey} className="ac-rise min-w-0 truncate">
                                          · {liveLine}
                                        </span>
                                      )}
                                    </button>
                                    {!streaming && answerText && <CopyTurnButton text={answerText} />}
                                  </div>
                                  {openWork && (
                                    <div className="mt-2 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-app)">
                                      {/* All work steps show, streaming or not — a live turn's
                                    panel grows as steps arrive so the whole run is visible. */}
                                      {workSteps.map((st, si) => (
                                        <div
                                          // Keyed by tool identity where there is one, so an
                                          // expanded ToolBodyDetail survives re-renders as new
                                          // steps stream in. Steps without a tool id (THINK
                                          // rows) fall back to the index; within one agent's
                                          // turn a toolCallId appears once.
                                          key={st.msg?.toolCallId ?? `i:${si}`}
                                          className={`flex items-start gap-[11px] px-[14px] py-[10px] ${
                                            si > 0 ? 'border-t border-(--border-subtle)' : ''
                                          }`}
                                        >
                                          {/* min-h matches the text column's FIRST LINE box
                                        (13px × 1.5), so centring inside it puts the dot
                                        and lane label on that line's centre line. The
                                        old `pt-[1px]` guessed at the same thing against
                                        a 15px-tall mono box and read a few px high. */}
                                          <div className="flex min-h-[20px] w-[52px] flex-none items-center gap-[6px]">
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
                                                <MessageText text={st.text} platform={st.platform} />
                                              </div>
                                            )}
                                            <StepExtras step={st} sessionId={toolSid} />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </>
                              )}
                              {/* A turn with no work has no toggle row — the finished
                            bubble's copy button gets its own line instead. */}
                              {workSteps.length === 0 && !streaming && answerText && (
                                <div className="mt-2 flex">
                                  <CopyTurnButton text={answerText} />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()
                    )}
                  </div>
                ))}
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
                {pgBusy &&
                  (() => {
                    // Multi-agent conversations attribute the typing indicator to
                    // the participants whose reply lanes are STILL OPEN — after a
                    // supersession it is the REGENERATING agent working, not the
                    // primary. Single-agent (and lane-less adopted) sessions keep
                    // the owner row.
                    const busyAgents =
                      (session.participants?.length ?? 0) > 1
                        ? getBusyLaneAgentIds(session.id)
                            .map((agentId) => agentById.get(agentId))
                            .filter((agent): agent is Agent => agent !== undefined)
                        : []
                    const rows = busyAgents.length > 0 ? busyAgents : [owner]
                    // 26px mark + 10px gap, same geometry as an agent turn's row, so the
                    // dots start on the same left edge as that agent's bubbles above.
                    return rows.map((agent, i) => (
                      <div key={agent?.id ?? i} className="flex items-center gap-[10px] desktop:mt-[14px]">
                        <span className="av h-[26px] w-[26px] flex-none rounded-md">
                          <AgentIconView icon={agent?.icon} runtime={agent?.runtime || agentRuntime} size={26} />
                        </span>
                        <div className="inline-flex items-center gap-1 rounded-[11px] bg-(--brand-soft) px-[14px] py-[11px]">
                          <span className="tdot" />
                          <span className="tdot [animation-delay:.18s]" />
                          <span className="tdot [animation-delay:.36s]" />
                        </div>
                      </div>
                    ))
                  })()}
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
                  <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
                    {imageError}
                  </div>
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
                  {approvalCard('mb-2 max-desktop:rounded-lg')}
                  {/* Webchat MCP write approvals ride the same sticky footer as permission
                  requests: always above the input, never scrolled away. */}
                  {activeOrg && session.agentId && webchatConversationId && (
                    <WebchatMcpApprovalCard
                      key={webchatConversationId}
                      orgId={activeOrg.id}
                      agentId={session.agentId}
                      conversationId={webchatConversationId}
                      className="mb-2"
                    />
                  )}
                  {/* Queued messages (Claude Code-style): sends accepted while a turn was
                  still streaming wait here, dispatch in order as turns finish, and can
                  be cancelled individually before they go out. */}
                  {pgQueue.length > 0 && (
                    <div className="mb-2 flex flex-col items-end gap-1">
                      {pgQueue.map((q) => (
                        <div
                          key={q.queueId}
                          className="group flex max-w-full items-center gap-2 rounded-[9px] border border-dashed border-(--border-default) bg-(--surface-card) py-[5px] pr-[5px] pl-3"
                        >
                          <Icon name="clock" size={13} color="var(--text-tertiary)" />
                          <span
                            className="min-w-0 truncate font-sans text-[13px] leading-normal text-(--text-tertiary)"
                            title={q.text}
                          >
                            {q.text || q.image?.name || 'Image'}
                          </span>
                          <button
                            type="button"
                            className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-(--surface-hover) hover:text-(--text-secondary)"
                            aria-label="Cancel queued message"
                            title="Cancel queued message"
                            onClick={() => pgCancelQueued(session.id, q.queueId)}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Composer card (design "achero"): textarea on top, a toolbar row below
                  the divider — attach · model pill (fast toggle in its menu) · effort ·
                  permission · context ring · send. Tokens/cost live in the header's
                  Details popover, not here. */}
                  <div
                    className="relative min-w-0 rounded-[11px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--brand) focus-within:[box-shadow:0_0_0_3px_var(--brand-ring)]"
                    inert={resumeDisabled}
                    aria-disabled={resumeDisabled}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      setAttachMenuOpen(false)
                      setComposerMenuOpen(null)
                    }}
                  >
                    {resumeDisabled && (
                      <textarea
                        className="absolute inset-0 z-10 block h-full min-h-[92px] w-full resize-none rounded-[10px] border-0 bg-(--surface-sunken) px-[15px] py-[13px] font-sans text-[14px] font-normal leading-[1.55] text-(--text-tertiary) outline-none placeholder:text-(--text-tertiary) disabled:cursor-not-allowed"
                        aria-label="Conversation unavailable"
                        placeholder={resumePlaceholder}
                        disabled
                      />
                    )}
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
                    <ComposerTextarea
                      sessionId={session.id}
                      placeholder={
                        (session.participants?.length ?? 0) > 1 ? 'Message everyone…' : `Message ${session.agentName}…`
                      }
                      onSend={() => onPgSend()}
                      onImageFile={(file) => void onImageFile(file)}
                      mentionCandidates={mentionCandidates}
                      onPickMention={onPickMention}
                      onMentionJoiningChange={setMentionJoining}
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
                      {/* nowrap on mobile — pills shrink + truncate (ComposerMenu min-w-0)
                      instead of wrapping into a second toolbar line. Except with a
                      multi-agent roster: those chips are unbounded in count, so no
                      amount of truncation bounds one line — let that case wrap. */}
                      <div
                        className={
                          multiLive
                            ? 'flex min-w-0 flex-1 flex-wrap items-center gap-2'
                            : 'flex min-w-0 flex-1 items-center gap-2 desktop:flex-wrap'
                        }
                      >
                        {multiLive &&
                          liveRoster.map((p) => {
                            const rosterAgent = agents.find((a) => a.id === p.agentId)
                            return (
                              <span key={p.agentId} className={COMPOSER_PILL_STATIC} title="Participant">
                                {rosterAgent && (
                                  <span className="av h-[14px] w-[14px] flex-none rounded-xs">
                                    <AgentIconView icon={rosterAgent.icon} runtime={rosterAgent.runtime} size={14} />
                                  </span>
                                )}
                                <span className="truncate">{p.name}</span>
                              </span>
                            )
                          })}
                        {/* h-7 w-7 like every other control on this row (and the Home composer's
                        twin), so the dashed circle shares their 28px box instead of floating
                        inside it. A lucide glyph, not a text "+": a text plus centres on its
                        line box, which left it a hair low. */}
                        {isPg && addAgentOptions.length > 0 && (
                          <ComposerMenu
                            title="Add agents"
                            value=""
                            options={addAgentOptions}
                            iconOnly
                            open={composerMenuOpen === 'addAgent'}
                            align="left"
                            triggerClassName="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-dashed border-(--border-default) font-sans leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                            tooltips={false}
                            leading={<Icon name="plus" size={14} />}
                            onOpenChange={(open) => {
                              setAttachMenuOpen(false)
                              setComposerMenuOpen(open ? 'addAgent' : null)
                            }}
                            onChange={(v) => {
                              const picked = agents.find((a) => a.id === v)
                              if (picked) void pgAddAgent(session.id, picked)
                            }}
                          />
                        )}
                        {!multiLive &&
                          (runtimeChangesEnabled && pgModelOptions.length > 0 ? (
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
                                const currentEffort =
                                  runtimeSelection?.effort ?? session.effort ?? owner?.reasoning ?? ''
                                const effort = sessionEffortAfterModelChange(
                                  agentRuntime,
                                  owningDaemon,
                                  model,
                                  currentEffort
                                )
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
                                <span className="truncate">{modelLabel(pgModel)}</span>
                                {pgFastModeAvailable && pgFastMode && <FastBadge />}
                              </span>
                            )
                          ))}
                        {!multiLive &&
                          (runtimeChangesEnabled && pgEffortOptions.length > 0 ? (
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
                                <span className="truncate">
                                  {pgEffortChoices.find((choice) => choice.value === pgEffort)?.label ??
                                    effortLabel(agentRuntime, pgEffort)}
                                </span>
                              </span>
                            )
                          ))}
                        {!multiLive &&
                          (runtimeChangesEnabled && pgPermissionPresets.length > 0 ? (
                            <ComposerMenu
                              title="Permission"
                              value={pgPermissionPreset}
                              options={pgPermissionPresets.map((mode) => ({
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
                              onChange={(permissionPreset) => {
                                setRuntimeSelection({ permissionPreset })
                                pgSetPermissionPreset(
                                  session.id,
                                  session.agentId ?? '',
                                  permissionPreset,
                                  webchatConversationId
                                )
                              }}
                            />
                          ) : (
                            pgPermissionPreset && (
                              <span className={COMPOSER_CHIP_STATIC} title="Permission">
                                <span className="truncate">
                                  {agentPermissionDisplay(owningDaemon, agentRuntime, pgPermissionPreset)}
                                </span>
                              </span>
                            )
                          ))}
                        {canChooseWorktree && (
                          <label className={`${COMPOSER_CHIP} min-w-0 cursor-pointer`}>
                            <input
                              type="checkbox"
                              checked={pgWorktree}
                              onChange={(event) => {
                                const worktree = event.target.checked
                                setWorktreeSelections((current) => ({ ...current, [session.id]: worktree }))
                                pgSetWorktree(session.id, worktree)
                              }}
                              className="h-4 w-4 flex-none accent-(--brand)"
                            />
                            <span className="truncate">Worktree</span>
                          </label>
                        )}
                      </div>
                      <ContextWindowIndicator used={u?.contextUsed} size={u?.contextSize} />
                      <ComposerSendButton
                        sessionId={session.id}
                        busy={pgBusy}
                        imagePreparing={imagePreparing}
                        hasImage={!!pgImage}
                        mentionJoining={mentionJoining}
                        onSend={() => onPgSend()}
                        onStop={() => pgCancel(session.id, session.agentId ?? '', webchatConversationId)}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Opening a file also closes the collapsed-band overlay: below `wide:` the dock is a drawer over the very pane the file lands in, and on a phone the viewer IS the screen (§8). The dock's own latch resets on this key. */}
      <SessionDock
        tabs={dockTabs}
        activeKey={dockTabKey}
        onTabChange={setDockTab}
        onTabAction={(key) => {
          if (key === 'files') setFilesRefreshTick((tick) => tick + 1)
          if (key === 'git') setGitRefreshTick((tick) => tick + 1)
        }}
        overlayKey={`${session.id}:${viewerPath ?? ''}`}
        label="Panels"
      >
        {/* Both panels stay mounted; only the active one draws. Sessions owns the verdict that sets its own tab status, and Files owns the tree, the filter and the scroll position a tab switch must not spend. */}
        <DockPanel active={dockTabKey === 'sessions'}>
          <SessionsPanel
            sessions={railSessions}
            // Named by conversation and members (the §5.1 key, roster complete): that is how the panel collapses this row and how a pin finds it.
            current={railCurrent ?? session}
            total={railSessionTotal}
            agentIds={railDisplayAgentIds}
            filterTouched={railFilter.touched}
            onAgentIdsChange={setRailAgentIds}
            family={familyLinks}
            flatView={flatView}
            childOriginById={conversationLineage?.childOriginById}
            roomLineage={conversationLineage?.roomLineage}
            onSelect={setRouteSession}
            onWouldHideChange={handleSessionsWouldHide}
          />
        </DockPanel>
        <DockPanel active={dockTabKey === 'files'}>
          {/* Withheld until the scope is known, so no listing is ever issued against a checkout we only assumed. A rejected isolation read says so rather than spinning forever. */}
          {filesScopeFailed ? (
            <div
              data-files-scope-failed=""
              className="px-3 py-4 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
            >
              Couldn’t tell which checkout this session reads — its details didn’t load. Reopen the session, or read the
              files from the agent’s workspace page.
            </div>
          ) : null}
          {filesAgentId && filesScopeReady ? (
            <FilesPanel
              agentId={filesAgentId}
              {...(filesSessionId ? { sessionId: filesSessionId } : {})}
              {...(filesWorkdir ? { workdir: filesWorkdir } : {})}
              refreshTick={filesRefreshTick}
              openFilePath={viewerOpen && viewerMode === 'file' ? viewerPath : null}
              onOpenFile={(path) => setViewerFile(path, filesAgentId)}
              onRootSettledChange={setFilesRootSettled}
            />
          ) : null}
        </DockPanel>
        <DockPanel active={dockTabKey === 'git'}>
          {/* Same withholding as Files: no status is read against a checkout we only assumed, and a rejected isolation read says so instead of spinning. */}
          {filesScopeFailed ? (
            <div
              data-git-scope-failed=""
              className="px-3 py-4 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
            >
              Couldn’t tell which checkout this session works in — its details didn’t load. Reopen the session, or read
              its git status from the agent’s workspace page.
            </div>
          ) : null}
          {/* Mounted on the same terms as Files, and for the same reason: the panel's verdict is what keeps its own tab out of the dock's vacant state, so a lazily mounted one makes the tab unreachable. */}
          {filesAgentId && filesScopeReady ? (
            <GitPanel
              agentId={filesAgentId}
              {...(filesSessionId ? { sessionId: filesSessionId } : {})}
              refreshTick={gitRefreshTick}
              openPath={viewerOpen && viewerMode !== 'file' ? viewerPath : null}
              openStaged={viewerMode === 'staged'}
              onOpenDiff={(path, staged, untracked) =>
                setViewerFile(path, filesAgentId, untracked ? 'file' : staged ? 'staged' : 'diff')
              }
              onVerdictChange={setGitVerdict}
            />
          ) : null}
        </DockPanel>
      </SessionDock>
    </div>
  )
}
