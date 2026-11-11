'use client'

import { Fragment, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { speaker, type Agent, type ElicitAnswerValue, type FillCardAnswer } from '@/lib/data'
import { agentToneColor } from '@/lib/agent-tone'
import { AGENT_BUBBLE, AGENT_PROSE, DELIVERED_BUBBLE, SELF_BUBBLE } from '@/components/console/transcript-bubbles'
import { AgentTurnHeader } from '@/components/console/AgentTurnHeader'
import { TurnApprovals } from '@/components/console/TurnApprovals'
import { askedApprovalIds } from '@/components/console/approval-placement'
import { AgentIconView, PlatformMark, Spinner } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { SharedFileChip } from '@/components/console/SharedFileChip'
import { SharedImageCard } from '@/components/console/SharedImageCard'
import { SessionMessageCaption, UserTurnDetails } from '@/components/console/UserTurnDetails'
import type { McpAppRpc, SessionMessageTurnFacts } from '@agentconnect.md/protocol'
import type { McpAppCardProps } from '@/components/console/McpAppCard'
import { Avatar, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { AttachmentCards, messageCards } from '@/components/console/ComposerFiles'
import {
  CAPABILITY_LANE,
  FILL_LANE,
  APP_LANE,
  ELICIT_LANE,
  NOTICE_LANE,
  PLAN_LANE,
  WORK_LANES,
  turnSpan,
  withPromptStart
} from '@/components/console/session-work'
import { CapabilityRequestCard } from '@/components/console/CapabilityRequestCard'
import { FillCard } from '@/components/console/FillCard'
import { ThreadRootPress } from '@/components/console/ThreadRootActions'
import { type TaskLink } from '@/components/console/task-link'
import { StepExtras, McpAppRow, turnWork, WorkStepList } from '@/components/console/WorkPanel'
import { type Turn } from '@/components/console/session-turns'
import type { FmtStep } from '@/components/console/transcript-steps'
import { ElicitationCard, PlanBlock } from '@/components/console/TranscriptCards'
import { CopyTurnButton, MessageMenu } from '@/components/console/MessageMenu'

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
  // A schedule sits on the header chip's light tile, not the dark plate an agent's fallback avatar uses.
  const tile = !agent && isCron ? 'imark' : 'av'
  const boxClass = `${tile} flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md font-sans text-[9.5px] font-semibold leading-normal ${
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
  // Only a message known to be the reader's own sits on the right, as a chat app draws it; everyone else's is on the left.
  const mine = turn.self === true
  const avatar = (
    <ParticipantAvatar
      agent={turn.agent}
      {...(turn.agent ? { href: orgPath(`/agents/${encodeURIComponent(turn.agent.id)}`) } : {})}
      avatarUrl={turn.avatarUrl}
      avatarInitials={turn.avatarInitials}
      platformMark={platformMark}
      sp={turn.sp}
      isCron={turn.isCron}
    />
  )
  return (
    <div className={`group/turn flex items-start gap-[9px] ${mine ? 'justify-end' : 'justify-start'}`}>
      {mine ? null : avatar}
      <ThreadRootPress
        enabled={pressToReply && onReply !== undefined}
        onReply={() => onReply?.()}
        className={`relative flex min-w-0 max-w-[86%] flex-col gap-[3px] ${mine ? 'items-end' : 'items-start'}`}
      >
        <span
          className={`flex items-center gap-[6px] font-sans ${mine ? 'pr-1' : 'pl-1'} text-[11px] font-medium leading-normal text-(--text-tertiary)`}
        >
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
            className={`flex items-center gap-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) ${mine ? 'pr-1' : 'pl-1'}`}
            title={turn.steered ? 'Steered into the running reply' : 'Steering into the running reply…'}
          >
            {turn.steered ? <Icon name="corner-down-right" size={11} /> : <Spinner size={10} />}
            {turn.steered ? 'Steered' : 'Steering…'}
          </span>
        )}
        {/* A message wraps its cards on its own side so none hides off-screen; the composer keeps one scrolling row. */}
        <AttachmentCards
          className={`mb-[3px] flex-wrap ${mine ? 'justify-end' : 'justify-start'}`}
          cards={messageCards(turn.images, turn.files)}
        />
        {(turn.text || turn.body) && (
          <div className="relative max-w-full">
            <div className={mine ? SELF_BUBBLE : DELIVERED_BUBBLE}>
              {turn.body?.sessionMessage && <SessionMessageCaption facts={turn.body.sessionMessage} />}
              {turn.body ? (
                <UserTurnDetails body={turn.body} platform={turn.platform}>
                  {turn.text ? <MessageText text={turn.text} platform={turn.platform} /> : null}
                </UserTurnDetails>
              ) : (
                turn.text && <MessageText text={turn.text} platform={turn.platform} />
              )}
            </div>
            {/* Its hover menu on the bubble's top edge at the side facing the timeline: left for a message on the right, right for one on the left. */}
            <MessageMenu
              text={turn.text}
              onReply={onReply}
              onShare={onShare}
              className={mine ? 'left-[8px] bottom-full -mb-[6px]' : 'right-[8px] bottom-full -mb-[6px]'}
            />
          </div>
        )}
        {footer}
        {/* A message of attachments alone has no bubble: its menu sits on the column's top edge instead. */}
        {turn.text || turn.body ? null : (
          <MessageMenu onReply={onReply} onShare={onShare} className={mine ? 'top-0 left-0' : 'top-0 right-0'} />
        )}
      </ThreadRootPress>
      {mine ? avatar : null}
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
        s.lane !== CAPABILITY_LANE &&
        s.lane !== FILL_LANE
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

/** A message delivered into the agent's session, set apart from what the agent said itself and folded to its first lines. */
function DeliveredMessage({ facts, children }: { facts: SessionMessageTurnFacts; children: ReactNode }) {
  return (
    <div data-delivered-message="" className={DELIVERED_BUBBLE}>
      <UserTurnDetails body={{ sessionMessage: facts }}>{children}</UserTurnDetails>
    </div>
  )
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
  rootFooter,
  answerElicitation,
  appRpc,
  appReport,
  closeApp,
  answerFill,
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
  /** The thread under the agent's own post at the root: its task's card inside the bubble, its replies line under it; null where it has none. */
  rootFooter?: (rootId: string, part: 'line' | 'card') => ReactNode
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
  /** Answers a Fill card over the live socket; absent ⇒ the card renders as a record. */
  answerFill?:
    | ((
        agentId: string | undefined,
        requestId: string,
        answer: FillCardAnswer
      ) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined
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
  const textSteps = saidSteps.filter(
    (s) => s.lane !== ELICIT_LANE && s.lane !== APP_LANE && s.lane !== CAPABILITY_LANE && s.lane !== FILL_LANE
  )
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
  // What the turn said fills one bubble; a post at a thread's root closes its bubble with the task's card, its replies line under it.
  const bubbles: { key: string; items: ReactNode[]; after?: ReactNode }[] = []
  let items: ReactNode[] = []
  saidSteps.forEach((st, si) => {
    items.push(
      <SaidStep
        key={`s:${si}`}
        st={st}
        si={si}
        turn={turn}
        sessionId={sessionId}
        taskLink={taskLinks[si] ?? null}
        taskFooter={taskFooter}
        answerElicitation={answerElicitation}
        appRpc={appRpc}
        appReport={appReport}
        closeApp={closeApp}
        answerFill={answerFill}
      />
    )
    const prose =
      st.lane !== APP_LANE &&
      !(st.lane === CAPABILITY_LANE && st.capability) &&
      !(st.lane === FILL_LANE && st.fill) &&
      st.lane !== ELICIT_LANE &&
      !(taskLinks[si] && turn.agentId && taskFooter)
    if (!prose || !st.rootId || !rootFooter) return
    const card = rootFooter(st.rootId, 'card')
    if (card) items.push(<Fragment key={`k:${si}`}>{card}</Fragment>)
    bubbles.push({ key: `b:${si}`, items, after: rootFooter(st.rootId, 'line') })
    items = []
  })
  // Tasks opened for the messages this turn answers sit at the bottom of its last bubble.
  if (taskFooter)
    for (const link of openedTasks ?? [])
      if (!taskLinks.some((shown) => shown?.sessionId === link.sessionId))
        items.push(<div key={`o:${link.sessionId}`}>{taskFooter(link, true)}</div>)
  if (items.length > 0) bubbles.push({ key: 'b:end', items })
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
          {...(turnAgent ? { href: orgPath(`/agents/${encodeURIComponent(turnAgent.id)}`) } : {})}
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
          {bubbles.map((bubble) => (
            <Fragment key={bubble.key}>
              <div className={AGENT_BUBBLE} data-agent-bubble="">
                {bubble.items}
              </div>
              {bubble.after}
            </Fragment>
          ))}
          {trail}
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

/** One said step as its block in the bubble: a card where it is one, else its prose. */
function SaidStep({
  st,
  si,
  turn,
  sessionId,
  taskLink,
  taskFooter,
  answerElicitation,
  appRpc,
  appReport,
  closeApp,
  answerFill
}: {
  st: FmtStep
  si: number
  turn: BotTurn
  sessionId: string | undefined
  taskLink: TaskLink | null
  taskFooter: ((link: TaskLink, opened: boolean) => ReactNode) | undefined
  answerElicitation: Parameters<typeof BotTurnView>[0]['answerElicitation']
  appRpc: Parameters<typeof BotTurnView>[0]['appRpc']
  appReport: Parameters<typeof BotTurnView>[0]['appReport']
  closeApp: Parameters<typeof BotTurnView>[0]['closeApp']
  answerFill: Parameters<typeof BotTurnView>[0]['answerFill']
}) {
  return st.lane === APP_LANE ? (
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
  ) : st.lane === FILL_LANE && st.fill ? (
    <div key={`f:${st.fill.requestId}`}>
      <FillCard
        body={st.fill}
        {...(answerFill ? { onAnswer: (answer) => answerFill(turn.agentId, st.fill!.requestId, answer) } : {})}
      />
    </div>
  ) : st.lane === ELICIT_LANE ? (
    <div key={`e:${st.elicit?.requestId ?? si}`}>
      <ElicitationCard
        step={st}
        {...(answerElicitation
          ? {
              onAnswer: (value: ElicitAnswerValue) => answerElicitation(turn.agentId, st.elicit?.requestId, value)
            }
          : {})}
      />
    </div>
  ) : taskLink && turn.agentId && taskFooter ? (
    <div key={`t:${si}`}>{taskFooter(taskLink, false)}</div>
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
          {st.sessionMessage && st.text && (
            <DeliveredMessage facts={st.sessionMessage}>
              <div className="whitespace-pre-wrap">
                <MessageText text={st.text} platform={st.platform} />
              </div>
            </DeliveredMessage>
          )}
          {st.image && (
            <img
              src={`data:${st.image.mimeType};base64,${st.image.data}`}
              alt={st.image.name}
              className={`max-h-[360px] max-w-full rounded-md object-contain ${st.text ? 'mb-[10px]' : ''}`}
            />
          )}
          {st.text && !st.sessionMessage && (
            <div className="whitespace-pre-wrap">
              <MessageText text={st.text} platform={st.platform} />
            </div>
          )}
          {st.file && (
            <div className={st.text ? 'mt-2' : ''}>
              <SharedFileChip file={st.file} agentId={turn.agentId} sessionId={st.toolSessionId ?? sessionId} />
            </div>
          )}
          {st.sessionMessage && !st.text && <UserTurnDetails body={{ sessionMessage: st.sessionMessage }} />}
        </>
      )}
      <StepExtras step={st} sessionId={sessionId} />
    </div>
  )
}
