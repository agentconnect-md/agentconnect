'use client'

import { type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { speaker, type Agent, type ElicitAnswerValue } from '@/lib/data'
import { agentToneColor } from '@/lib/agent-tone'
import { AGENT_PROSE, SELF_BUBBLE } from '@/components/console/transcript-bubbles'
import { AgentTurnHeader } from '@/components/console/AgentTurnHeader'
import { TurnApprovals } from '@/components/console/TurnApprovals'
import { askedApprovalIds } from '@/components/console/approval-placement'
import { AgentIconView, PlatformMark, Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { SharedFileChip } from '@/components/console/SharedFileChip'
import { SharedImageCard } from '@/components/console/SharedImageCard'
import { SessionMessageCaption, UserTurnDetails } from '@/components/console/UserTurnDetails'
import type { McpAppRpc } from '@agentconnect.md/protocol'
import type { McpAppCardProps } from '@/components/console/McpAppCard'
import { Avatar, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { AttachmentCards, messageCards } from '@/components/console/ComposerFiles'
import {
  CAPABILITY_LANE,
  APP_LANE,
  ELICIT_LANE,
  NOTICE_LANE,
  PLAN_LANE,
  WORK_LANES,
  turnSpan,
  withPromptStart
} from '@/components/console/session-work'
import { CapabilityRequestCard } from '@/components/console/CapabilityRequestCard'
import { ReplyInThreadButton, ThreadRootPress } from '@/components/console/ThreadRootActions'
import { type TaskLink } from '@/components/console/task-link'
import { CopyTurnButton, StepExtras, McpAppRow, turnWork, WorkStepList } from '@/components/console/WorkPanel'
import { type Turn } from '@/components/console/session-turns'
import type { FmtStep } from '@/components/console/transcript-steps'
import { ElicitationCard, PlanBlock } from '@/components/console/TranscriptCards'
import { HOVER_TOOL_BUTTON, HOVER_TOOL_ICON, HoverToolbar } from '@/components/console/HoverToolbar'

function ParticipantAvatar({
  agent,
  avatarUrl,
  avatarInitials,
  platformMark,
  sp,
  isCron,
  href
}: {
  agent: Agent | null
  /** The agent's page; an agent's mark opens it. */
  href?: string
  avatarUrl?: string | null
  avatarInitials?: string
  platformMark?: string
  sp: ReturnType<typeof speaker>
  isCron: boolean
}) {
  const boxClass = `av flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md font-sans text-[9.5px] font-semibold leading-normal ${
    !agent && !isCron ? 'bg-transparent' : ''
  }`
  if (agent && href)
    return (
      <Link href={href} className={boxClass} title={sp.name} aria-label={sp.name}>
        <AgentIconView icon={agent.icon} runtime={agent.runtime} size={26} />
      </Link>
    )
  return (
    <span className={boxClass} title={sp.name}>
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

type UserTurn = Extract<Turn, { kind: 'user' }>
type BotTurn = Extract<Turn, { kind: 'bot' }>

/** A message's hover menu, a person's or an agent's alike: Reply in its thread where the reader may, and Copy of its text. */
function MessageMenu({
  text,
  onReply,
  onShare,
  className,
  ...attrs
}: {
  text?: string | undefined
  onReply?: (() => void) | undefined
  /** Shares the message: its session's Share dialog with a link to this message. */
  onShare?: (() => void) | undefined
  /** Where the menu floats on its message. */
  className: string
} & Record<`data-${string}`, string>) {
  const tt = useTranslations('Common.taskThread')
  const tShare = useTranslations('Sessions.share')
  if (!text && !onReply && !onShare) return null
  return (
    <HoverToolbar group="turn" label={tt('messageActions')} className={className} {...attrs}>
      {onReply ? <ReplyInThreadButton onReply={onReply} /> : null}
      {text ? <CopyTurnButton text={text} className={HOVER_TOOL_BUTTON} /> : null}
      {onShare ? (
        <button
          type="button"
          data-message-share=""
          aria-label={tShare('share')}
          title={tShare('share')}
          onClick={onShare}
          className={HOVER_TOOL_BUTTON}
        >
          <Icon name="share" size={HOVER_TOOL_ICON} />
        </button>
      ) : null}
    </HoverToolbar>
  )
}

export function UserTurnView({
  turn,
  platformMark,
  footer,
  onReply,
  pressToReply = false,
  lead,
  onShare
}: {
  turn: UserTurn
  /** The integration whose mark stands in for a sender with no picture. */
  platformMark?: string | undefined
  /** Under the bubble: a thread root's footer. */
  footer?: ReactNode
  /** Reply in this root's thread; absent where the reader may not. */
  onReply?: (() => void) | undefined
  /** A long press replies too, as a phone reader has no hover. */
  pressToReply?: boolean
  /** Above the bubble: the thread a handed message joined, which it opens. */
  lead?: ReactNode
  /** Shares this message: its Share dialog with a link to it. */
  onShare?: (() => void) | undefined
}) {
  const { orgPath } = useOrgs()
  return (
    <div className="group/turn flex items-start justify-end gap-[9px]">
      <ThreadRootPress
        enabled={pressToReply && onReply !== undefined}
        onReply={() => onReply?.()}
        className="relative flex min-w-0 max-w-[86%] flex-col items-end gap-[3px]"
      >
        <span className="flex items-center gap-[6px] pr-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {turn.isCron && turn.cronId ? (
            <Link className="lnk text-inherit" href={orgPath(`/crons/${turn.cronId}`)}>
              {turn.sp.name}
            </Link>
          ) : (
            <span>{turn.sp.name}</span>
          )}
        </span>
        {lead}
        {turn.steer && (
          // A glyph and one word; the full meaning sits in the tooltip.
          <span
            className="flex items-center gap-1 pr-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)"
            title={turn.steered ? 'Steered into the running reply' : 'Steering into the running reply…'}
          >
            {turn.steered ? <Icon name="corner-down-right" size={11} /> : <Spinner size={10} />}
            {turn.steered ? 'Steered' : 'Steering…'}
          </span>
        )}
        {/* A sent message wraps its cards right-aligned so none hides off-screen; the composer keeps one scrolling row. */}
        <AttachmentCards className="mb-[3px] flex-wrap justify-end" cards={messageCards(turn.images, turn.files)} />
        {(turn.text || turn.body) && (
          <div className="relative max-w-full">
            <div className={SELF_BUBBLE}>
              {turn.body?.sessionMessage && <SessionMessageCaption facts={turn.body.sessionMessage} />}
              {turn.text && <MessageText text={turn.text} platform={turn.platform} />}
              {turn.body && <UserTurnDetails body={turn.body} platform={turn.platform} />}
            </div>
            {/* Its hover menu on the bubble's top edge at the side facing the timeline: a message on the right keeps its menu on the left. */}
            <MessageMenu
              text={turn.text}
              onReply={onReply}
              onShare={onShare}
              className="left-[8px] bottom-full -mb-[6px]"
            />
          </div>
        )}
        {footer}
        {/* A message of attachments alone has no bubble: its menu sits on the column's top edge instead. */}
        {turn.text || turn.body ? null : <MessageMenu onReply={onReply} onShare={onShare} className="top-0 left-0" />}
      </ThreadRootPress>
      <ParticipantAvatar
        agent={turn.agent}
        {...(turn.agent ? { href: orgPath(`/agents/${encodeURIComponent(turn.agent.id)}`) } : {})}
        avatarUrl={turn.avatarUrl}
        avatarInitials={turn.avatarInitials}
        platformMark={platformMark}
        sp={turn.sp}
        isCron={turn.isCron}
      />
    </div>
  )
}

/** An agent's turn: its mark, a header that folds its work, then what it said in order, its plan, notices and approvals. */
/** What a turn said last, as one plain sentence: the last sentence of its spoken answer, markers stripped; '' when it said nothing. */
export function lastSpokenSentence(steps: readonly FmtStep[]): string {
  const said = steps
    .filter(
      (s) =>
        !WORK_LANES.has(s.lane) &&
        s.lane !== NOTICE_LANE &&
        s.lane !== PLAN_LANE &&
        s.lane !== ELICIT_LANE &&
        s.lane !== APP_LANE &&
        s.lane !== CAPABILITY_LANE
    )
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n')
  const plain = said
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]/g, '')
  // Sentences end at a stop (Latin or CJK) or a line break; the last one with any words is what the turn left you with.
  const sentences = plain
    .split(/(?<=[.!?。！？])\s+|(?<=[。！？])|\n+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
  return sentences.at(-1) ?? ''
}

export function BotTurnView({
  turn,
  agentById,
  owner,
  ownerRuntime,
  sessionId,
  streaming,
  workOpen,
  onToggleWork,
  promptMs,
  lead,
  trail,
  openedTasks,
  taskFooter,
  answerElicitation,
  appRpc,
  appReport,
  closeApp,
  onShare
}: {
  turn: BotTurn
  agentById: ReadonlyMap<string, Agent>
  /** The session's agent, whose mark a turn of an unknown agent borrows. */
  owner: Agent | undefined
  /** The owner's runtime, the icon's fallback when the turn's agent is unknown. */
  ownerRuntime: string
  /** The session tool bodies, files and app cards are read through. */
  sessionId: string | undefined
  streaming: boolean
  workOpen: boolean
  onToggleWork: () => void
  /** When the message this turn answers was sent, which its work span measures from. */
  promptMs: number | undefined
  /** Before the work panel: the thread the turn answers in. */
  lead?: ReactNode
  /** After what the turn said: the threads it answered in. */
  trail?: ReactNode
  /** Tasks opened for the messages this turn answers, unless a step already links them. */
  openedTasks?: readonly TaskLink[]
  /** A task's card; without it a step linking a task reads as prose. */
  taskFooter?: (link: TaskLink, opened: boolean) => ReactNode
  answerElicitation?:
    ((agentId: string | undefined, requestId: string | undefined, value: ElicitAnswerValue) => void) | undefined
  appRpc?:
    | ((
        agentId: string | undefined,
        appId: string,
        rpc: McpAppRpc
      ) => ReturnType<NonNullable<McpAppCardProps['onRpc']>>)
    | undefined
  appReport?: ((agentId: string | undefined, text: string) => boolean) | undefined
  closeApp?: ((agentId: string | undefined, appId: string) => void) | undefined
  /** Shares this message: its Share dialog with a link to it. */
  onShare?: (() => void) | undefined
}) {
  const { orgPath } = useOrgs()
  // The answer reads as prose, work folds under the header line, and a daemon notice stands on its own line.
  const noticeSteps = turn.steps.filter((s) => s.lane === NOTICE_LANE)
  // The turn's plan is its own block, neither spoken answer nor folded work.
  const planSteps = turn.steps.filter((s) => s.lane === PLAN_LANE)
  // What the turn SAID, in order: prose blocks and question cards stay where the agent put them.
  const saidSteps = turn.steps.filter((s) => !WORK_LANES.has(s.lane) && s.lane !== NOTICE_LANE && s.lane !== PLAN_LANE)
  // A coordinator's link to a task it opened or passed a message to is a card that opens the task's thread.
  const taskLinks = saidSteps.map((s) => (taskFooter ? (s.taskLink ?? null) : null))
  const textSteps = saidSteps.filter((s) => s.lane !== ELICIT_LANE && s.lane !== APP_LANE && s.lane !== CAPABILITY_LANE)
  const { workSteps, summary, failed } = turnWork(turn.steps)
  // Keyed by agent id so the colour survives a rename; an id-less row falls back to its name.
  const turnTone = agentToneColor(turn.agentId || turn.agentName)
  // What the turn's copy button copies: the spoken answer.
  const answerText = textSteps
    .map((st) => st.text)
    .filter(Boolean)
    .join('\n\n')
  const turnAgent = turn.agentId ? agentById.get(turn.agentId) : owner
  const mark = (
    <AgentIconView
      icon={(turnAgent ?? owner)?.icon}
      runtime={(turn.agentId ? agentById.get(turn.agentId)?.runtime : undefined) ?? (ownerRuntime || turn.model)}
      size={26}
    />
  )
  return (
    <div className="group/turn flex items-start gap-2 desktop:gap-[10px]">
      {/* Only a turn whose agent is known links, never the owner fallback the icon may borrow. */}
      {turnAgent ? (
        <Link
          href={orgPath(`/agents/${encodeURIComponent(turnAgent.id)}`)}
          className="av h-[26px] w-[26px] flex-none rounded-md"
          title={turn.agentName}
          aria-label={turn.agentName}
        >
          {mark}
        </Link>
      ) : (
        <span className="av h-[26px] w-[26px] flex-none rounded-md">{mark}</span>
      )}
      <div className="relative min-w-0 flex-1" style={{ '--agent-accent': turnTone } as CSSProperties}>
        {/* A finished answer's hover menu, at the right of its header row. */}
        {streaming ? null : (
          <MessageMenu text={answerText} onShare={onShare} className="-top-[3px] right-0" data-turn-toolbar="" />
        )}
        <AgentTurnHeader
          name={turn.agentName}
          {...(workSteps.length > 0
            ? {
                work: {
                  summary,
                  failed,
                  open: workOpen,
                  onToggle: onToggleWork,
                  running: streaming,
                  span: withPromptStart(turnSpan(turn.steps.map((st) => st.timeMs)), promptMs)
                }
              }
            : {})}
        />
        <div className="flex min-w-0 flex-col gap-[10px]">
          {lead}
          {/* Work happens before the answer, so the open panel sits right under the header. */}
          {workSteps.length > 0 && workOpen && (
            <WorkStepList steps={workSteps} sessionId={sessionId} live={streaming} />
          )}
          {noticeSteps.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[3px]">
              {noticeSteps.map((st, si) => (
                <span
                  key={`n:${si}`}
                  className="min-w-0 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
                >
                  {st.text}
                </span>
              ))}
            </div>
          )}
          {planSteps.map((st, si) => (
            <PlanBlock key={`p:${si}`} step={st} />
          ))}
          {/* One prose block per text step: a turn that answers in two chunks delivered two messages, so they stay apart. */}
          {saidSteps.map((st, si) =>
            st.lane === APP_LANE ? (
              <div key={`a:${st.app?.appId ?? si}`}>
                <McpAppRow
                  step={st}
                  sessionId={st.toolSessionId ?? sessionId}
                  {...(appRpc ? { onRpc: (appId, rpc) => appRpc(turn.agentId, appId, rpc) } : {})}
                  {...(appReport ? { onReport: (text: string) => appReport(turn.agentId, text) } : {})}
                  {...(closeApp ? { onClose: (appId) => closeApp(turn.agentId, appId) } : {})}
                />
              </div>
            ) : st.lane === CAPABILITY_LANE && st.capability ? (
              <div key={`c:${st.capability.requestId}`}>
                <CapabilityRequestCard body={st.capability} />
              </div>
            ) : st.lane === ELICIT_LANE ? (
              <div key={`e:${st.elicit?.requestId ?? si}`}>
                <ElicitationCard
                  step={st}
                  {...(answerElicitation
                    ? {
                        onAnswer: (value: ElicitAnswerValue) =>
                          answerElicitation(turn.agentId, st.elicit?.requestId, value)
                      }
                    : {})}
                />
              </div>
            ) : taskLinks[si] && turn.agentId && taskFooter ? (
              <div key={`t:${si}`}>{taskFooter(taskLinks[si], false)}</div>
            ) : (
              <div key={si} className={AGENT_PROSE} data-agent-prose="">
                {st.sharedImage ? (
                  <SharedImageCard
                    {...(st.postId ? { postId: st.postId } : {})}
                    image={st.sharedImage}
                    {...(st.text ? { caption: st.text } : {})}
                    {...(st.file ? { file: st.file } : {})}
                    {...(turn.agentId ? { agentId: turn.agentId } : {})}
                    {...(st.peerCopy ? {} : { sessionId: st.toolSessionId ?? sessionId })}
                  />
                ) : (
                  <>
                    {st.sessionMessage && <SessionMessageCaption facts={st.sessionMessage} />}
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
                    {st.file && (
                      <div className={st.text ? 'mt-2' : ''}>
                        <SharedFileChip
                          file={st.file}
                          agentId={turn.agentId}
                          sessionId={st.toolSessionId ?? sessionId}
                        />
                      </div>
                    )}
                    {st.sessionMessage && <UserTurnDetails body={{ sessionMessage: st.sessionMessage }} />}
                  </>
                )}
                <StepExtras step={st} sessionId={sessionId} />
              </div>
            )
          )}
          {trail}
          {taskFooter
            ? (openedTasks ?? [])
                .filter((link) => !taskLinks.some((shown) => shown?.sessionId === link.sessionId))
                .map((link) => <div key={`o:${link.sessionId}`}>{taskFooter(link, true)}</div>)
            : null}
          {/* A tool call's approval closes the turn that asked it, after what the agent said before asking. */}
          <TurnApprovals turnKey={turn.key} asked={askedApprovalIds(turn.steps)} />
          {/* A phone has no hover: its Copy stays under the answer, in the inter-turn gap. */}
          {!streaming && answerText && (
            <span className="absolute left-0 top-full desktop:hidden">
              <CopyTurnButton text={answerText} />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
