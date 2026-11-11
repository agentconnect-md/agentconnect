'use client'

// How a transcript row or a live step becomes a lane-styled step, shared by the session page and a task's thread.
import { fileColor, lane, type SessionImage, type SessionStep } from '@/lib/data'
import { type SessionMessageDto } from '@/lib/api'
import type { SharedImageState } from '@/lib/shared-image'
import { parseUserTurnBody } from '@/lib/user-turn-body'
import type { SessionMessageTurnFacts } from '@agentconnect.md/protocol'
import { formatTranscriptRowTime, transcriptRowTimeMs } from '@/lib/transcript-time'
import { sharedFileMarker, type SharedFile } from '@/lib/shared-file'
import {
  elicitCard,
  capabilityCard,
  CAPABILITY_LANE,
  FILL_LANE,
  fillCardBody,
  mcpAppCard,
  APP_LANE,
  ELICIT_LANE,
  PLAN_LANE,
  planEntries,
  stripBoldMarks,
  type PlanEntry
} from '@/components/console/session-work'
import { taskLinkOfBody, type TaskLink } from '@/components/console/task-link'

// One agent-turn step from a real transcript row, dated by the row's own time.
export function msgStep(m: SessionMessageDto, toolSessionId?: string, platform?: string): FmtStep {
  const step = msgStepBody(m, toolSessionId, platform)
  const timeMs = transcriptRowTimeMs(m)
  return timeMs === null ? step : { ...step, timeMs }
}

// Maps the daemon transcript kind (text | tool | reasoning | plan | elicit | app | capability) onto the lane styling.
export function msgStepBody(m: SessionMessageDto, toolSessionId?: string, platform?: string): FmtStep {
  const k = (m.kind || 'text').toLowerCase()
  // A recorded question or MCP App card renders through the same component as a live one, inert; an unreadable body falls back to text.
  if (k === 'app') {
    const card = mcpAppCard(m.body)
    if (card)
      return {
        lane: APP_LANE,
        laneColor: 'var(--text-tertiary)',
        dot: 'var(--text-disabled)',
        weight: 400,
        textColor: 'var(--text-primary)',
        codeColor: 'var(--text-secondary)',
        text: m.text,
        code: '',
        files: [],
        app: card,
        time: formatTranscriptRowTime(m),
        ...(platform ? { platform } : {}),
        // A transcript page strips the template, so a truncated row carries the coordinates the card reads it back through.
        ...(m.bodyTruncated ? { msg: m, ...(toolSessionId ? { toolSessionId } : {}) } : {})
      }
  }
  if (k === 'capability') {
    const card = capabilityCard(m.body)
    if (card)
      return {
        lane: CAPABILITY_LANE,
        laneColor: 'var(--text-tertiary)',
        dot: 'var(--text-disabled)',
        weight: 400,
        textColor: 'var(--text-primary)',
        codeColor: 'var(--text-secondary)',
        text: m.text,
        code: '',
        files: [],
        capability: card,
        time: formatTranscriptRowTime(m),
        ...(platform ? { platform } : {})
      }
  }
  if (k === 'fill') {
    const card = fillCardBody(m.body)
    if (card)
      return {
        lane: FILL_LANE,
        laneColor: 'var(--text-tertiary)',
        dot: 'var(--text-disabled)',
        weight: 400,
        textColor: 'var(--text-primary)',
        codeColor: 'var(--text-secondary)',
        text: m.text,
        code: '',
        files: [],
        fill: card,
        time: formatTranscriptRowTime(m),
        ...(platform ? { platform } : {})
      }
  }
  if (k === 'elicit') {
    const card = elicitCard(m.body)
    if (card)
      return {
        lane: ELICIT_LANE,
        laneColor: 'var(--text-tertiary)',
        dot: 'var(--text-disabled)',
        weight: 400,
        textColor: 'var(--text-primary)',
        codeColor: 'var(--text-secondary)',
        text: m.text,
        code: '',
        files: [],
        elicit: card,
        time: formatTranscriptRowTime(m),
        ...(platform ? { platform } : {})
      }
  }
  if (k === 'plan') {
    return {
      lane: PLAN_LANE,
      laneColor: 'var(--text-tertiary)',
      dot: 'var(--text-disabled)',
      weight: 400,
      textColor: 'var(--text-secondary)',
      codeColor: 'var(--text-secondary)',
      text: m.text,
      code: '',
      files: [],
      plan: planEntries(m.body),
      time: formatTranscriptRowTime(m),
      ...(platform ? { platform } : {})
    }
  }
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
      // The raw row lets the step render its captured tool body on demand.
      ...(m.body ? { msg: m, ...(toolSessionId ? { toolSessionId } : {}) } : {})
    }
  }
  if (k === 'reasoning') {
    return {
      lane: 'THINK',
      laneColor: 'var(--brand)',
      // Purple, not brand magenta — a magenta dot reads as an error marker.
      dot: 'var(--purple-500)',
      weight: 500,
      textColor: 'var(--text-tertiary)',
      codeColor: 'var(--text-secondary)',
      // De-bolded: runtimes write thought headings as `**heading**`, which read as a slab of bold.
      text: stripBoldMarks(m.text),
      code: '',
      files: [],
      time: formatTranscriptRowTime(m),
      ...(platform ? { platform } : {})
    }
  }
  const shared = k === 'text' ? sharedFileMarker(m.text) : null
  // A delivered session message shows its body; its header facts and the agent's guidance fold beneath it.
  const sessionMessage = k === 'text' ? parseUserTurnBody(m.body)?.sessionMessage : undefined
  const taskLink = k === 'text' ? taskLinkOfBody(m.body) : null
  return {
    lane: '',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 400,
    textColor: 'var(--text-primary)',
    codeColor: 'var(--text-secondary)',
    text: shared ? shared.caption : m.text,
    code: '',
    files: [],
    time: formatTranscriptRowTime(m),
    ...(platform ? { platform } : {}),
    // The download names the session that shared the file, which in a merged conversation is the row's source.
    ...(shared ? { file: shared.file, ...(toolSessionId ? { toolSessionId } : {}) } : {}),
    ...(sessionMessage ? { sessionMessage } : {}),
    ...(taskLink ? { taskLink } : {}),
    ...(k === 'text' && m.sharedImage
      ? {
          sharedImage: m.sharedImage,
          ...(m.postId ? { postId: m.postId } : {}),
          ...(toolSessionId ? { toolSessionId } : {})
        }
      : {})
  }
}

export interface FmtStep {
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
  // Epoch ms of the row or live event, which dates the turn's approximate duration.
  timeMs?: number
  // The turn's task list: only on a PLAN_LANE step, empty when the row had no readable body.
  plan?: PlanEntry[]
  // The agent's in-band question — present only on an ELICIT_LANE step.
  elicit?: NonNullable<SessionStep['elicit']>
  // A capability request card — present only on a CAPABILITY_LANE step.
  capability?: NonNullable<SessionStep['capability']>
  // A Fill card — present only on a FILL_LANE step.
  fill?: NonNullable<SessionStep['fill']>
  app?: NonNullable<SessionStep['app']>
  // A superseded answer collapsed into this lane — carried so the summary can skip it.
  demoted?: boolean
  // A peer participant's message attachment (rendered like the user bubble's).
  image?: SessionImage
  // A file the agent shared, parsed off the row's trailing marker and rendered as a download chip.
  file?: SharedFile
  // A shared image card (webchat-generated-images.md) and the canonical post that names it.
  sharedImage?: SharedImageState
  postId?: string
  // A peer participant's copy: its original resolves only through the author's own session, which this row does not name.
  peerCopy?: boolean
  // The facts of a delivered session message (an agent call, reply, or a task's input or report), folded under its body.
  sessionMessage?: SessionMessageTurnFacts
  // A coordinator's post that links to a task, drawn as the task's card.
  taskLink?: TaskLink
  // A coordinator's replyToMessage call, drawn in the main timeline as one line opening the thread it answered in (webchat-threads.md §6.1).
  answeredIn?: string
  // The thread a coordinator's row belongs to (its root), whose panel draws it instead of the main timeline.
  thread?: string
  // The agent's own post at the conversation's root, named as the thread it may hold.
  rootId?: string
  // Present only on real-transcript tool rows that carry a captured body.
  msg?: SessionMessageDto
  // A conversation row's owning session, so a full-body read never targets the representative member.
  toolSessionId?: string
  // The platform this row was written on, which picks `MessageText`'s renderer per step (§10).
  platform?: string
}

// A bare text step with no lane chrome: a peer participant's message inside its agent block.
export function plainStep(text: string, time?: string, image?: SessionImage, platform?: string): FmtStep {
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

// A daemon background-task wake (`background-task:<id>`) is agent machinery, never a person's bubble.
export function isBgTaskWake(sender: string | undefined | null): boolean {
  return !!sender?.startsWith('background-task:')
}

// A THINK-lane row from bare text: a background-task wake inside the owner agent's turn.
export function thinkStep(text: string, time?: string, platform?: string): FmtStep {
  return {
    lane: 'THINK',
    laneColor: 'var(--brand)',
    dot: 'var(--purple-500)',
    weight: 500,
    textColor: 'var(--text-tertiary)',
    codeColor: 'var(--text-secondary)',
    text: stripBoldMarks(text),
    code: '',
    files: [],
    ...(time ? { time } : {}),
    ...(platform ? { platform } : {})
  }
}

export function fmtStep(stp: SessionStep, platform?: string): FmtStep {
  const L = lane(stp.kind)
  return {
    lane: L.lane,
    laneColor: L.laneColor,
    dot: L.dot,
    weight: L.weight,
    textColor: L.textColor,
    codeColor: L.codeColor,
    // Live reasoning de-bolds as saved THINK rows do; a demoted answer keeps its emphasis.
    text: stp.kind === 'plan' && !stp.demoted ? stripBoldMarks(stp.text) : stp.text,
    code: stp.code ?? '',
    files: (stp.files ?? []).map((f) => ({ tag: f.tag, path: f.path, color: fileColor(f.tag) })),
    time: stp.time ?? '',
    ...(stp.observedAtMs !== undefined && Number.isFinite(stp.observedAtMs) ? { timeMs: stp.observedAtMs } : {}),
    ...(stp.kind === 'planblock' ? { plan: stp.plan ?? [] } : {}),
    ...(stp.kind === 'elicit' && stp.elicit ? { elicit: stp.elicit } : {}),
    ...(stp.kind === 'capability' && stp.capability ? { capability: stp.capability } : {}),
    ...(stp.kind === 'fill' && stp.fill ? { fill: stp.fill } : {}),
    ...(stp.kind === 'app' && stp.app ? { app: stp.app } : {}),
    ...(stp.demoted ? { demoted: true } : {}),
    ...(stp.taskLink ? { taskLink: stp.taskLink } : {}),
    ...(platform ? { platform } : {}),
    ...(stp.sharedImage ? sharedImageFields(stp) : stp.kind === 'done' ? sharedFileFields(stp) : {}),
    // The live frame carries no body, so attach enough of a row for ToolBodyDetail to fetch the full one on open.
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
          // A member participant's call lives in its own daemon session, which StepExtras must target.
          ...(stp.toolSessionId ? { toolSessionId: stp.toolSessionId } : {})
        }
      : {})
  }
}

/** A row's send time as an optional field. */
export function timeMsField(ms: number | null): { timeMs?: number } {
  return ms === null ? {} : { timeMs: ms }
}

// A live image step's card fields: its caption and file come off the same trailing share marker a history row carries.
export function sharedImageFields(stp: SessionStep): Partial<FmtStep> {
  const shared = sharedFileMarker(stp.text)
  return {
    sharedImage: stp.sharedImage!,
    text: shared ? shared.caption : stp.text,
    ...(shared ? { file: shared.file } : {}),
    ...(stp.postId ? { postId: stp.postId } : {}),
    ...(stp.toolSessionId ? { toolSessionId: stp.toolSessionId } : {})
  }
}

// A live shared-file step (a document shareFile posted as its own message): the chip's file comes off the marker, like a history row's.
export function sharedFileFields(stp: SessionStep): Partial<FmtStep> {
  const shared = sharedFileMarker(stp.text)
  if (!shared) return {}
  return {
    text: shared.caption,
    file: shared.file,
    ...(stp.postId ? { postId: stp.postId } : {}),
    ...(stp.toolSessionId ? { toolSessionId: stp.toolSessionId } : {})
  }
}
