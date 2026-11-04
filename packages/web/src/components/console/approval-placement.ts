// Where a conversation's tool-call approvals sit in its transcript, and where a settled one was answered.
import type { AgentPermissionRequestDto } from '@/lib/api'
import { platformLabel } from '@/lib/platform-labels'

/** An agent turn as placement reads it: its identity, its agent, its earliest step time, and whether a later message opened a new exchange. */
export interface ApprovalTurnAnchor {
  key: string
  agentId?: string
  startMs: number | null
  /** A user message (not a steer) follows it, so a request still waiting cannot be this turn's. */
  closed?: boolean
}

/** Live steps carry the browser's clock and requests the daemon's, so a turn may seem to start just after what it asked. */
export const APPROVAL_TURN_SLACK_MS = 5_000

/** A tool call's permission request of this conversation itself; join confirmations and its tasks' requests stay in the strip. */
export function isTranscriptApproval(request: AgentPermissionRequestDto, sessionId: string): boolean {
  return request.kind !== 'join' && request.sessionId === sessionId
}

/** The earliest of a turn's step times, or null when none carries one. */
export function approvalTurnStart(times: readonly (number | undefined)[]): number | null {
  let start: number | null = null
  for (const ms of times) if (ms !== undefined && Number.isFinite(ms) && (start === null || ms < start)) start = ms
  return start
}

/** The turn that asked the request: a waiting one is the agent's running turn, a settled one its last turn started by then. */
export function approvalTurnKey(
  turns: readonly ApprovalTurnAnchor[],
  request: AgentPermissionRequestDto
): string | null {
  const own = turns.filter((turn) => !turn.agentId || turn.agentId === request.agentId)
  const last = own[own.length - 1]
  if (!last) return null
  // A waiting request is the running turn's; one whose turn has not rendered yet stays in the strip.
  if (request.status === 'pending') return last.closed ? null : last.key
  const askedMs = Date.parse(request.createdAt)
  const timed = own.filter((turn) => turn.startMs !== null)
  if (Number.isNaN(askedMs) || timed.length === 0) return last.key
  const started = timed.filter((turn) => turn.startMs! <= askedMs + APPROVAL_TURN_SLACK_MS)
  // A settled request older than every loaded turn belongs to history not shown yet.
  return started[started.length - 1]?.key ?? null
}

/** This conversation's tool-call approvals by the turn that asked them, oldest first. */
export function placeTranscriptApprovals(
  turns: readonly ApprovalTurnAnchor[],
  requests: readonly AgentPermissionRequestDto[],
  sessionId: string
): Map<string, AgentPermissionRequestDto[]> {
  const byTurn = new Map<string, AgentPermissionRequestDto[]>()
  for (const request of requests) {
    if (!isTranscriptApproval(request, sessionId)) continue
    const key = approvalTurnKey(turns, request)
    if (key === null) continue
    const list = byTurn.get(key)
    if (list) list.push(request)
    else byTurn.set(key, [request])
  }
  for (const list of byTurn.values()) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return byTurn
}

/** The ids of the requests the transcript shows at a turn. */
export function placedApprovalIds(
  turns: readonly ApprovalTurnAnchor[],
  requests: readonly AgentPermissionRequestDto[],
  sessionId: string
): Set<string> {
  return new Set([...placeTranscriptApprovals(turns, requests, sessionId).values()].flat().map((r) => r.id))
}

/** Where a settled request was answered: `user:` is the console, a chat platform's id prefix is that platform. */
export type ApprovalAnswerPlace = { kind: 'here' } | { kind: 'platform'; name: string }

export function approvalAnswerPlace(resolvedBy: string | null | undefined): ApprovalAnswerPlace | null {
  const prefix = resolvedBy?.split(':', 1)[0]
  if (!prefix || prefix === resolvedBy) return null
  if (prefix === 'user') return { kind: 'here' }
  const label = platformLabel(prefix)
  return label ? { kind: 'platform', name: label.name } : null
}

/** Permission requests a live turn already draws as its own confirmation card (`tool:<turn>:<request>`). */
export function askedApprovalIds(steps: readonly { elicit?: { requestId?: string } | undefined }[]): Set<string> {
  const ids = new Set<string>()
  for (const step of steps) {
    const requestId = step.elicit?.requestId
    if (requestId?.startsWith('tool:')) ids.add(requestId.slice(requestId.lastIndexOf(':') + 1))
  }
  return ids
}

/** A request's command as shown: a record whose title and detail match ("ls x: ls x") names it once. */
export function approvalCommandText(command: string): string {
  const half = (command.length - 2) / 2
  if (Number.isInteger(half) && half > 0 && command.slice(half, half + 2) === ': ') {
    const head = command.slice(0, half)
    if (head === command.slice(half + 2)) return head
  }
  return command
}
