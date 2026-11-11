'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { PendingActionsBanner } from '@/components/console/PendingActions'
import {
  pickConversationRepresentative,
  representativeFirst,
  selfConversationPath
} from '@/lib/conversation-addressing'
import { assembleConversationLineage, type ConversationLineage } from '@/lib/conversation-lineage'
import { encodeConversationKey } from '@/lib/conversation-key'
import { unverifiedConversationNotice } from '@/lib/session-access-notifications'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import {
  agentDaemonLabel,
  agentCapabilitySource,
  agentLabel,
  agentPlacementIcon,
  isSelfSender,
  isSetPlacementKind,
  modelLabel,
  MOCK_MODE,
  MOCK_PREFIX,
  isGitWorkspace,
  pgPrompts,
  POOL_PLACEMENT,
  platName,
  runtimeSwitchPermissionMode,
  rosterParticipantName,
  runtimeDefaultModel,
  runtimeLabel,
  sessionChannelDisplay,
  sessionPlatform,
  status,
  type Agent,
  type ElicitAnswerValue,
  type FillCardAnswer,
  type Session,
  type SessionStep
} from '@/lib/data'
import { agentSessionIsolationLabel } from '@/lib/session-isolation'
import { stayedHomeReasonKey } from '@/lib/session-executor'
import {
  ApiError,
  fetchConversationByKey,
  fetchMySessionIdentity,
  fetchSessionDetail,
  fmtCountCompact,
  fmtDate,
  mergeSessionDetailRunConfig,
  mergeSessionDetailUsage,
  sessionFromDto,
  sessionFromDetailDto,
  wakeAgent,
  type SessionProfileProvider,
  type SessionDetailDto,
  type SessionMessageDto,
  type SessionThreadAuthorDto,
  type SessionRelationDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { RuntimeModelSelect } from '@/components/console/RuntimeModelSelect'
import { FollowUpTaskSummary } from '@/components/console/follow-up'
import { modelEvaluationsTarget } from '@/components/console/decisions/ModelSelectionEvaluations'
import { SessionModelSelectionResult } from '@/components/console/decisions/SessionModelSelectionResult'
import { HeaderPeople, personSub } from '@/components/console/HeaderPeople'
import { TranscriptApprovalsProvider, UnplacedApprovals } from '@/components/console/TurnApprovals'
import { approvalTurnStart, type ApprovalTurnAnchor } from '@/components/console/approval-placement'
import { useProfile } from '@/lib/profile'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { AgentIconView, LoadingState, PlatformMark, SocialLoginMark, Spinner } from '@/components/marks'
import type { McpAppRpc } from '@agentconnect.md/protocol'
import { NotFound } from '@/components/console/NotFound'
import { Avatar, Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { transcriptRowTimeMs, turnTimeLabel } from '@/lib/transcript-time'
import { liveResumeMembers, sessionResumeMembers, sessionResumeState } from '@/lib/session-resume'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { consoleKeys } from '@/lib/swr-keys'
import {
  senderIdentity,
  sessionAttributionAgentAuthors,
  sessionAttributionAgentId,
  sessionTranscriptAgentIds
} from '@/lib/session-trigger'
import { useSenderPeople } from '@/components/console/sender-people'
import { useStickToBottom } from '@/lib/stick-to-bottom'
import { newDividerIndex, useSeenMarker } from '@/lib/transcript-seen'
import { NewDivider, SeenRecorder, TranscriptMap, type MapTurn } from '@/components/console/TranscriptNav'
import { useSessionTranscript } from '@/lib/use-session-transcript'
import { socialLoginProviders } from '@/lib/social-login-providers'
import { isAuthConfigured } from '@/lib/auth'
import { clipboardFiles, prepareWebchatImage } from '@/lib/webchat-image'
import { landOnMessage, messageLink, useLocateMessage } from '@/lib/message-link'
import {
  AttachmentCards,
  FileDropOverlay,
  INLINE_IMAGE_KEY,
  composerCards,
  stageComposerFiles,
  useFileDrop
} from '@/components/console/ComposerFiles'
import { transferCapable, uploadPreviewsCapable, sessionFileDownload } from '@/lib/shared-file'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import { ComposerMenu } from '@/components/console/ComposerMenu'
import { MentionMenu, type MentionOption } from '@/components/console/MentionMenu'
import { useMentionAutocomplete } from '@/components/console/useMentionAutocomplete'
import {
  composerHistoryFromRows,
  useComposerHistory,
  type ComposerHistoryEntry
} from '@/components/console/useComposerHistory'
import { CommandMenu } from '@/components/console/CommandMenu'
import {
  commandHighlight,
  syncCommandMirror,
  type ControlCommand
} from '@/components/console/composer-control-commands'
import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'
import { useCommandAutocomplete } from '@/components/console/useCommandAutocomplete'
import { useRuntimeCommands } from '@/components/console/useRuntimeCommands'
import type { AgentIcon } from '@/lib/agent-icon'
import {
  sessionTurnInFlight,
  toggleWorkPanel,
  exchangePromptMs,
  agentTurnStreaming,
  workPanelOpen
} from '@/components/console/session-work'
import { ApprovalRequestsCard, usePendingRequestCount } from '@/components/console/ApprovalRequestsCard'
import { activityScope, ASSISTANT_TASK_HANDLE_FEATURE } from '@/lib/agent-activity'
import type { SessionAgentFocusOption } from '@/components/console/SessionAgentFocusMenu'
import { useCrumbSlot } from '@/components/console/Shell'
import { DockPanel, SessionDock, SessionDockSlot, type DockTab } from '@/components/console/dock/SessionDock'
import { ComputerPanel } from '@/components/console/dock/ComputerPanel'
import {
  SessionsPanel,
  SessionsPanelSkeleton,
  relatedSessions,
  sessionsTabStatus
} from '@/components/console/dock/SessionsPanel'
import { FilesPanel, filesTabStatus } from '@/components/console/dock/FilesPanel'
import { useSandboxKeepAlive } from '@/components/console/dock/sandbox-keep-alive'
import { GitPanel, gitTabStatus, type GitPanelVerdict } from '@/components/console/dock/GitPanel'
import {
  TASKS_UNSETTLED,
  TasksPanel,
  tasksTabShown,
  tasksTabStatus,
  type TasksPanelVerdict
} from '@/components/console/dock/TasksPanel'
import { ThreadPanel } from '@/components/console/dock/ThreadPanel'
import { RunningCommandsDock } from '@/components/console/RunningCommandsDock'
import { StateIcon, sessionState } from '@/components/console/StateIcon'
import { TaskBrief } from '@/components/console/TaskBrief'
import { SendButton } from '@/components/console/SendButton'
import { SessionShareDialog, type ShareVisibility } from '@/components/console/SessionShareDialog'
import { useIsMobile } from '@/lib/use-is-mobile'
import { RootThreadFooter, TaskThreadFooter } from '@/components/console/ThreadFooter'
import {
  firstWords,
  liveReplyThreads,
  namesThread,
  threadAutoOpen,
  threadShapeOf,
  threadToAutoOpen,
  splitThreadWork,
  WEBCHAT_THREADS_FEATURE,
  CONTINUATION_THREADS_FEATURE,
  type ThreadAutoOpen
} from '@/components/console/coordinator-threads'
import { type TaskLink } from '@/components/console/task-link'
import { useTasksByMessage } from '@/components/console/task-thread'
import {
  PullRequestPanel,
  pullRequestTabStatus,
  type PullRequestPanelVerdict
} from '@/components/console/dock/PullRequestPanel'
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
import { approvalNotice, raisedIn, WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'
import { useDaemonDetail } from '@/lib/use-daemon-detail'
import { HOST_STRATEGY, strategyUsesImage } from '@/lib/execution-strategy'
import {
  CodeHostDecisionResult,
  DecisionResultMarker,
  useSessionDecisionResults
} from '@/components/console/decisions/SessionDecisionResults'
import type { DecisionEvaluationSource } from '@/lib/decisions/evaluation-source'
import { DecisionEvaluationsDrawer } from '@/components/console/decisions/DecisionEvaluationsDrawer'
import {
  sessionEffortAfterModelChange,
  sessionRuntimeChangesEnabled,
  runtimePickerState,
  chatSettingsAllowed
} from '@/lib/session-runtime-controls'
import type { FmtStep } from '@/components/console/transcript-steps'
import { buildTurns, turnTimeMs, type SessionParticipant, type Turn } from '@/components/console/session-turns'
import { BotTurnView, UserTurnView, lastSpokenSentence } from '@/components/console/TurnViews'
type ComposerMenuKey = 'permission' | 'model' | 'effort' | 'addAgent'

// Session composer chips (mirrors HomeView); effort and approval live in the model picker.
const COMPOSER_CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
const COMPOSER_PILL =
  'inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-mono text-[11.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)'
const COMPOSER_PILL_STATIC =
  'inline-flex h-7 min-w-0 items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-mono text-[11.5px] font-medium leading-normal text-(--text-primary)'
// A continued conversation's roster chips pick the one member a send reaches.
const COMPOSER_RECIPIENT =
  'inline-flex h-7 min-w-0 cursor-pointer items-center gap-[7px] rounded-full border px-[10px] font-mono text-[11.5px] font-medium leading-normal disabled:cursor-not-allowed disabled:opacity-50'
const COMPOSER_RECIPIENT_ON = `${COMPOSER_RECIPIENT} border-(--brand-soft-border) bg-(--brand-soft) text-(--brand-soft-text)`
const COMPOSER_RECIPIENT_OFF = `${COMPOSER_RECIPIENT} border-transparent bg-transparent text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)`

// A conversation whose cross-room lineage has not landed yet. Stable identity so
// the family it feeds is not a new object on every render while the multi-request
// lineage fetch is in flight.
const EMPTY_CONVERSATION_FAMILY: ConversationLineage['family'] = { parentSessions: [], childSessions: [] }

// The same header popovers support hover, keyboard focus and tap at every width.
function useHeaderPopover() {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState({ hovered: false, focused: false, tapped: false, dismissed: false })
  const open = (state.hovered || state.focused || state.tapped) && !state.dismissed
  const setPresence = (key: 'hovered' | 'focused', value: boolean) =>
    setState((current) => {
      const next = { ...current, [key]: value }
      return { ...next, dismissed: next.hovered || next.focused || next.tapped ? current.dismissed : false }
    })
  const toggleTap = () => setState((current) => ({ ...current, tapped: !current.tapped, dismissed: current.tapped }))
  // Stable (setState identity), so session-switch reset effects can depend on it.
  const reset = useCallback(() => setState({ hovered: false, focused: false, tapped: false, dismissed: false }), [])
  // Escape and an outside press dismiss even when a touch did not move focus.
  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setState((current) => ({ ...current, tapped: false, dismissed: true }))
    }
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) reset()
    }
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('keydown', dismiss, true)
      document.removeEventListener('pointerdown', outside)
    }
  }, [open, reset])
  return { ref, open, setPresence, toggleTap, reset }
}

/** No thread holds any coordinator work outside the roots view. */
const EMPTY_THREAD_WORK: ReadonlyMap<string, Turn[]> = new Map()
/** Stable identity for a composer with no participants to ask — keeps useRuntimeCommands' memo still. */
const EMPTY_ROSTER: ReadonlyArray<{ agentId: string; name: string }> = []
const noOwnerIcon = () => undefined
const EMPTY_CONTROLS: readonly ControlCommand[] = []
// The textarea's text box, shared with the overlay that marks a leading command so both lay text out identically.
const COMPOSER_TEXT = 'px-[15px] pt-[13px] pb-[2px] font-sans text-[14px] leading-[1.55]'

// The composer's textarea, isolated so a keystroke re-renders ONLY this node:
// the draft lives outside the playground context (usePgDraft subscription), and
// SessionDetailView rebuilds the whole transcript on every render — routing
// keystrokes through it made typing lag on long sessions.
function ComposerTextarea({
  sessionId,
  placeholder,
  onSend,
  onAttachFiles,
  mentionCandidates,
  onPickMention,
  onMentionJoiningChange,
  onCommandPick,
  commands,
  controls,
  history,
  hasEarlier,
  loadEarlier,
  loadedRows
}: {
  sessionId: string
  placeholder: string
  onSend: () => void
  onAttachFiles?: (files: File[]) => void
  /** The viewer's earlier prompts in the loaded window, oldest first — Up/Down on an empty draft recalls them. */
  history: readonly ComposerHistoryEntry[]
  /** Transcript paging, so Up at the oldest loaded prompt pages earlier history in. */
  hasEarlier: boolean
  loadEarlier: () => Promise<void>
  loadedRows: number
  mentionCandidates: MentionOption[]
  onPickMention: (option: MentionOption) => void | Promise<boolean>
  /** Mirrors `mention.joining` up to the parent so the (separately isolated)
   *  Send button can disable itself too — see the effect below. */
  onMentionJoiningChange: (joining: boolean) => void
  /** A pick names its owner; the parent validates it at send time and merges it into mentions[]. */
  onCommandPick?: (target: { agentId: string; name: string }) => void
  /** The `/` picker's participants, absent when the conversation has no live runtime to ask. */
  commands?: {
    roster: ReadonlyArray<{ agentId: string; name: string }>
    iconOf: (agentId: string) => { icon: AgentIcon | null | undefined; runtime: string } | undefined
    multi: boolean
  }
  /** Console commands the `/` and `!` picker runs in place, ahead of the skills. */
  controls?: readonly ControlCommand[]
}) {
  const draft = usePgDraft(sessionId)
  const { setPgInput, getPgSuggestion } = usePlayground()
  // A phone has no Tab to take the runtime's predicted prompt, so it keeps the plain placeholder.
  const suggestion = useIsMobile() ? undefined : getPgSuggestion(sessionId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recall = useComposerHistory({
    history,
    value: draft,
    setValue: (v) => setPgInput(sessionId, v),
    hasEarlier,
    loadEarlier,
    loadedRows
  })
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
  // Fetched HERE rather than in the view body: the picker's pool must be read with a hook, and the
  // view returns early above this point. The composer mounts with the conversation, so the read is
  // still a mount-time prefetch rather than a keystroke-time one.
  const runtimeCommands = useRuntimeCommands(commands?.roster ?? EMPTY_ROSTER, !!commands)
  // `/` and `!` picker, offered before the mention picker; a skill's owner travels via onCommandPick, never as `@Name` text.
  const command = useCommandAutocomplete({
    ref: textareaRef,
    value: draft,
    setValue: (v) => setPgInput(sessionId, v),
    candidates: runtimeCommands.candidates,
    controls,
    onPicked: onCommandPick
  })
  // A recognized leading command reads as a command: the overlay behind the (then transparent) text colors it and hints its argument.
  const highlight = commandHighlight(draft, controls ?? EMPTY_CONTROLS, runtimeCommands.candidates)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  // Re-fit after every render (the scrollbar comes and goes with the draft) and whenever the composer resizes.
  useLayoutEffect(() => syncCommandMirror(overlayRef.current, textareaRef.current))
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => syncCommandMirror(overlayRef.current, textareaRef.current))
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="relative">
      {recall.label && (
        <div
          aria-live="polite"
          data-testid="composer-history"
          className="px-[15px] pt-[9px] -mb-[7px] font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)"
        >
          {recall.label}
        </div>
      )}
      <div className="relative">
        {highlight && (
          <div
            ref={overlayRef}
            aria-hidden
            data-testid="composer-command-highlight"
            className={`${COMPOSER_TEXT} pointer-events-none absolute top-0 left-0 overflow-hidden break-words whitespace-pre-wrap text-(--text-primary)`}
          >
            {draft.slice(0, highlight.start)}
            <span className="text-(--text-link)">{draft.slice(highlight.start, highlight.end)}</span>
            {draft.slice(highlight.end)}
            {/* A textarea gives a trailing newline its own line; a div needs content there to match. */}
            {draft.endsWith('\n') && '\u200b'}
            {highlight.hint && (
              <span className="text-(--text-tertiary)">
                {draft.length === highlight.end ? ' ' : ''}
                {highlight.hint}
              </span>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          onScroll={(e) => syncCommandMirror(overlayRef.current, e.currentTarget)}
          className={`${COMPOSER_TEXT} relative block max-h-[160px] min-h-[56px] w-full resize-none border-0 bg-transparent outline-none placeholder:text-(--text-tertiary) ${highlight ? 'text-transparent caret-(--text-primary)' : 'text-(--text-primary)'}`}
          placeholder={suggestion ?? placeholder}
          value={draft}
          onChange={(e) => {
            setPgInput(sessionId, e.target.value)
            const caret = e.target.selectionStart ?? e.target.value.length
            mention.sync(e.target.value, caret)
            command.sync(e.target.value, caret)
          }}
          onSelect={(e) => {
            // Re-derive the anchor on every caret move, as the Home composer does.
            const el = e.currentTarget
            const caret = el.selectionStart ?? el.value.length
            mention.sync(el.value, caret)
            command.sync(el.value, caret)
          }}
          onPaste={(event) => {
            if (!onAttachFiles) return
            const selected = clipboardFiles(event.clipboardData)
            if (!selected.length) return
            event.preventDefault()
            onAttachFiles(selected)
          }}
          onKeyDown={(e) => {
            // History first: a recalled `/cmd` or `@name` must not hand Up/Down to a picker mid-walk.
            if (recall.handleKeyDown(e)) return
            if (e.key === 'Tab' && !e.shiftKey && !draft && suggestion) {
              e.preventDefault()
              setPgInput(sessionId, suggestion)
              return
            }
            if (command.handleKeyDown(e)) return
            if (mention.handleKeyDown(e)) return
            // Enter sends, except mid-IME composition, during a mention join, or with Shift (a newline).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !mention.joining) {
              e.preventDefault()
              onSend()
            }
          }}
        />
      </div>
      <MentionMenu
        options={mention.matches}
        activeIndex={mention.activeIndex}
        coords={mention.coords}
        onHover={mention.setActiveIndex}
        onPick={mention.pick}
      />
      {(commands || (controls?.length ?? 0) > 0) && (
        <CommandMenu
          options={command.matches}
          activeIndex={command.activeIndex}
          coords={command.coords}
          iconOf={commands?.iconOf ?? noOwnerIcon}
          showOwner={commands?.multi ?? false}
          gaps={runtimeCommands.gaps}
          onHover={command.setActiveIndex}
          onPick={command.pick}
        />
      )}
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
  const t = useTranslations('Sessions.detail')
  const hasText = usePgDraftHasText(sessionId)
  // Stop only while the composer is empty; a drafted follow-up still sends (queued or steered) mid-turn.
  const stop = busy && !hasText && !hasImage
  return (
    <SendButton
      stop={stop}
      className="-ml-1"
      label={stop ? t('stopResponse') : t('sendMessage')}
      onClick={() => (stop ? onStop() : onSend())}
      disabled={!stop && (imagePreparing || mentionJoining || (!hasText && !hasImage))}
    />
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
  kind,
  agent,
  orgPath,
  flatView = false,
  bordered = false
}: {
  relation: SessionRelationDto
  /** The edge, drawn as words around the title: the session that started this one, or one this one called or woke. */
  kind: 'startedBy' | 'references'
  agent?: Agent
  orgPath: (path: string) => string
  flatView?: boolean
  bordered?: boolean
}) {
  const t = useTranslations('Sessions.panel')
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
        <span
          data-related-row={kind}
          className="truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          {t.rich(kind, {
            name: title,
            session: (chunks) => <span className="font-semibold text-(--text-primary)">{chunks}</span>
          })}
        </span>
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

/** The Sessions tab's Related list on a phone: one flat, labelled list of real sessions, tasks left out. */
function MobileSessionFamilyLinks({
  parents,
  children,
  agentById,
  orgPath,
  flatView = false,
  childOriginById
}: {
  /** Whatever started this page: one parent for a session, one per member woken from another room for a conversation. */
  parents: SessionRelationDto[]
  /** Whatever this page called or woke. */
  children: SessionRelationDto[]
  agentById: ReadonlyMap<string, Agent>
  orgPath: (path: string) => string
  flatView?: boolean
  /** Callee id → the member agent that called it (conversation mode), drawn as a "via" line. */
  childOriginById?: ReadonlyMap<string, string>
}) {
  const t = useTranslations('Sessions.detail')
  const tp = useTranslations('Sessions.panel')
  const startedBy = relatedSessions(parents)
  const references = relatedSessions(children)
  if (startedBy.length === 0 && references.length === 0) return null
  return (
    <div data-related-card="" className="card mx-4 mt-4 overflow-hidden px-4 desktop:hidden">
      <div className="pt-[10px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase">
        {tp('related')}
      </div>
      {startedBy.map((parent, index) => (
        <SessionRelationLink
          key={parent.id}
          relation={parent}
          kind="startedBy"
          agent={agentById.get(parent.agentId)}
          orgPath={orgPath}
          flatView={flatView}
          bordered={index > 0}
        />
      ))}
      {references.map((child, index) => {
        const origin = childOriginById?.get(child.id)
        const previousOrigin = index > 0 ? childOriginById?.get(references[index - 1]!.id) : undefined
        const originAgent = origin ? agentById.get(origin) : undefined
        const newGroup = origin !== undefined && origin !== previousOrigin
        return (
          <div key={child.id}>
            {newGroup && (
              <div className="pt-[8px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-(--text-tertiary)">
                {t('viaAgent', { agent: originAgent ? agentLabel(originAgent) : origin })}
              </div>
            )}
            <SessionRelationLink
              relation={child}
              kind="references"
              agent={agentById.get(child.agentId)}
              orgPath={orgPath}
              flatView={flatView}
              bordered={(startedBy.length > 0 || index > 0) && !newGroup}
            />
          </div>
        )
      })}
    </div>
  )
}

/** The one-line header's quiet icon buttons and its place chip. */
const HEADER_ICON_BTN =
  'flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[6px] text-(--text-tertiary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary)'
const HEADER_CHIP_BASE =
  'inline-flex h-6 min-w-0 flex-[0_1_auto] items-center gap-1 rounded-[6px] px-[7px] font-sans text-[12px] font-medium leading-normal'
// A chip that opens its thread reads as a link; one without a thread stays plain text.
const HEADER_CHIP_LINK = `${HEADER_CHIP_BASE} text-(--text-link) no-underline transition-colors hover:bg-(--surface-hover)`
const HEADER_CHIP = `${HEADER_CHIP_BASE} text-(--text-secondary)`

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
  },
  // PR's `external-link` action is spliced on below, once a 200 has carried a URL for it to open.
  { key: 'pr', label: 'PR', icon: 'git-pull-request' },
  // This turn's tasks the runtime reports, and the tasks AgentConnect manages for the session, in one tab.
  {
    key: 'tasks',
    label: 'Tasks',
    icon: 'list-checks',
    actionIcon: 'refresh-cw',
    actionLabel: 'Refresh tasks'
  },
  // The focused agent's Computers: watch, expand and take control (computer-use.md §10).
  { key: 'computer', label: 'Computer', icon: 'monitor' }
]

/** Loading keeps the same dock + body tracks as the transcript; a resolved 404 opts out, so its card gets the whole content wrap. */
// Asks once per card and session; a child so the request can follow the view's early returns without breaking hook order.
function FillOpener({ open }: { open: () => void }) {
  useEffect(() => open(), [])
  return null
}

function SessionDetailFrame({ children, withDock = true }: { children: ReactNode; withDock?: boolean }) {
  return (
    <div className="flex min-h-full items-stretch">
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
  const base = ['The session doesn’t exist or has been removed.', 'You aren’t authorized to see this session.']
  if (!providerName) {
    return base
  }
  if (profileLinked === false) {
    return [...base, `Your ${providerName} profile isn’t linked.`]
  }
  if (profileLinked === true) {
    return [...base, `Your linked ${providerName} profile belongs to a different workspace.`]
  }
  return [...base, `Your ${providerName} profile isn’t linked or belongs to a different workspace.`]
}

export default function SessionDetailView() {
  const t = useTranslations('Sessions.detail')
  const permissionT = useTranslations('Common.permissionModes')
  const tState = useTranslations('Common.stateIcon')
  const tShare = useTranslations('Sessions.share')
  const tt = useTranslations('Common.taskThread')
  const runtimeModelT = useTranslations('Agents.dialog.runtimeModel')
  const commandMenuT = useTranslations('Common.commandMenu')
  const acpRegistry = useAcpRegistry()
  const { activeOrg, orgPath, myRole } = useOrgs()
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
  const viewerRepo = searchParams.get('repo') || undefined
  // Which read of that path is on screen (§4's M2 addition to the same param set): the file, its unstaged diff, or its staged diff. A value this console does not know degrades to File mode — the one read every workspace can answer — rather than to an error.
  const viewerMode = viewerModeFromParam(searchParams.get('mode'))
  // REPLACE, never push. The viewer is a pane mode inside one route, not a place: pushing would spend a history entry per tree click, so a reader who read six files would need seven Back presses to leave the session, and Back would stop meaning "leave this session". The cost, accepted: Back does not step file-by-file within a visit. Writing through URLSearchParams is also what makes a path with slashes and spaces round-trip — `router.replace` on `.toString()`, `searchParams.get` back.
  const setViewerFile = useCallback(
    (next: string | null, agentId?: string | null, mode: ViewerMode = 'file', repo?: string) => {
      const query = new URLSearchParams(searchParams)
      if (next) query.set('file', next)
      else query.delete('file')
      // The workspace travels with the path, so the link resolves to the checkout it was made from rather than to whichever agent the header happens to focus on reopening.
      if (next && agentId) query.set('agent', agentId)
      else query.delete('agent')
      if (next && repo) query.set('repo', repo)
      else query.delete('repo')
      // File mode is the DEFAULT, so it writes no parameter at all: an M1 link stays byte-identical, and closing the viewer takes the mode with the path rather than leaving a mode behind for the next file opened.
      if (next && mode !== 'file') query.set('mode', mode)
      else query.delete('mode')
      const search = query.toString()
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )
  // Merged conversation mode (§5.3): the stable REPRESENTATIVE drives every session-scoped affordance; peers only feed the transcript and roster.
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
  const resolvedConversationMembers = conversationKey ? (conversationRoster?.sessions ?? null) : null
  // Pinned per key so a reply from another member never swaps the page's session out from under the reader.
  const [pinnedRepresentative, setPinnedRepresentative] = useState({ scope: '', sessionId: '' })
  const conversationRepresentativeId = pickConversationRepresentative(
    resolvedConversationMembers,
    pinnedRepresentative.scope === conversationKey ? pinnedRepresentative.sessionId : null,
    conversationRoster?.representativeSessionId
  )
  useEffect(() => {
    if (!conversationKey || !conversationRepresentativeId) return
    setPinnedRepresentative((current) =>
      current.scope === conversationKey && current.sessionId === conversationRepresentativeId
        ? current
        : { scope: conversationKey, sessionId: conversationRepresentativeId }
    )
  }, [conversationKey, conversationRepresentativeId])
  const conversationMembers = useMemo(
    () =>
      resolvedConversationMembers
        ? representativeFirst(resolvedConversationMembers, conversationRepresentativeId)
        : null,
    [resolvedConversationMembers, conversationRepresentativeId]
  )
  const id = conversationKey ? (conversationRepresentativeId ?? '') : (routeId ?? '')
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
  // The composer's recipient in a continued multi-agent conversation — one member at a time, scoped to this key.
  const [composerPick, setComposerPick] = useState({ scope: '', agentId: '' })
  // Every member session this page sent into, so a later pick never unconfirms an earlier turn's live prompt.
  const [sentSessionIds, setSentSessionIds] = useState({ scope: '', ids: [] as string[] })
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
    memberSets,
    orgSetIds,
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
    getPgFiles,
    setPgFiles,
    getPgWorktree,
    isPgBusy,
    isPgTurnUnstreamed,
    setPgImage,
    pgSend,
    pgNotice,
    pgAttach,
    markSessionTarget,
    getPgQueue,
    pgCancelQueued,
    pgAddAgent,
    pgRemoveAgent,
    pgSetModel,
    pgStageRuntime,
    pgSetEffort,
    pgSetPermissionPreset,
    pgSetFast,
    pgSetWorktree,
    pgAnswerElicitation,
    pgAppRpc,
    pgCloseApp,
    pgAnswerFill,
    pgOpenFill,
    pgCancel,
    getPgRelayFeatures,
    getPgTurnThread
  } = usePlayground()
  const { user: viewer, me } = useProfile()
  // The header's Share dialog: who can see the session, and its link.
  const [shareOpen, setShareOpen] = useState(false)
  // A message's Share: the page's Share dialog, its Copy link pointing at that message.
  const [messageShare, setMessageShare] = useState<string | null>(null)
  const detailTooltipId = useId()
  const requestsTooltipId = useId()
  const {
    ref: detailPopoverRef,
    open: detailOpen,
    setPresence: updateDetailPresence,
    toggleTap: toggleDetailTap,
    reset: resetDetailPopover
  } = useHeaderPopover()
  const requestsPopover = useHeaderPopover()
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
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The visibility the user last chose for a bot turn's collapsed "work" panel (keyed
  // by turn index). Every panel starts collapsed — streaming included — see
  // workPanelOpen(). The toggle records the opposite of the EFFECTIVE on-screen state.
  const [workOverride, setWorkOverride] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const toggleWork = (key: string, currentOpen: boolean) =>
    setWorkOverride((prev) => toggleWorkPanel(prev, key, currentOpen))
  const [imagePreparing, setImagePreparing] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [fillOpenError, setFillOpenError] = useState<string | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [composerMenuOpen, setComposerMenuOpen] = useState<ComposerMenuKey | null>(null)
  // Mirrors ComposerTextarea's mention.joining (isolated from this component
  // to keep typing cheap) — true while a picked @mention's mid-conversation
  // join is still in flight, so the separately-isolated Send button can
  // disable itself for the same reason ComposerTextarea holds off Enter-send.
  const [mentionJoining, setMentionJoining] = useState(false)
  // The last `/` pick, if any — consumed (and cleared) by the next send; see onPgSend.
  const commandPickRef = useRef<{ agentId: string; name: string } | null>(null)
  const [runtimeSelections, setRuntimeSelections] = useState<
    Record<string, { runtime?: string; model?: string; effort?: string; permissionPreset?: string; fast?: boolean }>
  >({})
  const [worktreeSelections, setWorktreeSelections] = useState<Record<string, boolean>>({})
  // A rail row already carries enough metadata to paint the next session while
  // its detail/transcript requests catch up. Keeping it here also holds the
  // agent-filtered rail steady instead of briefly dropping it between ids.
  const [routeSession, setRouteSession] = useState<Session | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imagePrepareGenerationRef = useRef(0)
  // The drop handler is bound below the view's early returns, so the hook reaches it through a ref.
  const onDropFilesRef = useRef<(files: File[]) => void>(() => {})
  const fileDrop = useFileDrop((files) => onDropFilesRef.current(files))
  // The drop target starts under the header, which rises out of the drop zone on desktop.
  const [dropHeader, setDropHeader] = useState<HTMLDivElement | null>(null)

  const pgSession = getPgSession(id)
  const localSession =
    pgSession ??
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
    value === 'googlechat'
      ? 'google'
      : value === 'msteams'
        ? 'azuread'
        : value === 'slack' ||
            value === 'google' ||
            value === 'github' ||
            value === 'gitlab' ||
            value === 'lark' ||
            value === 'feishu' ||
            value === 'telegram' ||
            value === 'discord'
          ? value
          : undefined
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
  // Each other member's own continuation verdict — the representative's says nothing about theirs.
  const otherMemberIds = conversationMode
    ? (conversationMembers ?? []).flatMap((member) => (member.sessionId !== id ? [member.sessionId] : [])).join(',')
    : ''
  const { data: otherMemberDetails } = useSWR(
    otherMemberIds && activeOrg?.id ? (['conversation-member-details', activeOrg.id, otherMemberIds] as const) : null,
    async ([, orgId, ids]) => {
      const details = await Promise.all(
        ids.split(',').map((sessionId) => fetchSessionDetail(sessionId, orgId).catch(() => null))
      )
      return new Map(details.flatMap((detail) => (detail ? [[detail.id, detail] as const] : [])))
    }
  )
  const memberContinuable = (sessionId: string): boolean => otherMemberDetails?.get(sessionId)?.canContinue === true
  // A hook conversation continued through its representative reaches every member by @mention (#2500); a chat one mirrors per member, so it keeps the one-member pick.
  const wholeConversation =
    conversationMode && conversationRoster?.platform === 'hook' && currentSessionDetail?.canContinue === true
  // A pick that can no longer continue falls back to the representative rather than locking the composer on it.
  const composerMember =
    conversationMode && !wholeConversation && composerPick.scope === conversationKey
      ? conversationMembers?.find(
          (member) =>
            member.agentId === composerPick.agentId && member.sessionId !== id && memberContinuable(member.sessionId)
        )
      : undefined
  const composerSessionId = composerMember?.sessionId ?? id
  // A whole-conversation send can land in any member, so every member's rows confirm its live prompt.
  const promptSessionIds = wholeConversation
    ? (conversationMembers ?? []).map((member) => member.sessionId)
    : sentSessionIds.scope === (conversationKey ?? '')
      ? [...sentSessionIds.ids, composerSessionId]
      : [composerSessionId]
  const composerDetail = composerMember
    ? (otherMemberDetails?.get(composerMember.sessionId) ?? null)
    : currentSessionDetail
  const detailSession = currentSessionDetail ? sessionFromDetailDto(currentSessionDetail) : null
  // A live playground session's status frames outrank the detail; a list or rail row takes the detail's run config.
  const rowSession =
    localSession && localSession !== pgSession ? mergeSessionDetailRunConfig(localSession, detailSession) : localSession
  // The detail snapshot, refreshed independently of the list, supplies the authoritative token and cost totals.
  const sessionMerged = rowSession ? mergeSessionDetailUsage(rowSession, detailSession) : detailSession
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
  const decisionCatalog = useOptionalDecisionsPrototype()
  const agentRuntime = runtimeSelections[session?.id ?? '']?.runtime || session?.runtime || owner?.runtime || ''
  // Hoisted above this component's loading / not-found returns: a deep link renders it
  // before `session` resolves, and a hook called only on the later render would change the
  // hook count between renders. The model catalogs live on the single-daemon read; until
  // it lands this is the fleet row.
  const owningDaemonId = session?.daemon && session.daemon !== '—' ? session.daemon : owner?.daemon
  const owningDaemon = useDaemonDetail(
    (owningDaemonId && owningDaemonId !== '—' ? daemons.find((d) => d.daemonId === owningDaemonId) : undefined) ??
      (owner ? agentCapabilitySource(owner, daemons, memberSets) : undefined)
  )

  // A real (CP) session arrives with an empty `steps` — its transcript is a separate on-demand pull
  // from the owning daemon. Playground + mock sessions carry their own steps, so they never fetch.
  const sid = session?.id
  const aid = session?.agentId
  const wantTranscript = !!session && session.platform !== 'playground' && session.steps.length === 0 && !!aid
  const sessionBusy = session ? isPgBusy(session.id) : false
  const sessionBusyRef = useRef(sessionBusy)
  sessionBusyRef.current = sessionBusy
  // A coordinator's thread shape: webchat's own, or what its platform module declares (webchat-threads.md §7).
  const threadShape = session?.coordinator === true ? threadShapeOf(session.platform) : undefined
  // The transcript fetch machine (history + live tail + cross-source "load earlier") lives in its
  // own hook; the view decides WHEN to refresh the tail and renders the merged result.
  const {
    msgs,
    msgLoading,
    msgPaging,
    msgErr,
    tailReady,
    transcriptSessionId,
    conversationOffline,
    hasEarlier,
    pagingEarlier,
    conversationLoadedKey,
    threadsView,
    threads: threadSummaries,
    putThread,
    loadEarlier: loadEarlierConversation,
    refreshTail,
    conversationSourcesRef,
    conversationSourceSessionByMessageRef,
    conversationSourceTurnByMessageRef,
    conversationSourcePlatformByMessageRef,
    conversationSourceAgentByMessageRef
  } = useSessionTranscript({
    sid,
    aid,
    wantTranscript,
    sessionPlatform: session?.platform ?? '',
    conversationKey,
    conversationSourceKey,
    conversationMembers,
    conversationRosterPlatform: conversationRoster?.platform ?? undefined,
    sessionBusyRef,
    promptSessionIds,
    // A coordinator's page is roots with their threads' footers where its platform threads (webchat-threads.md §6.1, §7).
    rootsView: !MOCK_MODE && threadShape !== undefined,
    reconcileLiveSteps
  })

  // The Related links the Sessions panel and the mobile card draw: what started the open row and what it called or woke; both drop tasks.
  const familyLinks = useMemo(() => {
    if (conversationFamily) {
      return { parentSessions: conversationFamily.parentSessions, childSessions: conversationFamily.childSessions }
    }
    if (!currentSessionDetail || currentSessionDetail.id !== session?.id) return undefined
    return {
      parentSessions: currentSessionDetail.parentSession ? [currentSessionDetail.parentSession] : [],
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

    // Live parity with relatedTranscriptAgentIds: a visible agent that spoke via a live
    // agent-initiated post (#753) joins the roster now, not on the next full refresh.
    // Adopted webchat keeps its live tail in getLiveSteps; a synthetic Playground
    // session carries its steps on the session row itself.
    if (session && (session.platform === 'webchat' || session.platform === 'playground')) {
      const liveTail = session.platform === 'webchat' ? getLiveSteps(session.id) : session.steps
      for (const step of liveTail) {
        if (step.agentId && agentById.has(step.agentId)) candidates.push({ agentId: step.agentId })
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
    getLiveSteps,
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
  // The Computers granted to the focused agent; its pool computers come through `computerManaged` below.
  const computerIds = useMemo(
    () => (filesAgentId ? (agentById.get(filesAgentId)?.computerUse?.computers ?? []) : []),
    [agentById, filesAgentId]
  )
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
  // A task's owning conversation, whose owner answers the task's requests through it as they would in the side panel.
  const taskOwnerSessionId = sessionDetail?.task ? (sessionDetail.parentSession?.id ?? null) : null
  const { data: taskOwnerDetail } = useSWR<SessionDetailDto>(
    consoleKeys.sessionDetail(activeOrg?.id, taskOwnerSessionId),
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
  // Which lease the Tasks tab reads. Tasks are NOT a checkout, so this waits on neither the worktree gate `filesSessionId` applies nor the isolation round trip Files and Git hold for — a session's background tasks exist whatever it is checked out into, and the CP says so. What it does need is the CANONICAL session id the lease is keyed by, which is what the focus options already carry. A playground session the daemon has not created yet has no canonical id and no tasks either, so it gets no tab rather than a 404 notice.
  const tasksSessionId =
    headerFocusSessionId && !(syntheticPlayground && headerFocusSessionId === session?.id) ? headerFocusSessionId : null
  // An agent on a managed computer has one without any grant: its own kept desktop or this session's fresh one.
  const computerManaged = useMemo(
    () =>
      filesAgentId && agentById.get(filesAgentId)?.computerUse?.managed
        ? { agentId: filesAgentId, sessionId: tasksSessionId }
        : undefined,
    [agentById, filesAgentId, tasksSessionId]
  )
  // The PR tab's scope: the OPEN SESSION — in a merged conversation its representative — because the hook run the CP resolves belongs to the session, not to a participant. Header focus deliberately plays NO part here: focusing another agent re-aims Files/Git/Tasks at that agent's checkout or lease, but a focus change must not re-key this read (§3.4). A synthetic playground id names no CP row and was never hook-dispatched, so it gets no probe rather than a manufactured 404.
  const prSessionId =
    MOCK_MODE || !session || (syntheticPlayground && !session.realSessionId)
      ? null
      : (session.realSessionId ?? session.id)
  // Whether the Tasks tab reads the focused session's delegated tasks: that agent is in assistant mode or its daemon lists every agent's.
  const subsessionsAgent = filesAgentId ? agentById.get(filesAgentId) : undefined
  const subsessionsListed =
    !!subsessionsAgent &&
    activityScope(
      subsessionsAgent.assistantMode?.enabled === true,
      agentCapabilitySource(subsessionsAgent, daemons, memberSets)?.caps.features
    ) !== null
  const subsessionsSessionId = !MOCK_MODE && subsessionsListed ? tasksSessionId : null
  // An isolated session's own wake, with its own agent; the panel presses it only when the read says this session's arm places the watcher.
  const prSessionIsolation =
    currentSessionDetail && currentSessionDetail.id === prSessionId
      ? currentSessionDetail.workspaceIsolation
      : session?.workspaceIsolation
  const prWakeAgentId = prSessionId !== null && prSessionIsolation === 'session' ? session?.agentId : undefined
  // While this page is open and on screen, hold the agent's sandbox against the daemon's idle sweep —
  // but only for what the DAEMON finds worth holding (uncommitted files in this session's worktree, an
  // armed merge-when-ready watcher). A lease with nothing to release: closing the page stops the
  // renewals and the hold lapses on its own, which is what the whole feature rests on.
  useSandboxKeepAlive(prSessionId)
  // Whether the Git tab's read is about the SAME worktree the PR tab is keyed to. The two scopes are
  // deliberately different — Files/Git follow header focus, the PR tab follows the open session — so
  // only an exact match makes the branch it read this session's branch, and only then may the PR tab
  // draw a no-PR state off it: otherwise participant B's checkout would both name its branch in, and
  // expose the action of, session A. A shared-workspace session reads the agent's PRIMARY checkout,
  // which is no session branch at all, so `sessionWorktreeScope` (the same gate `filesSessionId`
  // applies, computed here because the dock's tab list is built above where that lives) never holds.
  const prBranchScoped =
    prSessionId !== null &&
    headerFocusSessionId === prSessionId &&
    focusedAgent?.workspace.mode === 'git' &&
    focusedAgent.workspace.provider === 'github' &&
    (focusedSessionDetail?.workspaceIsolation ?? focusedSession?.workspaceIsolation) === 'session' &&
    !(focusedSessionDetail?.contentPurgedAt ?? focusedSession?.contentPurgedAt)
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
  } = useSessionList(
    MOCK_MODE || !railQuery ? null : activeOrg?.id,
    // Tasks belong to their session's Tasks tab, so the rail lists sessions only, as All sessions does by default.
    { ...(railQuery ?? {}), excludeTasks: true },
    { grouped: !flatView }
  )
  // Which panel is on screen. Sessions is where a session page opens; every other tab is one the reader asked for.
  // Unset until the reader picks one: a coordinator's page opens on Tasks, any other on Sessions.
  const [dockTab, setDockTab] = useState<string | null>(null)
  // A closed drawer leaves its panels mounted, so the Computer viewer must hear that it is off screen and hand control back.
  const [dockVisible, setDockVisible] = useState(true)
  // The thread open in the side panel, a task's or a root's, held for the session it was opened in; expanding one opens its own page.
  const [taskThread, setTaskThread] = useState<{
    scope: string
    link?: TaskLink
    rootId?: string
    /** Opened by Reply in thread, so its composer takes the caret. */
    focus?: boolean
  } | null>(null)
  const isMobile = useIsMobile()
  const openThread = taskThread?.scope === id ? (taskThread.link ?? null) : null
  const openRoot = taskThread?.scope === id ? (taskThread.rootId ?? null) : null
  const threadOpen = openThread !== null || openRoot !== null
  const coordinatorPage = session?.coordinator === true
  // A task's own page, also its expanded view: a `subsession:` task, or one the CP says some session owns (a threaded task).
  const taskOwnPage = session?.subsession === true || currentSessionDetail?.task === true
  // Whether this page has a task list to show: its agent and a real (not yet-to-be-created playground) session.
  const taskListAvailable = !MOCK_MODE && filesAgentId !== null && tasksSessionId !== null
  // Bumped when a task opens in the side panel, so a collapsed dock comes on screen to show it.
  const [dockReveal, setDockReveal] = useState(0)
  // A coordinator's tasks by the message each was opened for, read only on a coordinator's own page.
  const tasksByMessage = useTasksByMessage(
    filesAgentId ?? '',
    session?.coordinator && filesAgentId === session.agentId ? subsessionsSessionId : null
  )
  // The open root is the page's `?thread=`; the param last acted on, so an address this page wrote is not read back as a new one.
  const threadParam = coordinatorPage ? searchParams.get('thread') : null
  const handledThreadParam = useRef<string | null>(null)
  const setThreadParam = useCallback(
    (rootId: string | null) => {
      const current = new URLSearchParams(searchParams.toString())
      if ((current.get('thread') ?? null) === rootId) return
      handledThreadParam.current = rootId
      if (rootId) current.set('thread', rootId)
      else current.delete('thread')
      router.replace(`${pathname}${current.size ? `?${current}` : ''}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )
  // The Tasks list and a task the coordinator opens on its own show the task in the side panel, bringing it on screen.
  const openTaskThread = useCallback(
    (link: TaskLink) => {
      setTaskThread({ scope: id, link })
      setDockTab('tasks')
      setDockReveal((n) => n + 1)
      setThreadParam(null)
    },
    [id, setThreadParam]
  )
  // A root's thread, from its footer, its label, Reply in thread or the address.
  const openRootThread = useCallback(
    (rootId: string, options: { focus?: boolean; address?: boolean } = {}) => {
      setTaskThread({ scope: id, rootId, ...(options.focus ? { focus: true } : {}) })
      setDockTab('tasks')
      setDockReveal((n) => n + 1)
      if (options.address !== false) setThreadParam(rootId)
    },
    [id, setThreadParam]
  )
  const closeThread = useCallback(() => {
    setTaskThread(null)
    setThreadParam(null)
  }, [setThreadParam])
  // Acts on a change of the address only, and not on one this page wrote, which lands a render after the panel moved.
  const seenThreadParam = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (threadParam === seenThreadParam.current) return
    seenThreadParam.current = threadParam
    if (threadParam === handledThreadParam.current) return
    handledThreadParam.current = threadParam
    if (namesThread(threadShape, threadParam)) openRootThread(threadParam, { address: false })
    // An address that no longer names a thread closes the one it named.
    else if (!threadParam) setTaskThread((current) => (current?.rootId ? null : current))
  }, [openRootThread, threadParam, threadShape])
  // A task shrunk from its own page comes back as `?task=`: open it in the side panel once, then drop the parameter.
  const shrunkTaskId = coordinatorPage ? searchParams.get('task') : null
  useEffect(() => {
    if (!shrunkTaskId) return
    openTaskThread({ title: '', sessionId: shrunkTaskId, how: 'opened' })
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete('task')
    router.replace(`${pathname}${rest.size ? `?${rest}` : ''}`)
  }, [openTaskThread, pathname, router, searchParams, shrunkTaskId])
  // A task the coordinator opens or hands a message to while the reader watches comes on screen in the dock.
  const followedTaskPosts = useRef<{ scope: string; seen: Set<string> } | null>(null)
  const coordinatorLive = session?.coordinator ? getLiveSteps(session.id) : null
  useEffect(() => {
    if (!coordinatorLive || !session) return
    const posts = coordinatorLive.flatMap((step) => (step.taskLink && step.postId ? [step] : []))
    // Links already on screen when the page opened were read before; only one arriving now moves the dock.
    if (followedTaskPosts.current?.scope !== session.id) {
      followedTaskPosts.current = { scope: session.id, seen: new Set(posts.map((step) => step.postId!)) }
      return
    }
    const { seen } = followedTaskPosts.current
    const fresh = posts.filter((step) => !seen.has(step.postId!))
    for (const step of fresh) seen.add(step.postId!)
    const latest = fresh[fresh.length - 1]?.taskLink
    if (latest) openTaskThread(latest)
  }, [coordinatorLive, openTaskThread, session])
  // On a desktop, a thread whose first reply starts while the reader watches opens beside the chat (webchat-threads.md §6.2).
  const autoOpen = useRef<{ scope: string; state: ThreadAutoOpen } | null>(null)
  const threadsLoaded = threadsView && transcriptSessionId === sid && msgs !== null
  useEffect(() => {
    if (!threadsLoaded || !session || isMobile) return
    if (autoOpen.current?.scope !== session.id) autoOpen.current = { scope: session.id, state: threadAutoOpen() }
    const rows = (msgs ?? []).flatMap((m) => {
      const rootId = m.postId ?? m.ts
      return !m.thread &&
        namesThread(threadShape, rootId) &&
        (m.kind || 'text').toLowerCase() === 'text' &&
        m.sender !== session.agentId
        ? [{ rootId, replies: threadSummaries.get(rootId)?.replies ?? 0 }]
        : []
    })
    const footers = [...threadSummaries.values()].map(({ rootId, replies }) => ({ rootId, replies }))
    const next = threadToAutoOpen(
      autoOpen.current.state,
      [...rows, ...footers],
      liveReplyThreads(coordinatorLive ?? [])
    )
    if (next) openRootThread(next)
  }, [coordinatorLive, isMobile, msgs, openRootThread, session, threadShape, threadSummaries, threadsLoaded])
  // The Files tab's `refresh-cw` action: re-reads the tree and the git status without remounting the panel, so the reader's filter and expanded folders survive it.
  const [filesRefreshTick, setFilesRefreshTick] = useState(0)
  // Reported by the panel, like the Sessions verdict: only it knows whether its first root listing has answered.
  const [filesRootSettled, setFilesRootSettled] = useState(false)
  // The Git tab's own `refresh-cw`, and the verdict it reports — its settle state feeds the tab status, its changed count the tab's badge.
  const [gitRefreshTick, setGitRefreshTick] = useState(0)
  // The ORG role, which is what the CP gates these writes on (`denyViewerWrite`): a viewer gets the
  // read surface M2 shipped and is told so, rather than offered a control the route will refuse.
  // The demo tour has no daemon to write to at all.
  const canWriteWorkspace = !MOCK_MODE && myRole !== 'viewer'
  // The viewer's own stage/unstage moved the index, so the panel's status and its log are stale.
  const onViewerIndexChanged = useCallback(() => setGitRefreshTick((tick) => tick + 1), [])
  // A write from the PANEL moves the index the other way: the open diff now describes a tree that
  // moved, and the Files tree's status tags with it. The panel applies the fresh status its own
  // reply carried, so it is the only reader here that does NOT need a re-read.
  const [viewerDiffTick, setViewerDiffTick] = useState(0)
  const onPanelWrote = useCallback(() => {
    setViewerDiffTick((tick) => tick + 1)
    setFilesRefreshTick((tick) => tick + 1)
  }, [])
  const [gitVerdict, setGitVerdict] = useState<GitPanelVerdict>({
    settled: false,
    changed: null,
    branch: null,
    tracking: null,
    base: null
  })
  // The Tasks tab's own `refresh-cw` and verdict: its settle state feeds the tab status, whether it has anything the tab's presence, its running count the badge.
  const [tasksRefreshTick, setTasksRefreshTick] = useState(0)
  const [tasksVerdict, setTasksVerdict] = useState<TasksPanelVerdict>(TASKS_UNSETTLED)
  // The PR tab's verdict, reported by its panel: whether this session HAS a linked run at all (`none` drops the tab), the unresolved-thread badge, and the URL its `external-link` action opens.
  const [prVerdict, setPrVerdict] = useState<PullRequestPanelVerdict>({
    answer: 'pending',
    unresolved: null,
    url: null
  })
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
  // Tasks has no isolation branch to wait on, so its status is only ever "has the read answered".
  const tasksStatus = tasksTabStatus(tasksVerdict.settled)
  // PR: `loading` until the probe's first answer, `ready` after — and a `none` answer removes the tab below, so `empty` never has a state left to describe.
  const prStatus = pullRequestTabStatus(prVerdict.answer)
  const localizedDockTabs = useMemo<DockTab[]>(
    () =>
      DOCK_TABS.map((tab) => ({
        ...tab,
        label:
          tab.key === 'sessions'
            ? t('sessions')
            : tab.key === 'files'
              ? t('files')
              : tab.key === 'git'
                ? t('git')
                : tab.key === 'pr'
                  ? t('pullRequest')
                  : tab.key === 'computer'
                    ? t('computer')
                    : t('tasks'),
        ...(tab.key === 'files'
          ? { actionLabel: t('refreshFiles') }
          : tab.key === 'git'
            ? { actionLabel: t('refreshGit') }
            : tab.key === 'tasks'
              ? { actionLabel: t('refreshTasks') }
              : {})
      })),
    [t]
  )
  // Each tab's own verdict, spliced onto the static descriptors. Files is dropped outright rather than left `loading` forever when there is no agent behind it — a tab that can never answer is not a tab — and the demo tour has no daemon to read a checkout from at all, so it does not get one either.
  const dockTabs = useMemo<DockTab[]>(
    () =>
      localizedDockTabs
        // A coordinator never touches files, git or a computer, so its panel keeps Tasks, then Sessions.
        .filter((tab) => !coordinatorPage || tab.key === 'sessions' || tab.key === 'tasks')
        // A task's page is its own work: its Files, Git, Tasks and Computer, without the agent's session list.
        .filter((tab) => !taskOwnPage || tab.key !== 'sessions')
        .sort((a, b) => (coordinatorPage ? Number(b.key === 'tasks') - Number(a.key === 'tasks') : 0))
        .filter((tab) =>
          tab.key === 'files' || tab.key === 'git'
            ? filesAgentId !== null && !MOCK_MODE
            : tab.key === 'computer'
              ? (computerIds.length > 0 || computerManaged !== undefined) && !MOCK_MODE
              : tab.key === 'tasks'
                ? // Against its OWN scope (an agent and a canonical session), and dropped once settled with nothing in either group; an open thread keeps it.
                  (threadOpen && !MOCK_MODE) ||
                  // A coordinator's header offers Tasks, so its tab stays wherever a list exists, showing the panel's empty state.
                  (taskListAvailable && (coordinatorPage || tasksTabShown(tasksVerdict)))
                : // PR keeps its tab without one: a 404 only means no pull-request run owns this session, and the panel then draws that branch's state and the action that opens one. That state is drawn only off a git read of THIS session's worktree (`prBranchScoped`) — the focused participant's checkout must not put session A's action on screen — and only when that read found a checkout (`changed !== null` is exactly "the settled read found one"). A linked PR keeps its tab whatever the git scope is: its identity comes from the run, not from a checkout.
                  tab.key !== 'pr' ||
                  (prSessionId !== null &&
                    (prVerdict.answer !== 'none' || (prBranchScoped && gitVerdict.changed !== null)))
        )
        .map((tab) =>
          tab.key === 'sessions'
            ? { ...tab, status: sessionsStatus, loadingPlaceholder: <SessionsPanelSkeleton /> }
            : tab.key === 'files'
              ? { ...tab, status: filesStatus }
              : tab.key === 'git'
                ? {
                    ...tab,
                    status: gitStatus,
                    // The badge is the changed-file count, omitted rather than shown as `0`: a clean tree wears no pill, and neither does a workspace whose status could not be read.
                    ...(gitVerdict.changed ? { badge: gitVerdict.changed } : {})
                  }
                : tab.key === 'pr'
                  ? {
                      ...tab,
                      status: prStatus,
                      // Unresolved review threads (§1's table), omitted rather than shown as `0` — and omitted while degraded, where the count is unknown rather than zero.
                      ...(prVerdict.unresolved ? { badge: prVerdict.unresolved } : {}),
                      // The design's header action opens the PR's own page; withheld until an answer has carried a URL to open.
                      ...(prVerdict.url ? { actionIcon: 'external-link', actionLabel: t('openPullRequest') } : {})
                    }
                  : tab.key === 'tasks'
                    ? {
                        ...tab,
                        status: threadOpen ? 'ready' : tasksStatus,
                        // Running tasks only, and omitted rather than shown as `0`: an idle session wears no pill, and neither does an untracked one, whose count is null rather than zero.
                        ...(tasksVerdict.running ? { badge: tasksVerdict.running } : {})
                      }
                    : tab
        ),
    [
      computerIds.length,
      computerManaged,
      coordinatorPage,
      taskOwnPage,
      filesAgentId,
      filesStatus,
      gitStatus,
      gitVerdict.changed,
      prBranchScoped,
      prSessionId,
      prStatus,
      prVerdict.answer,
      prVerdict.unresolved,
      prVerdict.url,
      sessionsStatus,
      localizedDockTabs,
      threadOpen,
      taskListAvailable,
      tasksSessionId,
      tasksStatus,
      tasksVerdict
    ]
  )
  // The active tab has to be one that exists: a Files tab dropped under the reader would otherwise leave the dock with no active tab and an unlabelled panel.
  const dockTabKey =
    dockTab !== null && dockTabs.some((tab) => tab.key === dockTab)
      ? dockTab
      : coordinatorPage && dockTabs.some((tab) => tab.key === 'tasks')
        ? 'tasks'
        : taskOwnPage && dockTabs.some((tab) => tab.key === 'files')
          ? 'files'
          : (dockTabs[0]?.key ?? DOCK_TABS[0]!.key)
  const railSeedWidened = !MOCK_MODE && railSeedKeyNow !== '' && widenedSeed === railSeedKeyNow
  const { sessions: widenedRailRows, total: widenedRailTotal } = useSessionList(
    railSeedWidened ? activeOrg?.id : null,
    { excludeTasks: true },
    { grouped: !flatView }
  )
  const railSessionRows = railSeedWidened ? widenedRailRows : seededRailRows
  const railSessionTotal = railSeedWidened ? widenedRailTotal : seededRailTotal
  // The chips describe the list on screen, and a widened rail is unfiltered — leaving the seed's chips up would misname it.
  const railDisplayAgentIds = railSeedWidened ? [] : railFilter.agentIds
  const railSessions = useMemo(() => {
    if (!MOCK_MODE) return railSessionRows
    if (!railQuery) return []
    if (railAgentIds.length === 0) return allSessions.filter((s) => !s.subsession)
    if (railAgentIds.length === 1) return getSessions(railAgentIds[0]!).filter((s) => !s.subsession)
    // The demo fixtures carry no conversation grouping, so the channel stands in for it — enough for the multi-agent filter to behave like the real one.
    const channelsOf = (agentId: string) => new Set(getSessions(agentId).map((s) => `${s.platform}\0${s.channel}`))
    const shared = railAgentIds.map(channelsOf).reduce((a, b) => new Set([...a].filter((c) => b.has(c))))
    return allSessions.filter(
      (s) => !s.subsession && railAgentIds.includes(s.agentId ?? '') && shared.has(`${s.platform}\0${s.channel}`)
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
  // The busy flag for the dock's WORKSPACE panels, which follow header focus rather than the open
  // session (§3.4): in a merged conversation it is the focused participant's turn that writes the
  // checkout those panels read, so keying them to the open session would refresh the wrong worktree's
  // reader — and, for a participant nobody focused, never at all.
  const focusBusy = headerFocusSessionId ? isPgBusy(headerFocusSessionId) : sessionBusy

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

  // The CP-resolvable id: a playground/webchat session starts under its synthetic
  // local id (`pg_...`) and only gets a `realSessionId` once the daemon creates the
  // real ACP session — `fetchToolBody` targets the CP, which never knows the
  // synthetic id, so a live tool row's full-body fetch must key off this instead of
  // `sid` (matches the `session.realSessionId ?? session.id` idiom used elsewhere
  // in this file for the same daemon-proxied reads).
  const toolSid = session?.realSessionId ?? sid
  // This component now survives id changes. Do not paint session A's transcript
  // for one frame under session B's header before the loading effect clears it.
  const transcriptMatchesSession = !wantTranscript || transcriptSessionId === sid
  const visibleMsgs = transcriptMatchesSession ? msgs : null
  // Any workspace file downloads; a file the focused session shared is pinned to that share's digest.
  const viewerDownload = useMemo(() => {
    if (!viewerPath) return null
    if (!headerFocusSessionId) return {}
    const target = headerFocusSessionId === sid ? toolSid : headerFocusSessionId
    const rows = (visibleMsgs ?? [])
      .filter((m) => (m.kind || 'text').toLowerCase() === 'text')
      .map((m) => ({ text: m.text, sessionId: conversationSourceSessionByMessageRef.current.get(m) ?? toolSid }))
    return sessionFileDownload(viewerPath, target, rows)
  }, [viewerPath, headerFocusSessionId, sid, toolSid, visibleMsgs, conversationSourceSessionByMessageRef])
  // Binary and large text download through the object store when the viewed agent's daemon presigns transfers.
  const viewerAgent = filesAgentId ? agents.find((a) => a.id === filesAgentId) : undefined
  const viewerTransfer =
    viewerAgent !== undefined && transferCapable(agentCapabilitySource(viewerAgent, daemons, memberSets)?.caps.features)
  const visibleMsgLoading = transcriptMatchesSession ? msgLoading : wantTranscript
  const visibleMsgPaging = wantTranscript && transcriptMatchesSession && msgPaging
  const visibleMsgErr = wantTranscript && transcriptMatchesSession ? msgErr : null
  const visibleTailReady = wantTranscript && transcriptMatchesSession && tailReady
  const visibleHasEarlier = wantTranscript && transcriptMatchesSession && hasEarlier
  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, agentLabel(a)])), [agents])
  // The owner's judged messages: a merged row from another member's source is that member's gate, not this one's.
  const ownsDecisionSeq = (m: SessionMessageDto): boolean => {
    const owner = conversationSourceAgentByMessageRef.current.get(m)
    return m.sender !== session?.agentId && (!owner || owner === session?.agentId)
  }
  const judgedSeqs = useMemo(
    () => (visibleMsgs ?? []).filter(ownsDecisionSeq).map((m) => m.seq),
    [visibleMsgs, session?.agentId, conversationSourceAgentByMessageRef]
  )
  const decisionResults = useSessionDecisionResults(
    { agentId: session?.agentId, platform: session?.platform, channelId: session?.channelId },
    judgedSeqs
  )
  const [openDecisionSeq, setOpenDecisionSeq] = useState<number | null>(null)
  const [openRouting, setOpenRouting] = useState<{
    source: DecisionEvaluationSource
    seq: number
    repoName?: string
  } | null>(null)
  // Who each sender is to the reader: the same reading the thread panel and the sessions list take.
  const people = useSenderPeople(agentNameById)
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
  const isSelf = people.isSelf
  const senderLabel = people.label
  // The composer's Up/Down recall pool: the viewer's own prompts in transcript order, read from
  // whichever source the page renders — fetched rows, or the steps a playground session carries.
  const sessionSteps = session?.steps
  const sessionUser = session?.user
  const composerHistory = useMemo(() => {
    const isSelf = (sender: string) => isSelfSender(sender, me)
    if (wantTranscript) {
      // Source session + `seq`, as rowAnchor below: immutable, and a prepended page cannot move it.
      return composerHistoryFromRows(
        visibleMsgs ?? [],
        isSelf,
        (m) => `${conversationSourceSessionByMessageRef.current.get(m) ?? sid ?? ''}#${m.seq}`
      )
    }
    const prompts = (sessionSteps ?? []).flatMap((stp) =>
      stp.kind === 'msg' ? [{ ...stp, sender: stp.who ?? sessionUser ?? '' }] : []
    )
    return composerHistoryFromRows(prompts, isSelf, (stp) => `live:${stp.turnId}`)
  }, [wantTranscript, visibleMsgs, sessionSteps, sessionUser, me, sid])

  const sessionActivityVersion = sid ? (sessionActivityVersionById[sid] ?? 0) : 0
  useEffect(() => {
    if (!visibleTailReady || sessionBusy) return
    void refreshTail()
  }, [visibleTailReady, sessionBusy, sessionActivityVersion, sessionStreamGeneration, refreshTail])

  // Probe for a still-streaming turn on load and on each activity, since a turn started in another tab never reaches this socket.
  useEffect(() => {
    if (!sid || !session || session.platform !== 'webchat' || session.subsession) return
    if (!session.channelId || !session.agentId) return
    pgAttach(sid, session.agentId, session.channelId)
  }, [
    sid,
    session?.platform,
    session?.subsession,
    session?.channelId,
    session?.agentId,
    pgAttach,
    sessionActivityVersion,
    sessionStreamGeneration
  ])

  // Everything above only APPENDS rows; nothing ever moved the viewport, so a
  // live session's newest output landed below the fold. Follow it — but only for
  // a reader who is already at the bottom (see lib/stick-to-bottom).
  const {
    pin: stickToBottom,
    release: releaseFollow,
    awayFromBottom
  } = useStickToBottom(conversationKey ?? sid ?? null)
  // A message link lands on its message once drawn, reading earlier pages back to it.
  const mainEarlier = { has: visibleHasEarlier, loading: pagingEarlier, load: loadEarlierConversation }
  useLocateMessage('page', releaseFollow, mainEarlier)
  const mainEarlierRef = useRef(mainEarlier)
  useEffect(() => {
    mainEarlierRef.current = mainEarlier
  })
  // A redirected message's label in a thread lands on it on the main timeline, the thread left open beside it.
  const showInConversation = (seq: number) => {
    landOnMessage('page', seq, { release: releaseFollow, earlier: () => mainEarlierRef.current })
  }
  // What this browser last read here, for the NEW line; it advances only while the reader looks at the end.
  const seen = useSeenMarker(MOCK_MODE ? null : (conversationKey ?? sid ?? null), !awayFromBottom)
  // The transcript scroller's scrollbar width, which the composer below it insets by to stay in line with the column.
  const [transcriptScroller, setTranscriptScroller] = useState<HTMLDivElement | null>(null)
  const [transcriptGutter, setTranscriptGutter] = useState(0)
  useEffect(() => {
    if (!transcriptScroller) return
    const measure = () => setTranscriptGutter(transcriptScroller.offsetWidth - transcriptScroller.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(transcriptScroller)
    return () => observer.disconnect()
  }, [transcriptScroller])

  useEffect(() => {
    if (!session || (session.platform !== 'playground' && session.platform !== 'webchat') || !sessionBusy) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [session?.id, session?.platform, sessionBusy])

  // Publish the loaded session's title and status to its route-scoped mobile app bar.
  const { register: registerCrumb } = useCrumbSlot()
  const crumbTitle = session?.title ?? ''
  const crumbStatusKey = session?.status ?? ''
  const crumbStatusLabel = session?.statusLabel || (crumbStatusKey ? status(crumbStatusKey).label : '')
  // The desktop title row renders the same pair the crumb used to badge.
  const headerStatusLabel = crumbStatusLabel
  // The header leads with the one state icon: running while a turn streams here or the session's raw status says so.
  const headerState = sessionState(session?.statusLabel ?? '', sessionBusy)
  useEffect(() => {
    if (!crumbTitle) return
    registerCrumb({
      id,
      title: crumbTitle,
      status: crumbStatusKey,
      statusLabel: crumbStatusLabel
    })
    return () => registerCrumb(null)
  }, [registerCrumb, id, crumbTitle, crumbStatusKey, crumbStatusLabel])

  // Page-local popovers and turn expansion choices must not leak from one
  // session into the next now that the shared route layout preserves this
  // component instance.
  useEffect(() => {
    imagePrepareGenerationRef.current += 1
    setShareOpen(false)
    resetDetailPopover()
    requestsPopover.reset()
    setWorkOverride(new Map())
    setImagePreparing(false)
    setImageError(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
    setAttachMenuOpen(false)
    setComposerMenuOpen(null)
  }, [id])

  // Continuable sessions have no image affordance — drop any staged attachment.
  // Lives ABOVE the early returns (Rules of Hooks), so it re-derives `isContinuable`
  // from raw values instead of the post-return flags below.
  const continuableSessionId =
    session &&
    session.platform !== 'playground' &&
    (session.platform !== 'webchat' || session.subsession === true) &&
    composerDetail?.canContinue === true
      ? session.id
      : null
  useEffect(() => {
    if (!continuableSessionId) return
    setPgImage(continuableSessionId)
    setPgFiles(continuableSessionId, () => [])
  }, [continuableSessionId, setPgImage, setPgFiles])

  // The header's Requests pill counts what waits for this reader, from the list its popover shows; editors only, as that popover is.
  const pendingRequestCount = usePendingRequestCount({
    agentId: session?.agentId ?? '',
    sessionId: session ? (session.realSessionId ?? session.id) : undefined,
    enabled: Boolean(owner?.canEdit && !owner.name.startsWith(MOCK_PREFIX) && session?.agentId)
  })

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
            {notice.retry && <Button onClick={() => void retryConversation()}>{t('tryAgain')}</Button>}
            {notice.action && (
              <Link className="dsbtn dsbtn-primary no-underline" href={notice.action.href}>
                {notice.action.label}
              </Link>
            )}
            <Link className="lnk font-sans text-[12.5px] font-medium leading-normal" href={orgPath('/sessions')}>
              {t('backToSessions')}
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
          title={t('conversationNotFound')}
          pre={t('noConversation')}
          chip={conversationKey}
          post={t('conversationUnavailable')}
          actionLabel={t('backToSessions')}
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
          title={t('sessionUnavailable')}
          pre={t('session')}
          chip={id}
          post={
            <>
              <span className="desktop:whitespace-nowrap">{t('notAvailable')}</span>
              <div className="mx-auto mt-3 w-fit max-w-full text-left">
                <div className="font-medium text-(--text-primary)">{t('possibleReasons')}</div>
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
          actionLabel={t('backToSessions')}
          actionHref={orgPath('/sessions')}
          secondaryAction={
            profileIdentityReady && profileLinkProviderName && profileLinkProvider
              ? {
                  label: profileNeedsLink
                    ? t('linkProfile', { provider: profileLinkProviderName })
                    : t('reviewProfile', { provider: profileLinkProviderName }),
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
  // What the Share dialog says about who can see the focused session, from the same rows the visibility control reads.
  const shareVisibility: ShareVisibility | null =
    headerFocusSessionId && (focusedSessionDetail || focusedSession?.visibility || visibilityLoading)
      ? {
          sessionId: headerFocusSessionId,
          visibility:
            focusedSessionDetail?.visibility ??
            focusedSession?.visibility ??
            (visibilityLoading ? 'private' : undefined),
          state: focusedSessionDetail?.visibilityState ?? null,
          canChange: focusedSessionDetail?.canChangeVisibility === true,
          loading: visibilityLoading,
          externalProvider: focusedSessionDetail?.externalProvider ?? null,
          externalResolution: focusedSessionDetail?.externalResolution ?? null,
          feishuRegion: focusedSessionDetail?.feishuRegion ?? null,
          nativeMemory: focusedAgent?.memoryProvider === 'native',
          onChanged: ({ visibility, state }) => {
            const mutateFocusedDetail =
              headerFocusSessionId === currentSessionDetail?.id ? mutateSessionDetail : mutateExtraHeaderDetail
            void mutateFocusedDetail(
              (current) => (current ? { ...current, visibility, visibilityState: state } : current),
              { revalidate: true }
            )
            void revalidateSessionLists()
          }
        }
      : null
  const isPg = session.platform === 'playground'
  // A task (follow-up, approved proposal or delegated task) is never its conversation's own session.
  const taskPage = session.subsession === true
  // A persisted webchat session is the same surface as the live playground — continue
  // it in place. `isLive` gates the composer/typing affordance for both.
  const isWebchat = session.platform === 'webchat' && !taskPage
  const sessionIntegration = sessionPlatform(session)
  // Header channel chip — resolves a headless `cron:<id>` channel to its schedule.
  const channelDisplay = sessionChannelDisplay(session, (id) => crons.find((c) => c.id === id)?.name)
  const usesIntegrationAvatar = session.platform === 'hook' && sessionIntegration === 'github'
  // A task's thread is no platform thread, so only a delegated task the server lets this caller continue takes messages, console-only (auto-session-mode.md §10).
  const readOnlySubsession = taskPage && composerDetail?.canContinue !== true
  // A follow-up's own page also shows its state and checks, read by its session from a daemon that can.
  const followUpPageAgentId =
    taskPage &&
    !MOCK_MODE &&
    owner &&
    agentCapabilitySource(owner, daemons, memberSets)?.caps.features?.includes(ASSISTANT_TASK_HANDLE_FEATURE)
      ? owner.id
      : null
  // What a task's page opens with, read where its daemon can answer for one task, as the follow-up summary is.
  const taskBriefAgentId =
    taskOwnPage &&
    !MOCK_MODE &&
    owner &&
    agentCapabilitySource(owner, daemons, memberSets)?.caps.features?.includes(ASSISTANT_TASK_HANDLE_FEATURE)
      ? owner.id
      : null
  // Continuation is server-computed (webchat-cross-integration-continuation.md §6.5): a transient blocker disables the composer, unauthorized/unsupported stay read-only.
  const isContinuable = !readOnlySubsession && !isPg && !isWebchat && composerDetail?.canContinue === true
  const continuationReason = composerDetail?.continuationUnavailableReason ?? null
  const continuationBlocked =
    !readOnlySubsession &&
    !isPg &&
    !isWebchat &&
    !isContinuable &&
    (continuationReason === 'agent_moved' ||
      continuationReason === 'daemon_offline' ||
      continuationReason === 'unavailable')
  // The server says whether this caller owns a webchat conversation; a playground they opened is theirs until it answers.
  const ownsThisConversation = currentSessionDetail ? currentSessionDetail.ownsConversation : isPg ? true : undefined
  const canWriteWebchat =
    ownsThisConversation !== false || (currentSessionDetail?.visibility === 'org' && myRole !== 'viewer')
  const isLive = !readOnlySubsession && (isPg || (isWebchat && canWriteWebchat) || isContinuable || continuationBlocked)
  // Where each agent runs NOW: a machine for a `daemon` placement, the set otherwise (a pool matched by `contentSetId`, a group by its holder).
  const placementByAgent = new Map(
    agents.map((agent) => [
      agent.id,
      isSetPlacementKind(agent.placementKind)
        ? { setId: agent.setId, holderDaemonId: agent.holderDaemonId }
        : { daemonId: agent.daemon === '—' ? undefined : agent.daemon }
    ])
  )
  const resumeConversationMembers = liveResumeMembers(
    conversationKey ? conversationMembers : selfConversation?.sessions,
    detailSession?.participants
  )
  const resumeConversationLookupPending = conversationKey
    ? conversationLoading
    : Boolean(selfKey && selfConversationLoading)
  const resumeConversationLookupRequired = Boolean(conversationKey || selfKey)
  const persistedResumeMembers = isWebchat
    ? sessionResumeMembers(
        resumeConversationMembers?.map((member) => ({
          agentId: member.agentId,
          daemonId: member.daemonId,
          contentSetId: member.contentSetId
        })),
        currentSessionDetail
          ? {
              agentId: currentSessionDetail.agentId,
              daemonId: currentSessionDetail.daemonId,
              contentSetId: currentSessionDetail.contentSetId
            }
          : null,
        resumeConversationLookupRequired,
        resumeConversationLookupPending
      )
    : []
  const resumeState = isPg ? 'available' : sessionResumeState(persistedResumeMembers, placementByAgent)
  const resumeDisabled = (isWebchat && resumeState !== 'available') || continuationBlocked
  // Authorized members write in coordinator threads where its daemon and relay both support them.
  const relayFeatures = threadsView && (isWebchat || isContinuable) ? getPgRelayFeatures(session.id) : undefined
  const ownerFeatures = owner ? agentCapabilitySource(owner, daemons, memberSets)?.caps.features : undefined
  const threadsWritable =
    threadsView &&
    isWebchat &&
    isLive &&
    !resumeDisabled &&
    canWriteWebchat &&
    ownerFeatures?.includes(WEBCHAT_THREADS_FEATURE) === true &&
    (relayFeatures === undefined || relayFeatures.includes(WEBCHAT_THREADS_FEATURE))
  // Whoever may continue a platform coordinator writes in its threads too, mirrored there (webchat-threads.md §7).
  const continuedThreadsWritable =
    threadsView &&
    isContinuable &&
    !resumeDisabled &&
    ownerFeatures?.includes(CONTINUATION_THREADS_FEATURE) === true &&
    (relayFeatures === undefined || relayFeatures.includes(CONTINUATION_THREADS_FEATURE))
  const threadWriter = threadsWritable
    ? { sessionId: session.id, ...(session.channelId ? { conversationId: session.channelId } : {}) }
    : continuedThreadsWritable
      ? { sessionId: session.id, continues: composerSessionId }
      : undefined
  // The task holding the open root's thread, so a daemon without thread reads still shows its session.
  const openRootSummary = openRoot ? threadSummaries.get(openRoot) : undefined
  const openRootTask: TaskLink | undefined =
    openRootSummary?.readable && openRootSummary.task?.sessionId
      ? { sessionId: openRootSummary.task.sessionId, title: openRootSummary.task.title ?? '', how: 'opened' }
      : undefined
  // The open root's thread on its platform, from the conversation's channel and workspace, which the panel links.
  const openRootUrl =
    openRoot && currentSessionDetail?.channel
      ? threadShape?.threadUrl?.({
          channelId: currentSessionDetail.channel,
          workspaceId: currentSessionDetail.tenantScope ?? null,
          rootId: openRoot
        })
      : undefined
  // Composer state is per-session in the provider — bind it to THIS session's id so a
  // different live conversation streaming in the background can't disable or clear it.
  const pgBusy = sessionBusy
  const pgImage = getPgImage(session.id)
  const pgFiles = getPgFiles(session.id)
  const filesUploading = pgFiles.some((f) => f.status !== 'ready')
  // A continued chat thread takes images (mirrored there); files go where nothing mirrors, or on a task's own page.
  const continuationAttachments = composerDetail?.continuationAttachments ?? null
  const attachmentsEnabled = !isContinuable || taskOwnPage || continuationAttachments !== null
  const filesEnabled = !isContinuable || taskOwnPage || continuationAttachments === 'images_and_files'
  // A message waiting to go out in a thread is that thread's, not the composer's.
  const pgQueue = getPgQueue(session.id).filter((queued) => !queued.thread)
  // Keep the historical scope after purge or workspace replacement so an unavailable checkout never falls back to primary.
  const filesSessionId =
    (focusedSessionDetail?.workspaceIsolation ?? focusedSession?.workspaceIsolation) === 'session'
      ? headerFocusSessionId
      : undefined
  const filesWorkdir = focusedAgent && focusedAgent.workdir !== '—' ? focusedAgent.workdir : undefined
  // A `?file=` on a session with no agent to read it from has nothing to open, so the conversation stays: the viewer never renders without a checkout behind it, nor before that checkout's scope is known, nor when the link named a workspace this conversation does not have.
  const viewerOpen = viewerPath !== null && filesAgentId !== null && filesScopeReady && !linkedFocusStale
  const liveSteps = isWebchat || isContinuable ? getLiveSteps(session.id) : []
  // A message in a thread that a task answers there keeps this timeline still; one the coordinator answers streams here.
  const busyThread = pgBusy && threadsView ? getPgTurnThread(session.id) : undefined
  const busyThreadTurn = busyThread
    ? [...liveSteps].reverse().find((step) => step.kind === 'msg' && step.thread === busyThread)?.turnId
    : undefined
  const mainBusy =
    pgBusy &&
    (busyThread === undefined ||
      liveSteps.some((step) => step.turnId === busyThreadTurn && step.kind !== 'msg' && !step.thread))

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
  // A chat-origin continued conversation reaches one member session per send, picked on the composer's roster chips.
  const pickRecipient = !isPg && !isWebchat && conversationMode && multiLive && !wholeConversation
  const composerAgentId = composerMember?.agentId ?? session.agentId ?? ''
  const composerAgentName = liveRoster.find((p) => p.agentId === composerAgentId)?.name ?? session.agentName
  // Only members whose own session can continue are addressed, so a bare send never wakes one the relay cannot reach.
  const conversationRosterToSend = wholeConversation
    ? liveRoster.filter((p) => {
        const member = conversationMembers?.find((m) => m.agentId === p.agentId)
        return !!member && (member.sessionId === id || memberContinuable(member.sessionId))
      })
    : undefined
  const resumePlaceholder = continuationBlocked
    ? continuationReason === 'agent_moved'
      ? 'This session can’t continue because the agent moved to another daemon.'
      : continuationReason === 'daemon_offline'
        ? 'This session can’t continue while the agent is offline.'
        : 'This session can’t continue here yet.'
    : resumeState === 'checking'
      ? 'Checking whether this conversation can continue…'
      : multiLive
        ? 'This conversation can’t continue because one or more agents moved to another daemon.'
        : 'This conversation can’t continue because the agent moved to another daemon.'

  // Resume the webchat conversation by its id (session.channelId == the conversationId);
  // a synthetic playground turn omits it (the CP mints a fresh id).
  // Returns ACCEPTANCE: callers that arm follow-up state (the PR panel's Auto-fix wait) must know a
  // synchronous refusal — image preparing, mention joining, nothing to send — from an accepted send.
  const onPgSend = (text?: string): boolean => {
    if (imagePreparing || filesUploading || mentionJoining || (!attachmentsEnabled && pgImage !== undefined))
      return false
    setImageError(null)
    // The `/` pick's owner. Validation happens in pgSend against the OUTGOING draft (this parent
    // deliberately does not subscribe to it) — the pick narrows the turn only while its token
    // still leads and the owner is still a participant.
    const pick = commandPickRef.current
    commandPickRef.current = null
    // A continuation socket mints through the session-target route (§6.5).
    if (isContinuable) {
      markSessionTarget(session.id, composerSessionId)
      const scope = conversationKey ?? ''
      setSentSessionIds((cur) => {
        const ids = cur.scope === scope ? cur.ids : []
        return ids.includes(composerSessionId) && cur.scope === scope
          ? cur
          : { scope, ids: [...ids, composerSessionId] }
      })
    }
    // Pass the fetched roster: an adopted webchat session has no provider-side
    // state, and without it a multi-agent send can't pre-create stream lanes or
    // narrow by @mention (the relay would apply its all-participants default).
    // Named, not raw: mention narrowing matches on the display name the composer
    // chips show.
    const sent = pgSend(
      session.id,
      composerAgentId,
      text,
      isWebchat ? session.channelId : undefined,
      isWebchat ? liveRoster : conversationRosterToSend,
      undefined,
      pick ?? undefined
    )
    // Writing ends reading: someone who scrolled up through history and then
    // sends must not have their own message — or the reply to it — land
    // off-screen, so re-arm the bottom-follow regardless of scroll position.
    // Only on an ACCEPTED send, though: Enter on an empty composer, or while a
    // turn is still streaming, sends nothing, and yanking a reader out of
    // history for a no-op would break the very guarantee this makes.
    if (sent) stickToBottom()
    return sent
  }
  // Originals upload straight to the object store when the composing agent's daemon supports transfers.
  const composerAgent = agents.find((a) => a.id === composerAgentId)
  const composerTransfer =
    composerAgent !== undefined &&
    uploadPreviewsCapable(agentCapabilitySource(composerAgent, daemons, memberSets)?.caps.features)
  // Files dropped anywhere on the conversation take the paperclip's path.
  const dropEnabled = attachmentsEnabled && isLive && !resumeDisabled && !viewerOpen
  onDropFilesRef.current = (files) => onAttachFiles(files)
  const onAttachFiles = (selected: File[]): void => {
    if (imageInputRef.current) imageInputRef.current.value = ''
    if (!attachmentsEnabled || !selected.length) return
    setAttachMenuOpen(false)
    if (!filesEnabled || !composerTransfer) {
      if (selected.length === 1 && selected[0]!.type.startsWith('image/')) return void onImageFile(selected[0])
      setImageError(t('continuationImagesOnly'))
      return
    }
    if (pgImage) {
      setImageError('Remove the inline image before adding uploaded files.')
      return
    }
    stageComposerFiles(
      {
        sessionId: session.id,
        agentId: composerAgentId,
        transfer: composerTransfer,
        getPgFiles,
        setPgFiles,
        onError: setImageError
      },
      selected
    )
    if (imageInputRef.current) imageInputRef.current.value = ''
  }
  const onImageFile = async (file: File | undefined): Promise<void> => {
    if (!attachmentsEnabled || !file || imagePreparing) return
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
  // Continuations excluded: their channelId is a platform coordinate, not a
  // webchat conversation id, and a targeted conversation has no remote MCP.
  const webchatConversationId = isPg || isWebchat ? session.channelId : undefined
  // An in-band elicitation card is answerable only where this reader can reach the session
  // over the live webchat socket — the same gate the composer rides. Absent otherwise, and
  // the card renders inert rather than offering buttons that would go nowhere.
  const answerElicitation =
    isLive && (isPg || isWebchat)
      ? (agentId: string | undefined, requestId: string | undefined, value: ElicitAnswerValue): void => {
          if (!requestId) return
          pgAnswerElicitation(session.id, agentId ?? session.agentId ?? '', requestId, value, webchatConversationId)
        }
      : undefined
  // An MCP App's bridge is served on the same live socket the composer rides, and for the same
  // reason it is gated the same way: a frame whose RPCs could not reach the daemon would be a
  // page whose buttons silently do nothing. Absent ⇒ the card renders as a record, not a frame.
  const appRpc =
    isLive && (isPg || isWebchat)
      ? (agentId: string | undefined, appId: string, rpc: McpAppRpc) =>
          pgAppRpc(session.id, agentId ?? session.agentId ?? '', appId, rpc, webchatConversationId)
      : undefined
  // A native dialog's outcome is a line the CONVERSATION speaks, exactly like an approval decision
  // (`pgNotice` below): it rides the composer's own turn frame, never the card bridge. The bridge
  // authorizes a SANDBOXED frame — agent-authored HTML that may not name its own sender — and its
  // card expires with the session, the four-card cap and the reader closing the page; a native
  // dialog is the Console's own form under the reader's own JWT, so that gate buys nothing there
  // and only loses the report. The composer never touches it: reporting is not a send, so a
  // half-typed follow-up and a staged image stay the owner's.
  const appReport =
    isLive && (isPg || isWebchat)
      ? (agentId: string | undefined, text: string): boolean => {
          if (isContinuable) markSessionTarget(session.id)
          return pgNotice(
            session.id,
            agentId ?? session.agentId ?? '',
            text,
            webchatConversationId,
            isWebchat ? liveRoster : undefined
          )
        }
      : undefined
  const closeApp =
    isLive && (isPg || isWebchat)
      ? (agentId: string | undefined, appId: string): void =>
          pgCloseApp(session.id, agentId ?? session.agentId ?? '', appId, webchatConversationId)
      : undefined
  // A Fill card's values ride the same live socket as the composer, a chat session's continuation included.
  const answerFill =
    isLive && (isPg || isWebchat || isContinuable)
      ? (agentId: string | undefined, requestId: string, answer: FillCardAnswer) => {
          if (isContinuable) markSessionTarget(session.id)
          return pgAnswerFill(session.id, agentId ?? session.agentId ?? '', requestId, answer, webchatConversationId)
        }
      : undefined
  // A chat platform's Fill card links here with ?fill=<id>: the daemon hands the card to the person who asked, or refuses.
  const fillRequest = answerFill ? searchParams.get('fill') : null
  const openFill = () => {
    if (!fillRequest) return
    setFillOpenError(null)
    if (isContinuable) markSessionTarget(session.id)
    void pgOpenFill(session.id, session.agentId ?? '', fillRequest, webchatConversationId).then((opened) => {
      if (!opened.ok) setFillOpenError(opened.reason ?? null)
    })
  }
  // Joins and removals (§3.1/§3.1a) mutate provider-side state an adopted session never had, so they stay playground-only.
  const pgWorktree =
    worktreeSelections[session.id] ??
    getPgWorktree(session.id) ??
    (!!owner?.workspace && isGitWorkspace(owner.workspace) && owner.workspace.worktree === true)
  // The chip names the isolation by the owner's EFFECTIVE boundary (git-workspace-model.md §11), never by its stored sandbox flag.
  const isolationLabel = agentSessionIsolationLabel(owner ?? { execution: HOST_STRATEGY }, orgSetIds)
  const canChooseWorktree =
    isPg &&
    !coordinatorPage &&
    !multiLive &&
    !!owner?.workspace &&
    isGitWorkspace(owner.workspace) &&
    !session.steps.some((step) => step.kind === 'msg')
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
  // The `/` picker's participants. Every live participant contributes its OWN runtime's commands,
  // so a name can legitimately appear twice; picking one addresses its agent (see commandInsertion).
  const commandParticipants = isLive
    ? {
        roster: liveRoster.map((p) => ({ agentId: p.agentId, name: p.name })),
        iconOf: (agentId: string) => {
          const agent = agentById.get(agentId)
          return agent ? { icon: agent.icon, runtime: agent.runtime } : undefined
        },
        multi: multiLive
      }
    : undefined
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
  // A task's owning session, where its page's back and close lead; none when the owner is hidden from this reader.
  const taskOwner = taskOwnPage ? (currentSessionDetail?.parentSession ?? null) : null
  const taskOwnerHref = taskOwner
    ? orgPath(`/sessions/${encodeURIComponent(taskOwner.id)}${flatView ? '?view=flat' : ''}`)
    : null
  const shareMessage = (turn: Turn): (() => void) | undefined => {
    const seq = turn.rowSeq
    if (seq === undefined) return undefined
    const page = orgPath(
      `/sessions/${encodeURIComponent(session.realSessionId ?? session.id)}${flatView ? '?view=flat' : ''}`
    )
    return () => setMessageShare(messageLink(page, seq))
  }

  // Resolve a `cron:<scheduleId>` author string to its schedule (name once the crons
  // list loads). Shared by the header chip and the transcript turns so a scheduled
  // trigger reads as its schedule, not a raw uuid.
  const asCron = (s: string): { id: string; name: string | null } | null => {
    if (!s.startsWith('cron:')) return null
    const id = s.slice('cron:'.length)
    return { id, name: crons.find((c) => c.id === id)?.name ?? null }
  }

  const { turns: builtTurns, speakers } = buildTurns({
    session,
    rows: wantTranscript ? (visibleMsgs ?? []) : undefined,
    liveSteps,
    source: {
      session: conversationSourceSessionByMessageRef.current,
      turn: conversationSourceTurnByMessageRef.current,
      platform: conversationSourcePlatformByMessageRef.current,
      agent: conversationSourceAgentByMessageRef.current
    },
    threadsView,
    threadShape,
    agentById,
    asCron,
    participantAgent,
    isSelf,
    senderLabel,
    ownsDecisionSeq,
    viewer,
    pictureOf: people.pictureOf,
    sourceLabel: platName(sessionIntegration)
  })
  // In the roots view the coordinator's work in a thread is drawn in that thread's panel, not on the main timeline.
  const { main: turns, byThread: threadWork } = threadsView
    ? splitThreadWork(builtTurns, session.agentId)
    : { main: builtTurns, byThread: EMPTY_THREAD_WORK }

  // A coordinator's task cards, under the first turn of the coordinator after the message each task was opened for.
  const openedTaskCards = new Map<string, TaskLink[]>()
  // With threads, a root's footer carries its task instead (webchat-threads.md §6.1).
  if (tasksByMessage.size > 0 && !threadsView) {
    // A coordinator answers a batch of messages in one turn, so every message since its last turn adds its tasks.
    let opened: TaskLink[] = []
    for (const t of turns) {
      if (t.kind === 'user') opened = [...opened, ...((t.messageId && tasksByMessage.get(t.messageId)) || [])]
      else if (t.agentId === session.agentId) {
        if (opened.length > 0) openedTaskCards.set(t.key, opened)
        opened = []
      }
    }
  }

  // A root's thread in the roots view, named by its postId or platform ts as its shape says (webchat-threads.md §6.1, §7).
  const rootOf = (turn: Turn): string | undefined =>
    threadsView && turn.kind === 'user' && namesThread(threadShape, turn.messageId) ? turn.messageId : undefined
  // A root the reader may reply under.
  // The thread a reader replies in from a person's message: the one a redirected message joined, else the root's own.
  const replyRootOf = (turn: Turn): string | undefined =>
    !threadWriter ? undefined : turn.kind === 'user' && turn.handedTo && threadsView ? turn.handedTo : rootOf(turn)
  const replyInThread = (rootId: string) => openRootThread(rootId, { focus: true })
  const rootTextOf = new Map(
    turns.flatMap((turn) => (turn.kind === 'user' && turn.messageId ? [[turn.messageId, turn.text]] : []))
  )
  const threadAuthorName = (author: SessionThreadAuthorDto): string => {
    const who = senderIdentity(author)
    const agent = agentById.get(who)
    if (agent) return agentLabel(agent)
    return isSelf(who) ? tt('you') : senderLabel(who, author.senderName ?? author.sender)
  }
  // A replier's mark on a footer: an agent's icon, else the person's picture; initials where neither is known.
  const threadAuthorMark = (author: SessionThreadAuthorDto) => {
    const who = senderIdentity(author)
    const agent = agentById.get(who)
    if (agent) return <AgentIconView icon={agent.icon} runtime={agent.runtime} size={16} />
    const picture = isSelf(who)
      ? (viewer.picture ?? author.senderAvatarUrl)
      : (author.senderAvatarUrl ?? people.pictureOf(who))
    return picture ? (
      <img src={picture} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
    ) : null
  }
  // The conversation with the thread open, which a modified click on its footer opens in a new tab.
  const threadHref = (rootId: string): string =>
    `${pathname}?${new URLSearchParams({ ...(flatView ? { view: 'flat' } : {}), thread: rootId })}`
  // A root's thread: its replies line under the person's bubble, then its task's card on the left as the coordinator's message.
  const rootFooter = (turn: Turn, part: 'line' | 'card') => {
    const rootId = rootOf(turn)
    const summary = rootId ? threadSummaries.get(rootId) : undefined
    if (!rootId || !summary || (part === 'card' && !summary.task)) return null
    // The replies line sits under its message, on whichever side the message is drawn.
    const rootIsMine = turn.kind === 'user' && turn.self === true
    return (
      <div
        className={
          part === 'line'
            ? `mt-[3px] flex w-full ${rootIsMine ? 'justify-end' : 'justify-start'}`
            : 'mt-[6px] flex w-full'
        }
      >
        <RootThreadFooter
          part={part}
          {...(part === 'card' && owner
            ? {
                from: {
                  name: agentLabel(owner),
                  mark: <AgentIconView icon={owner.icon} runtime={owner.runtime} size={26} />,
                  href: orgPath(`/agents/${encodeURIComponent(owner.id)}`)
                }
              }
            : {})}
          agentId={session.agentId ?? ''}
          parentSessionId={session.id}
          summary={summary}
          rootId={rootId}
          href={threadHref(rootId)}
          {...(threadWriter ? { onReply: () => replyInThread(rootId) } : {})}
          selected={openRoot === rootId}
          onOpen={() => openRootThread(rootId)}
          nameOf={threadAuthorName}
          markOf={threadAuthorMark}
          align={rootIsMine ? 'end' : 'start'}
        />
      </div>
    )
  }
  // The thread under the agent's own post at the root: its task's card inside the post's bubble, its replies line under it.
  const ownRootFooter = (rootId: string, part: 'line' | 'card') => {
    const summary = threadSummaries.get(rootId)
    if (!summary || (part === 'card' && !summary.task)) return null
    return (
      <div className={part === 'line' ? '-mt-[6px] flex w-full' : 'flex w-full'}>
        <RootThreadFooter
          part={part}
          agentId={session.agentId ?? ''}
          parentSessionId={session.id}
          summary={summary}
          rootId={rootId}
          href={threadHref(rootId)}
          {...(threadWriter ? { onReply: () => replyInThread(rootId) } : {})}
          selected={openRoot === rootId}
          onOpen={() => openRootThread(rootId)}
          nameOf={threadAuthorName}
          markOf={threadAuthorMark}
        />
      </div>
    )
  }
  // A message the coordinator handed into a task's thread says so above its bubble, as Slack's "replied to a thread", and opens it.
  const handedLead = (turn: Turn) => {
    if (!threadsView || turn.kind !== 'user' || !turn.handedTo) return null
    const rootId = turn.handedTo
    const summary = threadSummaries.get(rootId)
    const name = summary?.task?.title ?? summary?.rootExcerpt ?? rootTextOf.get(rootId)
    return (
      <button
        type="button"
        data-turn-handed-to={rootId}
        onClick={() => openRootThread(rootId)}
        className="flex max-w-full min-w-0 cursor-pointer items-center gap-[4px] border-0 bg-transparent p-0 pr-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
      >
        <span className="flex-none">{tt('repliedToThread')}</span>
        <span className="min-w-0 truncate font-medium text-(--brand) hover:underline">
          {name ? firstWords(name) : tt('inThreadBare')}
        </span>
      </button>
    )
  }
  const threadLine =
    'flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary) hover:underline'
  // A coordinator turn answering a thread message names the thread, and opens it.
  const threadLabel = (rootId: string) => {
    const root = threadSummaries.get(rootId)?.rootExcerpt ?? rootTextOf.get(rootId)
    return (
      <button type="button" data-turn-in-thread={rootId} onClick={() => openRootThread(rootId)} className={threadLine}>
        <Icon name="corner-down-right" size={12} className="flex-none" />
        <span className="min-w-0 truncate">
          {root ? tt('inThread', { root: firstWords(root) }) : tt('inThreadBare')}
        </span>
      </button>
    )
  }
  // A `replyToMessage` call is one line here; its answer is in the thread, whose footer previews it.
  const answeredLines = (steps: readonly FmtStep[]) =>
    [...new Set(steps.flatMap((step) => (step.answeredIn ? [step.answeredIn] : [])))].map((rootId) => (
      <button
        key={`r:${rootId}`}
        type="button"
        data-turn-answered-in={rootId}
        onClick={() => openRootThread(rootId)}
        className={threadLine}
      >
        <Icon name="reply" size={12} className="flex-none" />
        {tt('answeredInThread')}
      </button>
    ))

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
  const focusedDaemonId =
    focusedSession?.daemon && focusedSession.daemon !== '—' ? focusedSession.daemon : focusedAgent?.daemon
  const focusedDaemon =
    focusedDaemonId && focusedDaemonId !== '—' ? daemons.find((d) => d.daemonId === focusedDaemonId) : undefined
  // What ran it, else where it is PLACED. `Agent.daemon` carries a placement sentinel for a set
  // placement, not a member id (lib/data.ts POOL_PLACEMENT), so resolving it as a machine renders
  // the literal "pool" — and renders it for Cloud and for every group alike, since only `setId`
  // tells those apart. `agentDaemonLabel` is the one projection that knows the difference.
  const focusedDaemonName =
    focusedDaemon?.name ??
    (focusedAgent
      ? agentDaemonLabel(focusedAgent, daemons, memberSets)
      : focusedDaemonId && focusedDaemonId !== '—' && focusedDaemonId !== POOL_PLACEMENT
        ? focusedDaemonId.length > 12
          ? focusedDaemonId.slice(0, 8)
          : focusedDaemonId
        : '')
  // Match the glyph to what the name says: a resolved machine is a server, an unresolved
  // placement takes its target's own icon (pool / group / daemon).
  const focusedDaemonIcon = !focusedDaemon && focusedAgent ? agentPlacementIcon(focusedAgent, memberSets) : 'server'
  // Show a different executor, or the holder only when its stay has a useful reason.
  const executorDaemonId = focusedSessionDetail?.executorDaemonId
  const stayedHomeKey = stayedHomeReasonKey(focusedSessionDetail?.stayedHomeReason)
  const stayedHomePhrase = stayedHomeKey ? t(`stayedHome.${stayedHomeKey}`) : ''
  const runsOn =
    executorDaemonId && executorDaemonId !== focusedDaemonId
      ? // Same rule as the Daemon row above: a name, never a raw id or a hostname.
        (daemons.find((d) => d.daemonId === executorDaemonId)?.name ?? executorDaemonId.slice(0, 8))
      : stayedHomePhrase && focusedDaemonName
        ? `${focusedDaemonName} · ${stayedHomePhrase}`
        : stayedHomePhrase
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
  // With older history unloaded the transcript is only the newest page, so a transcript-derived
  // Duration/Tool-calls would describe ~50 rows and CLIMB on every "Load earlier" — show `—` instead
  // of a wrong, growing number until the whole session is loaded (the DTO carries no session total).
  const displayDuration = visibleHasEarlier
    ? '—'
    : durationFirst != null && durationLast != null
      ? fmtTranscriptDuration(durationLast - durationFirst)
      : (focusedSession?.duration ?? '—')
  const displayToolCount = visibleHasEarlier
    ? '—'
    : focusedTranscriptStats
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
  // A continuation adds human input but never session-global runtime
  // administration — pills stay hidden (§6.5).
  // A task is set from its own page as from its thread (#3654): its agent lets chat change settings and the reader edits it.
  const taskRuntimeChanges =
    taskOwnPage && isContinuable && chatSettingsAllowed(owner ?? undefined) && owner?.canEdit === true
  const runtimeChangesEnabled =
    taskRuntimeChanges ||
    (!isContinuable && !continuationBlocked && sessionRuntimeChangesEnabled(owner, session, ownsThisConversation))
  // People in chat may change settings here, just not this reader: the pill names who may.
  const runtimeOwnersOnly =
    !isContinuable && !continuationBlocked && !runtimeChangesEnabled && sessionRuntimeChangesEnabled(owner, session)
  const runtimeSelection = runtimeSelections[session.id]
  const setRuntimeSelection = (patch: {
    runtime?: string
    model?: string
    effort?: string
    permissionPreset?: string
    fast?: boolean
  }) =>
    setRuntimeSelections((current) => ({
      ...current,
      [session.id]: { ...current[session.id], ...patch }
    }))
  const beforeFirstTurn = pgEmpty && !session.realSessionId
  const byDecision =
    beforeFirstTurn &&
    !!owner?.modelSelection &&
    !runtimeSelection?.model &&
    !runtimeSelection?.runtime &&
    session.runtimePending !== false
  const runtimeUnresolved = byDecision || session.runtimePending === true
  const runtimePending = runtimeUnresolved && !beforeFirstTurn
  const runtimeDecision = decisionCatalog?.decisions.find((item) => item.id === owner?.modelSelection?.decisionId)
  const {
    modelSource,
    pgModel,
    pgShownModel,
    pgModelOptions,
    pickerSource,
    pgEffort,
    pgEffortOptions,
    pgPermissionPreset,
    pgApprovalOptions,
    pgFastMode,
    pgFastModeAvailable
  } = runtimePickerState({
    session,
    selection: runtimeSelection,
    owner: owner ?? undefined,
    owningDaemon: owningDaemon ?? undefined,
    agentRuntime,
    beforeFirstTurn,
    runtimeUnresolved,
    permissionT
  })
  // The runtime setters, shared by the toolbar's model picker and the composer's console commands.
  // A continued task's change goes to the task's own session, so its target is marked first, as a send does.
  const markRuntimeTarget = () => {
    if (isContinuable) markSessionTarget(session.id)
  }
  const changeEffort = (effort: string) => {
    markRuntimeTarget()
    setRuntimeSelection({ effort })
    pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
  }
  const changePermission = (permissionPreset: string) => {
    markRuntimeTarget()
    setRuntimeSelection({ permissionPreset })
    pgSetPermissionPreset(session.id, session.agentId ?? '', permissionPreset, webchatConversationId)
  }
  const changeFast = (fast: boolean) => {
    markRuntimeTarget()
    setRuntimeSelection({ fast })
    pgSetFast(session.id, session.agentId ?? '', fast, webchatConversationId)
  }
  const changeRuntimeModel = (target: DecisionRuntimeTarget) => {
    const currentEffort = runtimeSelection?.effort ?? session.effort ?? owner?.reasoning ?? ''
    const effort = sessionEffortAfterModelChange(target.runtime, owningDaemon, target.model, currentEffort)
    // Another runtime preselects its auto mode, else full access, else its default.
    const permissionPreset =
      target.runtime === agentRuntime
        ? runtimeSelection?.permissionPreset
        : runtimeSwitchPermissionMode(modelSource || undefined, target.runtime)
    markRuntimeTarget()
    setRuntimeSelection({ ...target, effort, permissionPreset })
    if (beforeFirstTurn) {
      pgStageRuntime(session.id, { ...target, effort, permissionMode: permissionPreset })
    } else {
      pgSetModel(session.id, session.agentId ?? '', target.model, webchatConversationId)
      if (effort !== currentEffort) pgSetEffort(session.id, session.agentId ?? '', effort, webchatConversationId)
    }
  }
  // The composer's console commands: only what the toolbar would let this reader do right now.
  const runtimeCommandsOpen =
    !multiLive && runtimeChangesEnabled && !byDecision && !runtimePending && !!(agentRuntime || pgModel)
  const composerControls: ControlCommand[] = []
  if (pgBusy || isPgTurnUnstreamed(session.id))
    composerControls.push({
      name: 'stop',
      choices: null,
      run: () => pgCancel(session.id, composerAgentId, webchatConversationId)
    })
  if (runtimeCommandsOpen && pgModelOptions.length > 0)
    composerControls.push({
      name: 'model',
      choices: pgModelOptions.map((model) => ({ value: model, label: model, current: model === pgModel })),
      run: (model) => model && changeRuntimeModel({ runtime: agentRuntime, model })
    })
  if (runtimeCommandsOpen && pgEffort && pgEffortOptions.length > 0)
    composerControls.push({
      name: 'effort',
      choices: pgEffortOptions.map((choice) => ({ ...choice, current: choice.value === pgEffort })),
      run: (effort) => effort && changeEffort(effort)
    })
  if (runtimeCommandsOpen && pgPermissionPreset && pgApprovalOptions.length > 0)
    composerControls.push({
      name: 'permission',
      choices: pgApprovalOptions.map(({ value, label }) => ({ value, label, current: value === pgPermissionPreset })),
      run: (mode) => mode && changePermission(mode)
    })
  if (runtimeCommandsOpen && pgFastModeAvailable)
    composerControls.push({
      name: 'fast',
      choices: [
        { value: 'on', label: commandMenuT('fastOn'), current: pgFastMode },
        { value: 'off', label: commandMenuT('fastOff'), current: !pgFastMode }
      ],
      run: (value) => value && changeFast(value === 'on')
    })
  // Run facts for the header's "Details" popover — the stats that used to live in
  // the header cards (duration, usage) plus the run's identity rows. Status is not
  // here: it rides the top-bar crumb as a pill next to the session name. Both form
  // factors read this one list (see detailPanel below).
  const headerFacts: { icon: string; label: string; value: string }[] = [
    { icon: 'clock', label: t('duration'), value: displayDuration },
    { icon: 'coins', label: t('tokens'), value: focusedSession?.tokens ?? '—' },
    { icon: 'circle-dollar-sign', label: t('cost'), value: focusedSession?.cost ?? '—' },
    { icon: 'wrench', label: t('toolCalls'), value: String(displayToolCount) }
  ]
  if (focusedDaemonName) headerFacts.push({ icon: focusedDaemonIcon, label: t('daemon'), value: focusedDaemonName })
  if (runsOn) headerFacts.push({ icon: 'server', label: t('runsOn'), value: runsOn })
  if (focusedSession?.runtimePending) {
    const value = runtimeModelT(beforeFirstTurn ? 'byDecision' : 'pending')
    headerFacts.push({ icon: 'cpu', label: t('runtime'), value }, { icon: 'box', label: t('model'), value })
  } else {
    if (focusedAgentRuntime)
      headerFacts.push({
        icon: 'cpu',
        label: t('runtime'),
        value: runtimeLabel(focusedAgentRuntime, focusedRuntimeMeta?.name)
      })
    const focusedModel = focusedSession?.model ?? focusedAgent?.model ?? ''
    // No reported model on a known runtime means the runtime's own default ran.
    const focusedCatalog = focusedDaemonId === owningDaemon?.daemonId ? owningDaemon : focusedDaemon
    if (focusedAgentRuntime && (!focusedModel || focusedModel === 'default'))
      headerFacts.push({
        icon: 'box',
        label: t('model'),
        value: runtimeDefaultModel(focusedCatalog, focusedAgentRuntime)?.name ?? t('defaultModel')
      })
    else if (focusedModel) headerFacts.push({ icon: 'box', label: t('model'), value: modelLabel(focusedModel) })
  }

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
            {t('tokenUsage')}
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
  // The approval strip rides the sticky composer footer on a live session (the top slot otherwise) while something the transcript does not place waits; the Requests popover keeps the history.
  const canReviewApprovals = Boolean(owner?.canEdit && !owner.name.startsWith(MOCK_PREFIX) && session.agentId)
  // A webchat conversation's owner answers its requests here through the conversation: all of them where people in chat may approve, else the join confirmations that ask them, as the CP narrows the list.
  const ownerApprovals = Boolean(
    !canReviewApprovals &&
    (isWebchat || (isPg && session.realSessionId)) &&
    !taskPage &&
    ownsThisConversation === true &&
    owner &&
    !owner.name.startsWith(MOCK_PREFIX)
  )
  // On a task's own page that owner answers the task's requests through the owning conversation, since the task's own coordinate is refused there.
  const taskOwnerApprovals = Boolean(
    !canReviewApprovals &&
    taskOwnPage &&
    taskOwnerSessionId &&
    taskOwnerDetail?.platform === 'webchat' &&
    taskOwnerDetail.ownsConversation === true &&
    owner &&
    !owner.name.startsWith(MOCK_PREFIX)
  )
  // A webchat conversation's proposals, the live Playground's included (assistant-mode.md §5.10): whoever may continue it and editors decide them here; the CP refuses anyone else.
  const conversationProposals = Boolean(
    (isWebchat || (isPg && session.realSessionId)) &&
    !taskPage &&
    owner?.assistantMode?.enabled === true &&
    !owner.name.startsWith(MOCK_PREFIX)
  )
  // Each agent turn as approval placement reads it: a tool call's request shows at the turn that asked it, not in the strip.
  // A turn before the last message that opened a new exchange (a steer joins the running turn) is closed.
  let lastExchangeAt = -1
  turns.forEach((turn, i) => {
    if (turn.kind === 'user' && !turn.steer) lastExchangeAt = i
  })
  // When each turn began, for the NEW line: a message when it was sent, an agent turn at its first timed step.
  const turnStartsMs = turns.map((turn) =>
    turn.kind === 'user'
      ? turn.timeMs
      : turn.steps.reduce<number | undefined>(
          (min, st) => (st.timeMs !== undefined && (min === undefined || st.timeMs < min) ? st.timeMs : min),
          undefined
        )
  )
  const newestTurnMs = turns.reduce<number | null>((max, turn) => {
    const at =
      turn.kind === 'user'
        ? turn.timeMs
        : turn.steps.reduce<number | undefined>(
            (m, st) => (st.timeMs !== undefined && (m === undefined || st.timeMs > m) ? st.timeMs : m),
            undefined
          )
    return at !== undefined && (max === null || at > max) ? at : max
  }, null)
  const newDividerAt = newDividerIndex(turnStartsMs, seen.marker)
  // The turn map's ticks, each named in its tip by who spoke and what they said: a person's words, an agent's last sentence.
  const tipLine = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text)
  const mapTurns: MapTurn[] = turns.map((turn) => {
    if (turn.kind === 'user')
      return { key: turn.key, tip: `${turn.sp.name}: ${tipLine(turn.text.replace(/\s+/g, ' ').trim())}` }
    const said = lastSpokenSentence(turn.steps)
    return {
      key: turn.key,
      tip: said ? `${turn.agentName}: ${tipLine(said)}` : [turn.agentName, turn.time].filter(Boolean).join(' · ')
    }
  })
  const approvalTurns: ApprovalTurnAnchor[] = turns.flatMap((turn, i) =>
    turn.kind === 'bot'
      ? [
          {
            key: turn.key,
            ...(turn.agentId ? { agentId: turn.agentId } : {}),
            startMs: approvalTurnStart(turn.steps.map((st) => st.timeMs)),
            closed: i < lastExchangeAt
          }
        ]
      : []
  )
  // A task's own thread changes its settings by the conversation's rule: settings allowed from chat, for the agent's editors.
  const taskRuntimeContext = {
    owner: owner ?? undefined,
    owningDaemon: owningDaemon ?? undefined,
    agentRuntime,
    editable: chatSettingsAllowed(owner ?? undefined) && owner?.canEdit === true
  }
  // The task whose thread is actually on screen: expanded, or in a visible side panel on its Tasks tab.
  const openThreadTaskId =
    openThread?.sessionId ?? (openRoot ? threadSummaries.get(openRoot)?.task?.sessionId : undefined)
  const taskThreadOnScreen = openThreadTaskId && dockVisible && dockTabKey === 'tasks' ? openThreadTaskId : null
  // A task's approvals are answered in its own thread, read through this conversation under the strip's rules.
  const taskApprovalScope =
    (canReviewApprovals || ownerApprovals) && session.agentId
      ? {
          listSessionId: session.realSessionId ?? session.id,
          enabled: true,
          conversationPermissions: ownerApprovals
        }
      : undefined
  const approvalCard = (className: string) =>
    (canReviewApprovals || ownerApprovals || conversationProposals) && session.agentId ? (
      <ApprovalRequestsCard
        key={session.id}
        agentId={session.agentId}
        sessionId={session.realSessionId ?? session.id}
        pendingOnly
        permissions={canReviewApprovals || ownerApprovals}
        conversationPermissions={ownerApprovals}
        proposals={conversationProposals}
        transcriptTurns={approvalTurns}
        openTaskSessionId={taskThreadOnScreen}
        className={className}
      />
    ) : null
  // The Requests popover keeps an editor's history, this conversation's proposals included.
  const requestsPanel =
    canReviewApprovals && session.agentId ? (
      <ApprovalRequestsCard
        bare
        agentId={session.agentId}
        sessionId={session.realSessionId ?? session.id}
        proposals={conversationProposals}
      />
    ) : null

  return (
    // Body · dock track, FLUSH in a full-width row (no gap): so the transcript's scrollbar rides
    // hard against the dock's left border. The track's −30px bleed reaches the page's right edge
    // while the 880px body centres in what remains, and the track is a column only above `wide:`
    // (below it the dock is an overlay and spends nothing) but holds that column in every tab
    // status, so the body's position is a constant of the band — keep in step with
    // SessionDetailFrame, whose slot holds the identical box while the session loads.
    // Height-locked to the `.content` scroller (`h-full`, not `min-h-full`): the row no longer
    // grows with the transcript, so the page itself never scrolls. The transcript column and the
    // dock are each their own overflow region and scroll independently.
    <div className="relative flex h-full min-h-0 items-stretch">
      <SessionShareDialog
        key={session.realSessionId ?? session.id}
        open={shareOpen || messageShare !== null}
        title={session.title}
        place={channelDisplay.label || null}
        platform={channelDisplay.platform}
        link={
          messageShare ??
          orgPath(`/sessions/${encodeURIComponent(session.realSessionId ?? session.id)}${flatView ? '?view=flat' : ''}`)
        }
        visibility={shareVisibility}
        onClose={() => {
          setShareOpen(false)
          setMessageShare(null)
        }}
      />
      {/* The viewer is full-width in every band (§7) — a file wants the columns a transcript does not. The 880px cap is the only geometry that changes: the dock's reserved TRACK keeps its column either way, which is the one thing §7 forbids trading. */}
      {/* The SCROLLER is full-width so its vertical scrollbar rides the far-right edge of the
          transcript area, not the centre of a capped box. `overflow-x-hidden` is load-bearing: a
          lone `overflow-y-auto` computes `overflow-x: visible` as `auto`, which paints a spurious
          horizontal bar the moment the vertical scrollbar (or any full-width child) steals a pixel.
          In the one band where the dock track is HIDDEN but `.content`'s 30px right padding is
          present (`desktop:max-wide:`), `-mr-[30px]` bleeds the scroller's edge to the page edge so
          the scrollbar reaches it — PAIRED with `pr-[30px]`, which re-insets the content by the same
          30px so only the scrollbar moves and the transcript stays exactly where it was. At `wide:`
          the track (its own −30px bleed) owns that edge and the scroller stops flush against it —
          `wide:pr-[10px]` insets the content by the scrollbar's own 10px so a tight transcript
          column never puts avatars under the thumb — and on mobile `.content` has no side padding
          to cross. On the LEFT the same bleed-and-reinset (`desktop:-ml-1` + `desktop:pl-1`) moves
          the overflow clip edge 4px into `.content`'s padding so the composer's 3px focus ring
          draws complete instead of being cut flat where the 880px column meets the scroller; the
          mobile gutter (`p-3`) already keeps the ring clear there. */}
      {/* Column: fixed header chrome ABOVE the scrolling transcript pane. The header lives OUTSIDE
      the scroller (no `sticky`), so it never scrolls away and the pane below can be virtualized. */}
      {/* On desktop the header's divider runs from the nav's edge (and to the page's where the dock is a drawer), continuing the nav's own line at 52px. */}
      <div
        {...(dropEnabled ? fileDrop.handlers : {})}
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col desktop:before:pointer-events-none desktop:before:absolute desktop:before:top-[17px] desktop:before:right-0 desktop:before:-left-[30px] desktop:before:h-px desktop:before:bg-(--border-subtle) desktop:max-wide:before:-right-[30px]"
      >
        {dropEnabled && fileDrop.over ? (
          <FileDropOverlay top={dropHeader ? dropHeader.offsetTop + dropHeader.offsetHeight : 0} />
        ) : null}
        {/* Only a transcript on screen is read: the file viewer hides it, so nothing is recorded meanwhile. */}
        {!viewerOpen ? <SeenRecorder newestMs={newestTurnMs} markSeen={seen.markSeen} /> : null}
        {!viewerOpen ? <TranscriptMap turns={mapTurns} onJump={() => releaseFollow()} /> : null}
        {/* HEADER CHROME — title + action bar (+ any notices). Centred to line up with the 880px
        transcript below. `flex-none`; no `sticky`, no bottom `margin` — the meta row's border-b is
        the flush divider with the transcript, with no blank gap under the line. */}
        {/* On desktop the header rises into `.content`'s top padding, so its one line is level with the nav's brand row. */}
        <div ref={setDropHeader} className="mx-auto w-full min-w-0 max-w-[880px] flex-none desktop:-mt-[34px]">
          <div>
            {/* A task's own page names the session it belongs to and leads back there; its tool calls stay in its transcript. */}
            {taskPage && currentSessionDetail ? (
              <div
                data-task-owner=""
                className="flex min-w-0 items-center gap-[6px] border-b border-(--border-subtle) bg-(--surface-card) px-4 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden"
              >
                <Icon name="corner-up-left" size={13} className="flex-none" />
                <span className="min-w-0 truncate">
                  {currentSessionDetail.parentSession
                    ? t.rich('taskBelongsTo', {
                        title:
                          currentSessionDetail.parentSession.title?.trim() ||
                          `Session ${currentSessionDetail.parentSession.id.slice(0, 8)}`,
                        session: (chunks) => (
                          <Link
                            className="lnk font-medium text-(--text-link)"
                            href={orgPath(
                              `/sessions/${encodeURIComponent(currentSessionDetail.parentSession!.id)}${flatView ? '?view=flat' : ''}`
                            )}
                            title={t('backToOwningSession')}
                          >
                            {chunks}
                          </Link>
                        )
                      })
                    : t('taskOwnerHidden')}
                </span>
              </div>
            ) : null}
            {/* One responsive header: the mobile app bar owns the title; these actions stay the same at every width. */}
            {/* Where the dock is a drawer, its fixed Panels toggle sits over the row's right end, so the row leaves it room. */}
            <div
              data-session-header=""
              className="relative flex min-w-0 items-center gap-2 max-desktop:border-b max-desktop:border-(--border-subtle) max-desktop:bg-(--surface-card) max-desktop:px-4 max-desktop:py-[9px] desktop:h-[52px] desktop:max-wide:pr-11"
            >
              <div className="hidden min-w-0 items-center gap-2 desktop:flex">
                {taskOwnerHref ? (
                  <Link
                    data-task-page-back=""
                    className={HEADER_ICON_BTN}
                    href={taskOwnerHref}
                    title={tt('coordinatorTitle')}
                    aria-label={tt('coordinatorTitle')}
                  >
                    <Icon name="chevron-left" size={16} />
                  </Link>
                ) : null}
                <StateIcon
                  state={headerState}
                  label={headerState === 'idle' && headerStatusLabel ? headerStatusLabel : tState(headerState)}
                />
                <h1
                  title={session.title}
                  className="m-0 min-w-0 truncate font-sans text-[17px] font-semibold leading-normal tracking-[-.01em] text-(--text-primary)"
                >
                  {session.title}
                </h1>
                {taskPage && currentSessionDetail ? (
                  currentSessionDetail.parentSession ? (
                    <Link
                      data-header-task-owner=""
                      className={HEADER_ICON_BTN}
                      href={orgPath(
                        `/sessions/${encodeURIComponent(currentSessionDetail.parentSession.id)}${flatView ? '?view=flat' : ''}`
                      )}
                      title={t('taskOfOpen', {
                        title:
                          currentSessionDetail.parentSession.title?.trim() ||
                          `Session ${currentSessionDetail.parentSession.id.slice(0, 8)}`
                      })}
                      aria-label={t('taskOfOpen', {
                        title:
                          currentSessionDetail.parentSession.title?.trim() ||
                          `Session ${currentSessionDetail.parentSession.id.slice(0, 8)}`
                      })}
                    >
                      <Icon name="corner-down-right" size={15} />
                    </Link>
                  ) : (
                    <span data-header-task-owner="" className={HEADER_ICON_BTN} title={t('taskOwnerHidden')}>
                      <Icon name="corner-down-right" size={15} />
                    </span>
                  )
                ) : null}
                {session.threadUrl ? (
                  <a
                    data-header-place=""
                    className={HEADER_CHIP_LINK}
                    href={session.threadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open the ${platName(sessionIntegration)} thread`}
                  >
                    <span className="imark h-[14px] w-[14px] flex-none rounded-xs">
                      <PlatformMark platform={channelDisplay.platform} />
                    </span>
                    <span className="truncate">{channelDisplay.label}</span>
                  </a>
                ) : (
                  <span data-header-place="" className={HEADER_CHIP}>
                    <span className="imark h-[14px] w-[14px] flex-none rounded-xs">
                      <PlatformMark platform={channelDisplay.platform} />
                    </span>
                    <span className="truncate">{channelDisplay.label}</span>
                  </span>
                )}
              </div>
              <span className="flex-1" />
              {session.coordinator ? (
                <span
                  data-header-coordinator=""
                  role="img"
                  className={HEADER_ICON_BTN}
                  title={t('coordinatorTip')}
                  aria-label={t('coordinatorTip')}
                >
                  <Icon name="network" size={15} />
                </span>
              ) : null}
              <HeaderPeople
                agents={headerFocusOptions}
                focusAgentId={headerFocusAgentId}
                onFocusChange={(agentId) => changeHeaderFocus(agentId)}
                agentSub={[focusedSessionDetail?.model ?? focusedSession?.model, focusedDaemonName]
                  .filter(Boolean)
                  .join(' · ')}
                {...(headerCron
                  ? { cron: { href: orgPath(`/crons/${headerCron.id}`), name: headerCron.name || 'Schedule' } }
                  : {})}
                people={humanParticipants.map((participant) => ({
                  id: participant.id,
                  name: participant.sp.name,
                  sub: personSub(participant.sp.handle, platName(sessionIntegration)),
                  face: (
                    <Avatar
                      src={participant.avatarUrl}
                      initials={participant.avatarInitials || participant.sp.initials || '?'}
                      size={22}
                      bg={participant.sp.avBg}
                      fg={participant.sp.avText}
                      fontSize={9}
                    />
                  )
                }))}
              />
              {requestsPanel && (
                // The pill says how many wait for this reader; the popover keeps the answered history too.
                <div
                  ref={requestsPopover.ref}
                  className="flex flex-none items-center desktop:relative"
                  // One header popover at a time: entering Requests closes Details.
                  onMouseEnter={() => {
                    resetDetailPopover()
                    requestsPopover.setPresence('hovered', true)
                  }}
                  onMouseLeave={() => requestsPopover.setPresence('hovered', false)}
                  onFocus={() => {
                    resetDetailPopover()
                    requestsPopover.setPresence('focused', true)
                  }}
                  // Ignore focus moving inside the wrapper, so tabbing from the trigger into Allow/Deny works.
                  onBlur={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget)) return
                    requestsPopover.setPresence('focused', false)
                  }}
                >
                  <button
                    type="button"
                    data-header-requests={pendingRequestCount > 0 ? 'pending' : 'history'}
                    className={
                      pendingRequestCount > 0
                        ? 'inline-flex h-6 flex-none cursor-pointer items-center gap-1 rounded-full border-0 bg-(--status-paused-soft) px-[7px] font-sans text-[12px] font-semibold leading-normal text-[#9a6500] transition-colors focus-visible:outline-none focus-visible:shadow-(--focus-ring)'
                        : `${HEADER_ICON_BTN} cursor-pointer border-0 bg-transparent`
                    }
                    aria-label={
                      pendingRequestCount > 0 ? t('requestsWaiting', { count: pendingRequestCount }) : t('requests')
                    }
                    aria-haspopup="dialog"
                    aria-expanded={requestsPopover.open}
                    aria-controls={requestsTooltipId}
                    onClick={requestsPopover.toggleTap}
                  >
                    <Icon name={pendingRequestCount > 0 ? 'shield-alert' : 'shield-check'} size={15} />
                    {pendingRequestCount > 0 ? <span>{pendingRequestCount}</span> : null}
                  </button>
                  {/* dialog, not tooltip: Allow/Deny live inside, and a tooltip role
                misrepresents interactive content to assistive tech. */}
                  <div
                    id={requestsTooltipId}
                    role="dialog"
                    aria-label={t('approvalRequests')}
                    className={`absolute top-full right-4 left-4 z-50 pt-[5px] transition-[opacity,visibility] desktop:right-0 desktop:left-auto ${
                      requestsPopover.open
                        ? 'pointer-events-auto visible opacity-100'
                        : 'pointer-events-none invisible opacity-0'
                    }`}
                  >
                    <div className="max-h-[min(340px,60vh)] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-lg) desktop:w-[min(420px,calc(100vw-64px))]">
                      {requestsPanel}
                    </div>
                  </div>
                </div>
              )}
              {/* `flex` on the wrapper keeps the button on the row's centre line; the transparent padding bridges trigger and panel for the hover. */}
              <div
                ref={detailPopoverRef}
                className="flex flex-none items-center desktop:relative"
                // And entering Details closes Requests.
                onMouseEnter={() => {
                  requestsPopover.reset()
                  updateDetailPresence('hovered', true)
                }}
                onMouseLeave={() => updateDetailPresence('hovered', false)}
                onFocus={() => {
                  requestsPopover.reset()
                  updateDetailPresence('focused', true)
                }}
                // Focus moving between descendants (trigger to panel) must not drop presence.
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget)) return
                  updateDetailPresence('focused', false)
                }}
              >
                <button
                  type="button"
                  data-header-details=""
                  className={`${HEADER_ICON_BTN} cursor-pointer border-0 bg-transparent focus-visible:outline-none focus-visible:shadow-(--focus-ring)`}
                  aria-label={t('details')}
                  aria-haspopup="dialog"
                  aria-controls={detailTooltipId}
                  aria-expanded={detailOpen}
                  onClick={toggleDetailTap}
                >
                  <Icon name="info" size={15} />
                </button>
                <div
                  id={detailTooltipId}
                  role="dialog"
                  aria-label={t('sessionDetails')}
                  className={`absolute top-full right-4 left-4 z-50 pt-[5px] transition-[opacity,visibility] desktop:right-0 desktop:left-auto desktop:w-max ${
                    detailOpen ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'
                  }`}
                >
                  <div className="max-h-[min(340px,60vh)] overflow-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) px-0 py-[5px] shadow-(--shadow-lg) desktop:min-w-[216px]">
                    {detailPanel}
                  </div>
                </div>
              </div>
              {/* Share: who can see the session, and its link. */}
              <button
                type="button"
                data-header-share=""
                className={`${HEADER_ICON_BTN} cursor-pointer border-0 bg-transparent`}
                onClick={() => setShareOpen(true)}
                aria-label={tShare('share')}
                aria-haspopup="dialog"
              >
                <Icon name="share" size={15} />
              </button>
              {taskOwnerHref ? (
                <Link
                  data-task-page-close=""
                  className={HEADER_ICON_BTN}
                  href={taskOwnerHref}
                  title={tt('closeTask')}
                  aria-label={tt('closeTask')}
                >
                  <Icon name="x" size={15} />
                </Link>
              ) : null}
            </div>
            {/* Under the title row: above it, the desktop header's rise would lift it into the nav band. */}
            {followUpPageAgentId ? <FollowUpTaskSummary agentId={followUpPageAgentId} sessionId={session.id} /> : null}
          </div>

          {currentSessionDetail?.accessSyncDegraded && (
            <div className="mb-3 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4 max-desktop:mt-3">
              {t('externalAccessWarning')}
            </div>
          )}

          {/* The link named a workspace this conversation does not have. Saying so beats opening the same path against whichever agent the header would otherwise focus — that reads plausible and is wrong. */}
          {linkedFocusStale && viewerPath !== null && (
            <div
              data-viewer-stale-link=""
              className="mb-3 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4 max-desktop:mt-3"
            >
              {t('staleLinkWarning')}
            </div>
          )}

          {familyLinks && (
            <MobileSessionFamilyLinks
              parents={familyLinks.parentSessions}
              children={familyLinks.childSessions}
              agentById={agentById}
              orgPath={orgPath}
              flatView={flatView}
              childOriginById={conversationLineage?.childOriginById}
            />
          )}

          {!isLive && approvalCard('mx-4 mt-4 max-desktop:rounded-lg desktop:mx-0 desktop:mt-0 desktop:mb-4')}
        </div>
        {/* WAITING BANNER — between the fixed chrome and the scroller, so it pins to the top of the
        chat area without being a sticky child of the pane (which stays free to be virtualized). It
        draws only when what it names is off screen, so it costs nothing while the card is in view. */}
        {!viewerOpen && <PendingActionsBanner />}
        {/* SCROLL PANE — the transcript/viewer ONLY (all chrome is above, in the header). Full-width
        so the scrollbar rides the page edge via the −mr/pr bleed; nothing sticky scrolls inside it,
        so it is ready to host a virtualized turn list. useStickToBottom pins this element. */}
        <div
          data-transcript-scroll=""
          ref={setTranscriptScroller}
          className={
            viewerOpen
              ? 'flex min-h-0 min-w-0 flex-1 flex-col desktop:pt-[10px]'
              : '@container flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto desktop:max-wide:-mr-[30px] desktop:-ml-1 desktop:pt-[10px] desktop:pl-1 desktop:max-wide:pr-[30px] wide:pr-[10px]'
          }
        >
          {/* One growing inner wrapper = the scroller's single child useStickToBottom watches; in
          conversation mode `min-h-full shrink-0` grows it to the content (so the flex-1 spacer can
          pin the composer) and `mx-auto max-w-[880px]` centres it; in viewer mode a bounded flex-1. */}
          <div
            className={
              viewerOpen
                ? 'flex min-h-0 min-w-0 flex-1 flex-col'
                : 'mx-auto flex min-h-full w-full min-w-0 max-w-[880px] shrink-0 flex-col'
            }
          >
            {viewerOpen && viewerPath && filesAgentId ? (
              // Keyed on the whole WORKSPACE SCOPE, not just the path: the viewer resets its slice in a passive effect, which runs AFTER paint, so without a fresh mount one committed frame draws the previous read's bytes — and its line count and size — under the new heading. The path alone is not that scope: switching header focus from one agent to another while `?file=` holds still is the same stale paint. Same hazard `transcriptMatchesSession` guards for the transcript; nothing inside the viewer is worth carrying across either axis.
              <SessionViewer
                key={`${filesAgentId}:${filesSessionId ?? 'primary'}:${viewerRepo ?? 'workspace'}:${viewerPath}`}
                agentId={filesAgentId}
                {...(filesSessionId ? { sessionId: filesSessionId } : {})}
                {...(viewerRepo ? { repo: viewerRepo } : {})}
                path={viewerPath}
                // NOT part of the mount key: the pill must redraw the pane it already has, and a remount would re-read the file (and the diff) on every toggle.
                mode={viewerMode}
                onModeChange={(mode) => setViewerFile(viewerPath, filesAgentId, mode, viewerRepo)}
                diffRefreshTick={viewerDiffTick}
                {...(canWriteWorkspace ? { onIndexChanged: onViewerIndexChanged } : {})}
                onOpenPath={(next) => setViewerFile(next, filesAgentId, 'file', viewerRepo)}
                {...(viewerDownload ? { download: viewerDownload } : {})}
                transfer={viewerTransfer}
                onClose={() => {
                  // Keep the reader ON the workspace they were reading before dropping `agent=`. The
                  // param outranks the stored selection, so clearing it alone snaps focus back to the
                  // default — a scope change with no user action behind it, which would discard whatever
                  // is in the commit box, including a message the reader just paid a model pass for.
                  if (filesAgentId) setHeaderFocusSelection({ scope: headerFocusScope, agentId: filesAgentId })
                  setViewerFile(null)
                }}
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
                  <span>{t('offlineParticipants')}</span>
                </div>
              )}
              {wantTranscript && visibleMsgErr && !transcriptPurged && (
                <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
                  <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
                  <span>{t('transcriptLoadError')}</span>
                </div>
              )}
              {transcriptPurged && (
                <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
                  <Icon name="trash" size={15} color="var(--text-tertiary)" />
                  <span>{t('transcriptPurged', { date: fmtDate(purgedAt) })}</span>
                </div>
              )}
              {transcriptPartiallyPurged && (
                <div className="card m-4 flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary) desktop:m-0">
                  <Icon name="trash" size={15} color="var(--text-tertiary)" />
                  <span>
                    {memberCount > 1
                      ? t('transcriptPartiallyPurged', {
                          purged: purgedMemberCount,
                          total: memberCount,
                          date: fmtDate(purgedAt)
                        })
                      : t('transcriptDeleted', { date: fmtDate(purgedAt) })}
                  </span>
                </div>
              )}
              {transcriptEmpty && !transcriptPurged && (
                <div className="card m-4 flex flex-col items-center gap-[6px] px-6 py-[34px] text-center desktop:m-0">
                  <Icon name="message-square-dashed" size={20} color="var(--text-tertiary)" />
                  <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('noMessages')}
                  </div>
                </div>
              )}

              {visibleHasEarlier && (
                <div className="flex items-center justify-center pt-[10px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary) desktop:pt-1 desktop:pb-3">
                  <button
                    className="lnk text-[12px]"
                    onClick={() => void loadEarlierConversation()}
                    disabled={pagingEarlier}
                  >
                    {pagingEarlier ? t('loadingEarlier') : t('loadEarlier')}
                  </button>
                </div>
              )}
              {visibleMsgPaging && (
                <div className="flex items-center justify-center gap-2 pt-[10px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary) desktop:pt-1 desktop:pb-3">
                  <Spinner size={14} />
                  {t('loadingEarlier')}
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
              <div className="flex flex-1 flex-col gap-4 p-3 max-desktop:pb-0 desktop:gap-0 desktop:p-0">
                {taskBriefAgentId ? (
                  <TaskBrief agentId={taskBriefAgentId} sessionId={currentSessionDetail?.id ?? session.id} />
                ) : null}
                {headerFocusAgentId && (
                  <SessionModelSelectionResult
                    key={`${headerFocusAgentId}:${headerFocusSessionId ?? toolSid}`}
                    target={{
                      agentId: headerFocusAgentId,
                      agentName: agentNameById.get(headerFocusAgentId) ?? session.agentName ?? headerFocusAgentId,
                      live: !MOCK_MODE
                    }}
                    sessionId={headerFocusAgentId === session.agentId ? toolSid : headerFocusSessionId}
                    pending={pgBusy}
                  />
                )}
                {turns.length > 0 && (
                  <TranscriptApprovalsProvider
                    agentId={session.agentId ?? ''}
                    sessionId={session.realSessionId ?? session.id}
                    {...(taskOwnerApprovals && taskOwnerSessionId ? { listSessionId: taskOwnerSessionId } : {})}
                    enabled={(canReviewApprovals || ownerApprovals || taskOwnerApprovals) && Boolean(session.agentId)}
                    conversationPermissions={ownerApprovals || taskOwnerApprovals}
                    turns={approvalTurns}
                  >
                    {/* Where the pane leaves no gutter beside the 880px column, the turns make room for the turn map at its right. */}
                    <div
                      className={`flex flex-col gap-4 max-desktop:pb-3 desktop:gap-[15px] ${mapTurns.length >= 3 ? 'desktop:@max-[970px]:pr-11' : ''}`}
                    >
                      {turns.map((turn, ti) => (
                        // The turn's clock time is its own centred line above the message, a separator shared by both sides.
                        <div
                          key={turn.key}
                          data-turn-anchor={turn.key}
                          {...(turn.rowSeq !== undefined ? { 'data-msg-seq': turn.rowSeq } : {})}
                          className="-mx-2 flex flex-col gap-[5px] rounded-lg px-2 transition-colors data-[message-located]:bg-(--amber-50)"
                        >
                          {ti === newDividerAt ? <NewDivider /> : null}
                          {turn.time && (
                            <div className="mono text-center text-[11px] leading-normal text-(--text-tertiary)">
                              {turnTimeLabel(turn.time, turnTimeMs(turn))}
                            </div>
                          )}
                          {turn.kind === 'user' ? (
                            <>
                              <UserTurnView
                                turn={turn}
                                platformMark={usesIntegrationAvatar ? sessionIntegration : undefined}
                                footer={rootFooter(turn, 'line')}
                                lead={handedLead(turn)}
                                onReply={(() => {
                                  const root = replyRootOf(turn)
                                  return root ? () => replyInThread(root) : undefined
                                })()}
                                pressToReply={isMobile}
                                onShare={shareMessage(turn)}
                              />
                              {rootFooter(turn, 'card')}
                            </>
                          ) : (
                            (() => {
                              const turnInFlight = sessionTurnInFlight(mainBusy, session.statusLabel)
                              const busyLanes = turnInFlight ? getBusyLaneAgentIds(session.id) : []
                              // The lane names the busy agent only, so only that agent's last turn streams.
                              const streaming = agentTurnStreaming({
                                turnInFlight,
                                index: ti,
                                lastIndex: turns.length - 1,
                                lastExchangeAt,
                                agentId: turn.agentId,
                                busyLanes,
                                agentLastIndex: turn.agentId ? lastBotTurnIndexByAgent.get(turn.agentId) : undefined
                              })
                              const openWork = workPanelOpen(workOverride.get(turn.key ?? ''))
                              return (
                                <BotTurnView
                                  key={`${session.id}:${ti}`}
                                  turn={turn}
                                  agentById={agentById}
                                  owner={owner}
                                  ownerRuntime={agentRuntime}
                                  sessionId={toolSid}
                                  streaming={streaming}
                                  workOpen={openWork}
                                  onToggleWork={() => toggleWork(turn.key ?? '', openWork)}
                                  promptMs={exchangePromptMs(turns, ti)}
                                  lead={turn.inThread ? threadLabel(turn.inThread) : null}
                                  trail={answeredLines(turn.steps)}
                                  openedTasks={openedTaskCards.get(turn.key) ?? []}
                                  taskFooter={(link, opened) => (
                                    <TaskThreadFooter
                                      agentId={opened ? session.agentId! : turn.agentId!}
                                      link={link}
                                      parentSessionId={
                                        opened || turn.agentId === filesAgentId ? subsessionsSessionId : null
                                      }
                                      selected={openThread?.sessionId === link.sessionId}
                                      onOpen={() => openTaskThread(link)}
                                    />
                                  )}
                                  {...(threadsView ? { rootFooter: ownRootFooter } : {})}
                                  answerElicitation={answerElicitation}
                                  appRpc={appRpc}
                                  appReport={appReport}
                                  onShare={shareMessage(turn)}
                                  closeApp={closeApp}
                                  answerFill={answerFill}
                                />
                              )
                            })()
                          )}
                          {turn.kind === 'user' &&
                            turn.seq !== undefined &&
                            (() => {
                              const record = decisionResults.bySeq.get(turn.seq)
                              return record ? (
                                <DecisionResultMarker
                                  record={record}
                                  decisionName={
                                    decisionCatalog?.decisions.find((d) => d.id === record.decisionId)?.name
                                  }
                                  onOpen={() => setOpenDecisionSeq(record.seq)}
                                />
                              ) : turn.body?.codehost?.routing ? (
                                <CodeHostDecisionResult facts={turn.body.codehost} onOpen={setOpenRouting} />
                              ) : null
                            })()}
                        </div>
                      ))}
                    </div>
                    {/* No strip reads a task's requests through its owner, so a waiting one no turn holds is answered here. */}
                    {taskOwnerApprovals ? <UnplacedApprovals /> : null}
                  </TranscriptApprovalsProvider>
                )}
                {openDecisionSeq !== null && decisionResults.lane && (
                  <DecisionEvaluationsDrawer
                    key={openDecisionSeq}
                    conversation={decisionResults.lane.conversation}
                    channelName={decisionResults.lane.channelName}
                    agentName={session.agentName}
                    initialSeq={openDecisionSeq}
                    onClose={() => setOpenDecisionSeq(null)}
                  />
                )}
                {openRouting && (
                  <DecisionEvaluationsDrawer
                    key={`${openRouting.source.key.join('|')}:${openRouting.seq}`}
                    source={openRouting.source}
                    channelName={openRouting.repoName}
                    agentName={session.agentName}
                    initialSeq={openRouting.seq}
                    onClose={() => setOpenRouting(null)}
                  />
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
                    {mainBusy &&
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
                        // An agent whose turn for this exchange already shows says it is working in that turn's header.
                        const answering = new Set(
                          turns.flatMap((turn, i) =>
                            turn.kind === 'bot' && i > lastExchangeAt ? [turn.agentId || owner?.id] : []
                          )
                        )
                        const rows = (busyAgents.length > 0 ? busyAgents : [owner]).filter(
                          (agent) => !answering.has(agent?.id)
                        )
                        // 26px mark + 10px gap, an agent turn's geometry, so the dots start on its prose's left edge.
                        return rows.map((agent, i) => (
                          <div key={agent?.id ?? i} className="flex items-center gap-[10px] desktop:mt-[14px]">
                            <span className="av h-[26px] w-[26px] flex-none rounded-md">
                              <AgentIconView icon={agent?.icon} runtime={agent?.runtime || agentRuntime} size={26} />
                            </span>
                            <div className="inline-flex items-center gap-1 py-[11px]">
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
                          {t('startWith')}
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
                    {fillRequest ? <FillOpener key={`${session.id}:${fillRequest}`} open={openFill} /> : null}
                    {fillOpenError && (
                      <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
                        {t('fillOpenFailed', { reason: fillOpenError })}
                      </div>
                    )}
                    {/* Gap under the last turn; `flex-1` fills out a short transcript, and `-mt-4` cancels the mobile gutter so a collapsed spacer adds nothing. */}
                    <div aria-hidden="true" className="-mt-4 flex-1 desktop:mt-0 desktop:min-h-[18px]" />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        {isLive ? (
          // Below the scroller, so its scrollbar ends at the composer; the right inset is the scroller's padding plus its scrollbar, so the 880px columns line up.
          <div
            className={
              viewerOpen
                ? 'hidden'
                : 'relative z-10 flex-none pt-2 pb-1 max-desktop:pr-[calc(12px+var(--transcript-gutter))] max-desktop:pl-3 desktop:max-wide:pr-(--transcript-gutter) desktop:pt-3 wide:pr-[calc(10px+var(--transcript-gutter))]'
            }
            style={{ '--transcript-gutter': `${transcriptGutter}px` } as CSSProperties}
          >
            <div className="relative mx-auto w-full min-w-0 max-w-[880px]">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-b from-transparent to-(--surface-app)"
              />
              {/* Jump-to-bottom: floats just above the composer while the reader is
                  scrolled up out of a transcript long enough to scroll. Click re-arms
                  the bottom-follow (same path a send takes) and snaps to the newest turn. */}
              {awayFromBottom && (
                <button
                  type="button"
                  data-jump-latest=""
                  onClick={() => stickToBottom()}
                  title={t('scrollLatest')}
                  className="absolute -top-3 left-1/2 z-10 inline-flex h-9 -translate-x-1/2 -translate-y-full cursor-pointer items-center gap-[7px] rounded-full border border-(--border-default) bg-(--surface-card) px-4 font-sans text-[13px] font-medium leading-normal whitespace-nowrap text-(--text-primary) shadow-(--shadow-md) transition-colors hover:border-(--border-strong) hover:bg-(--surface-hover)"
                >
                  <Icon name="arrow-down" size={15} />
                  {t('jumpToLatest')}
                </button>
              )}
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
                  // A coordinator's tasks write under its conversation's grant, and each answers its own on its thread.
                  {...(session.coordinator ? { raisedHere: raisedIn(visibleMsgs) } : {})}
                  // A delegated write never executes in the agent's own request: it
                  // answered with an operationId and the turn ended, so the decision is
                  // news the conversation has to deliver, or a flow that writes stops
                  // dead at its first write. The CP stays off the message path.
                  onDecided={(operation, decision, outcome) => {
                    // pgNotice, not the composer's send: an unsent draft and a
                    // staged image belong to the owner, and deciding is not a send.
                    if (isContinuable) markSessionTarget(session.id)
                    pgNotice(
                      session.id,
                      session.agentId ?? '',
                      approvalNotice(operation, decision, outcome),
                      isWebchat ? session.channelId : undefined,
                      isWebchat ? liveRoster : undefined
                    )
                  }}
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
                        aria-label={t('cancelQueued')}
                        title={t('cancelQueued')}
                        onClick={() => pgCancelQueued(session.id, q.queueId)}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {taskListAvailable && filesAgentId && tasksSessionId ? (
                <RunningCommandsDock agentId={filesAgentId} sessionId={tasksSessionId} turnActive={focusBusy} />
              ) : null}
              {/* Composer card (design "achero"): textarea on top, a toolbar row below
                  the divider — attach · model pill (fast toggle in its menu) · effort ·
                  permission · context ring · send. Tokens/cost live in the header's
                  Details popover, not here. */}
              <div
                className="relative min-w-0 rounded-[11px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--border-strong) focus-within:shadow-(--focus-shadow)"
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
                    aria-label={t('conversationUnavailableLabel')}
                    placeholder={resumePlaceholder}
                    disabled
                  />
                )}
                {attachmentsEnabled && (
                  <input
                    ref={imageInputRef}
                    type="file"
                    multiple
                    hidden
                    accept={filesEnabled ? undefined : 'image/*'}
                    onChange={(event) => onAttachFiles(Array.from(event.target.files ?? []))}
                  />
                )}
                {attachmentsEnabled && (
                  <AttachmentCards
                    className="px-[15px] pt-3"
                    cards={composerCards(pgFiles, pgImage)}
                    onRemove={(key) =>
                      key === INLINE_IMAGE_KEY
                        ? setPgImage(session.id)
                        : setPgFiles(session.id, (files) => files.filter((f) => f.key !== key))
                    }
                  />
                )}
                <ComposerTextarea
                  sessionId={session.id}
                  placeholder={
                    (session.participants?.length ?? 0) > 1 && !pickRecipient
                      ? 'Message everyone…'
                      : `Message ${pickRecipient ? composerAgentName : session.agentName}…`
                  }
                  onSend={() => onPgSend()}
                  onAttachFiles={attachmentsEnabled ? onAttachFiles : undefined}
                  mentionCandidates={mentionCandidates}
                  onPickMention={onPickMention}
                  onMentionJoiningChange={setMentionJoining}
                  onCommandPick={(target) => {
                    commandPickRef.current = target
                  }}
                  commands={commandParticipants}
                  controls={composerControls}
                  history={composerHistory}
                  hasEarlier={visibleHasEarlier}
                  loadEarlier={loadEarlierConversation}
                  loadedRows={visibleMsgs?.length ?? 0}
                />
                <div className="flex items-center gap-2 border-t border-(--border-subtle) py-[7px] pr-[9px] pl-[10px]">
                  {attachmentsEnabled && (
                    <div className="relative flex-none">
                      <button
                        type="button"
                        className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
                        aria-label={t('attachFile')}
                        aria-haspopup="menu"
                        aria-expanded={attachMenuOpen}
                        title={t('attachFile')}
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
                              <Icon name="paperclip" size={16} color="var(--text-secondary)" />
                              {filesEnabled ? t('addFiles') : t('addImages')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
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
                        const chip = (
                          <>
                            {rosterAgent && (
                              <span className="av h-[14px] w-[14px] flex-none rounded-xs">
                                <AgentIconView icon={rosterAgent.icon} runtime={rosterAgent.runtime} size={14} />
                              </span>
                            )}
                            <span className="truncate">{p.name}</span>
                          </>
                        )
                        if (!pickRecipient) {
                          const removable = isPg && !p.primary && p.agentId !== session.agentId
                          return (
                            <span key={p.agentId} className={COMPOSER_PILL_STATIC} title={t('participant')}>
                              {chip}
                              {removable && (
                                <button
                                  type="button"
                                  className="-mr-1 inline-flex h-4 w-4 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-50"
                                  title={t('removeParticipant', { agent: p.name })}
                                  aria-label={t('removeParticipant', { agent: p.name })}
                                  disabled={pgBusy || pgQueue.length > 0}
                                  onClick={() => void pgRemoveAgent(session.id, p.agentId)}
                                >
                                  <Icon name="x" size={12} />
                                </button>
                              )}
                            </span>
                          )
                        }
                        const member = conversationMembers?.find((m) => m.agentId === p.agentId)
                        const selectable =
                          p.agentId === session.agentId || (!!member && memberContinuable(member.sessionId))
                        const on = p.agentId === composerAgentId
                        return (
                          <button
                            key={p.agentId}
                            type="button"
                            aria-pressed={on}
                            className={on ? COMPOSER_RECIPIENT_ON : COMPOSER_RECIPIENT_OFF}
                            // The socket follows the pick, so it holds still while a turn or queue is in flight.
                            disabled={!selectable || pgBusy || pgQueue.length > 0}
                            onClick={() => setComposerPick({ scope: conversationKey ?? '', agentId: p.agentId })}
                          >
                            {chip}
                          </button>
                        )
                      })}
                    {/* h-7 w-7 like every other control on this row (and the Home composer's
                        twin), so the dashed circle shares their 28px box instead of floating
                        inside it. A lucide glyph, not a text "+": a text plus centres on its
                        line box, which left it a hair low. */}
                    {isPg && addAgentOptions.length > 0 && (
                      <ComposerMenu
                        title={t('addAgents')}
                        value=""
                        options={addAgentOptions}
                        searchable
                        searchPlaceholder={t('searchAgents')}
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
                    {!multiLive && (agentRuntime || pgModel || byDecision || runtimePending) && (
                      <RuntimeModelSelect
                        compact
                        pending={runtimePending}
                        ariaLabel={t('model')}
                        value={{ runtime: agentRuntime, model: pgShownModel }}
                        source={pickerSource}
                        runtimes={beforeFirstTurn ? undefined : [agentRuntime]}
                        readsImage={!!owner && strategyUsesImage(owner.execution)}
                        readOnly={!runtimeChangesEnabled}
                        {...(runtimeOwnersOnly ? { readOnlyNote: runtimeModelT('readOnlyOwner') } : {})}
                        decision={
                          beforeFirstTurn && owner?.modelSelection
                            ? {
                                name: runtimeDecision?.name ?? runtimeModelT('byDecision'),
                                selected: byDecision,
                                selection: owner.modelSelection,
                                question: runtimeDecision?.question,
                                fallback: { runtime: agentRuntime, model: pgModel },
                                decisionHref:
                                  runtimeDecision && orgPath(`/decisions/${encodeURIComponent(runtimeDecision.id)}`),
                                evaluations: modelEvaluationsTarget(owner),
                                onSelect: () => {
                                  setRuntimeSelections((current) => ({
                                    ...current,
                                    [session.id]: { fast: current[session.id]?.fast }
                                  }))
                                  pgStageRuntime(session.id, {
                                    runtime: undefined,
                                    model: undefined,
                                    effort: undefined,
                                    permissionMode: undefined
                                  })
                                }
                              }
                            : undefined
                        }
                        settings={
                          byDecision
                            ? undefined
                            : {
                                effort: pgEffort
                                  ? { value: pgEffort, options: pgEffortOptions, onChange: changeEffort }
                                  : undefined,
                                // A coordinator always runs read-only (auto-session-mode.md §5.4).
                                approval:
                                  pgPermissionPreset && !coordinatorPage
                                    ? {
                                        value: pgPermissionPreset,
                                        options: pgApprovalOptions,
                                        onChange: changePermission
                                      }
                                    : undefined,
                                fast: pgFastModeAvailable ? { value: pgFastMode, onChange: changeFast } : undefined
                              }
                        }
                        onChange={changeRuntimeModel}
                      />
                    )}
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
                        <span className="truncate">{isolationLabel.mode}</span>
                      </label>
                    )}
                  </div>
                  <ContextWindowIndicator used={u?.contextUsed} size={u?.contextSize} />
                  <ComposerSendButton
                    sessionId={session.id}
                    busy={pgBusy || isPgTurnUnstreamed(session.id)}
                    imagePreparing={imagePreparing || filesUploading}
                    hasImage={!!pgImage || pgFiles.some((f) => f.status === 'ready')}
                    mentionJoining={mentionJoining}
                    onSend={() => onPgSend()}
                    onStop={() => pgCancel(session.id, composerAgentId, webchatConversationId)}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {/* Opening a file also closes the collapsed-band overlay: below `wide:` the dock is a drawer over the very pane the file lands in, and on a phone the viewer IS the screen (§8). The dock's own latch resets on this key. */}
      <SessionDock
        tabs={dockTabs}
        activeKey={dockTabKey}
        onTabChange={setDockTab}
        onTabAction={(key) => {
          if (key === 'files') setFilesRefreshTick((tick) => tick + 1)
          if (key === 'git') setGitRefreshTick((tick) => tick + 1)
          // PR's action is the design's `external-link`, not a refresh: it opens the PR's own page (the panel body carries its own refresh).
          if (key === 'pr' && prVerdict.url) window.open(prVerdict.url, '_blank', 'noopener,noreferrer')
          if (key === 'tasks') setTasksRefreshTick((tick) => tick + 1)
        }}
        overlayKey={`${session.id}:${viewerPath ?? ''}`}
        revealKey={dockReveal}
        label={t('panels')}
        onVisibleChange={setDockVisible}
        stripHidden={dockTabKey === 'tasks' && threadOpen}
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
              {t('filesScopeFailed')}
            </div>
          ) : null}
          {filesAgentId && filesScopeReady ? (
            <FilesPanel
              active={dockTabKey === 'files'}
              turnActive={focusBusy}
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
              {t('gitScopeFailed')}
            </div>
          ) : null}
          {/* Mounted on the same terms as Files, and for the same reason: the panel's verdict is what keeps its own tab out of the dock's vacant state, so a lazily mounted one makes the tab unreachable. */}
          {filesAgentId && filesScopeReady ? (
            <GitPanel
              agentId={filesAgentId}
              {...(filesSessionId ? { sessionId: filesSessionId } : {})}
              active={dockTabKey === 'git'}
              turnActive={focusBusy}
              refreshTick={gitRefreshTick}
              openPath={viewerOpen && viewerMode !== 'file' ? viewerPath : null}
              openStaged={viewerMode === 'staged'}
              canWrite={canWriteWorkspace}
              onWrote={onPanelWrote}
              onOpenDiff={(path, staged, untracked) =>
                setViewerFile(path, filesAgentId, untracked ? 'file' : staged ? 'staged' : 'diff')
              }
              onVerdictChange={setGitVerdict}
            />
          ) : null}
        </DockPanel>
        {/* SESSION-keyed, not focus-keyed: the run belongs to the open session, so the header focus menu must not re-key this panel — its props carry no agent at all. Mounted whenever a probe-able id exists, because its verdict is what puts its own tab in the strip: a panel mounted only for a visible tab could never reveal the tab. */}
        <DockPanel active={dockTabKey === 'pr'}>
          {prSessionId ? (
            <PullRequestPanel
              sessionId={prSessionId}
              active={dockTabKey === 'pr'}
              {...(session?.status ? { sessionStatus: session.status } : {})}
              turnActive={sessionBusy}
              // The branch facts the no-PR state describes, from the Git tab's own read — the dock holds them already, so the PR panel spends no second round trip on them. Passed ONLY when that read is about THIS panel's session worktree: Files/Git follow header focus and the PR tab deliberately does not (§3.4), so in a merged conversation the focused participant's checkout is a different branch, and naming it here would put another agent's branch in this session's create-pull-request turn. Out of scope ⇒ null, and the panel says "this session's branch" instead of guessing which.
              branch={prBranchScoped ? gitVerdict.branch : null}
              tracking={prBranchScoped ? gitVerdict.tracking : null}
              // The base the create-pull-request turn targets, from the same scoped read: the workspace's CONFIGURED branch, which an agent configured onto `release` while the repository defaults to `main` makes a different branch entirely. Out of scope ⇒ null, like the two above.
              base={prBranchScoped ? gitVerdict.base : null}
              // Both write actions ride the LIVE composer path (§5.2) behind the composer's OWN availability fence: a hook session has no composer, and a persisted webchat under `resumeDisabled` (agent moved, resume check pending) deliberately renders the composer inert — this callback must not exist as a way around that.
              // And NOT in a multi-agent conversation: this send carries no @mention, so the relay applies its all-participants default (see `onPgSend`) and every participant would run the turn — three agents each publishing their own worktree and opening their own pull request for one ask. The panel is session-keyed and holds no agent identity to narrow to, so the honest answer is to withhold both actions here; the composer's own mention chips are the surface for asking ONE agent.
              {...(isLive && !resumeDisabled && !multiLive ? { onPostTurn: (text: string) => onPgSend(text) } : {})}
              {...(prWakeAgentId ? { wakeSandbox: () => wakeAgent(prWakeAgentId, prSessionId) } : {})}
              onVerdictChange={setPrVerdict}
            />
          ) : null}
        </DockPanel>
        {/* Mounted while hidden, like PR: its verdict is what puts its tab in the strip once any group has something to show. */}
        <DockPanel active={dockTabKey === 'computer'}>
          {computerIds.length > 0 || computerManaged ? (
            <ComputerPanel
              computerIds={computerIds}
              agentId={filesAgentId}
              {...(computerManaged ? { managed: computerManaged } : {})}
              active={dockVisible && dockTabKey === 'computer'}
            />
          ) : null}
        </DockPanel>
        <DockPanel active={dockTabKey === 'tasks'}>
          {(openThread || openRoot) && session.agentId ? (
            <ThreadPanel
              key={openRoot ?? openThread?.sessionId}
              {...(openRoot && threadWork.get(openRoot) ? { fromMain: threadWork.get(openRoot) } : {})}
              onShowInConversation={showInConversation}
              agentId={session.agentId}
              agentName={session.agentName ?? ''}
              agentIcon={owner?.icon}
              agentRuntime={agentRuntime || undefined}
              agentById={agentById}
              platform={session.platform ?? ''}
              {...(openThread ? { task: openThread } : openRootTask ? { task: openRootTask } : {})}
              {...(openRoot ? { record: { sessionId: session.realSessionId ?? session.id, rootId: openRoot } } : {})}
              {...(openRoot && threadWriter ? { writer: threadWriter } : {})}
              {...(openRoot ? { onSummary: putThread, focusComposer: taskThread?.focus === true } : {})}
              {...(openRootUrl ? { threadUrl: openRootUrl } : {})}
              parentSessionId={session.agentId === filesAgentId ? subsessionsSessionId : null}
              {...(activeOrg && session.coordinator && webchatConversationId
                ? { approvals: { orgId: activeOrg.id, conversationId: webchatConversationId } }
                : {})}
              onBack={closeThread}
              {...(taskApprovalScope ? { taskApprovals: taskApprovalScope } : {})}
              runtimeContext={taskRuntimeContext}
              people={people}
              fileTransfer={composerTransfer}
              attachments={attachmentsEnabled}
            />
          ) : null}
          {/* Mounted under an open thread too, so its verdict keeps the tab's badge and the reader comes back to the same lists. */}
          <div className={threadOpen ? 'hidden' : 'contents'}>
            {filesAgentId && tasksSessionId ? (
              <TasksPanel
                agentId={filesAgentId}
                sessionId={tasksSessionId}
                delegated={subsessionsSessionId !== null}
                coordinator={coordinatorPage}
                active={dockTabKey === 'tasks' && !threadOpen}
                turnActive={focusBusy}
                refreshTick={tasksRefreshTick}
                onVerdictChange={setTasksVerdict}
                {...(session.agentId ? { onOpenThread: (link: TaskLink) => openTaskThread(link) } : {})}
                {...(session.agentId && coordinatorPage
                  ? { onOpenRoot: (rootId: string) => openRootThread(rootId) }
                  : {})}
              />
            ) : null}
          </div>
        </DockPanel>
      </SessionDock>
    </div>
  )
}
