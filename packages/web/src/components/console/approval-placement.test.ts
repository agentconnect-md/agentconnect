import { describe, expect, it } from 'vitest'
import type { AgentPermissionRequestDto } from '@/lib/api'
import {
  approvalCommandText,
  askedApprovalIds,
  APPROVAL_TURN_SLACK_MS,
  approvalAnswerPlace,
  approvalTurnKey,
  approvalTurnStart,
  placedApprovalIds,
  placeTranscriptApprovals,
  type ApprovalTurnAnchor
} from './approval-placement'

const at = (iso: string) => Date.parse(iso)

const request = (extra: Partial<AgentPermissionRequestDto> = {}): AgentPermissionRequestDto => ({
  id: 'request-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  createdAt: '2026-01-01T10:05:00.000Z',
  requesterId: null,
  requesterName: null,
  command: 'Bash: git push',
  status: 'pending',
  resolvedAt: null,
  ...extra
})

const turns: ApprovalTurnAnchor[] = [
  { key: 'b:1', agentId: 'agent-1', startMs: at('2026-01-01T10:00:00.000Z') },
  { key: 'b:2', agentId: 'agent-1', startMs: at('2026-01-01T10:04:00.000Z') },
  { key: 'b:3', agentId: 'agent-1', startMs: at('2026-01-01T10:10:00.000Z') }
]

describe('the turn a request was asked in', () => {
  it('is the last turn started by the time it was asked', () => {
    expect(approvalTurnKey(turns, request({ status: 'allowed' }))).toBe('b:2')
    expect(approvalTurnKey(turns, request({ createdAt: '2026-01-01T10:12:00.000Z', status: 'denied' }))).toBe('b:3')
  })

  it('tolerates a live turn that seems to start just after what it asked', () => {
    const asked = turns[2]!.startMs! - APPROVAL_TURN_SLACK_MS + 1
    expect(approvalTurnKey(turns, request({ createdAt: new Date(asked).toISOString(), status: 'allowed' }))).toBe('b:3')
  })

  it('puts a waiting request at the running turn, whatever its times say', () => {
    expect(approvalTurnKey(turns, request({ createdAt: '2026-01-01T09:00:00.000Z' }))).toBe('b:3')
    expect(approvalTurnKey(turns, request())).toBe('b:3')
  })

  it('keeps a waiting request out of a turn a newer message closed, so the strip shows it', () => {
    const closed = turns.map((turn) => ({ ...turn, closed: true }))
    expect(approvalTurnKey(closed, request())).toBeNull()
    expect(approvalTurnKey(closed, request({ status: 'allowed' }))).toBe('b:2')
  })

  it('falls back to the last turn when no turn carries a time', () => {
    expect(
      approvalTurnKey(
        turns.map((turn) => ({ ...turn, startMs: null })),
        request({ status: 'allowed' })
      )
    ).toBe('b:3')
  })

  it('leaves a settled request older than every loaded turn out of the transcript', () => {
    expect(approvalTurnKey(turns, request({ createdAt: '2026-01-01T09:00:00.000Z', status: 'expired' }))).toBeNull()
  })

  it('reads only the asking agent’s turns, and has none to give without them', () => {
    const shared = [...turns, { key: 'b:peer', agentId: 'agent-2', startMs: at('2026-01-01T10:20:00.000Z') }]
    expect(approvalTurnKey(shared, request({ createdAt: '2026-01-01T10:21:00.000Z' }))).toBe('b:3')
    expect(approvalTurnKey([], request())).toBeNull()
  })

  it('takes a turn’s start from its earliest timed step', () => {
    expect(approvalTurnStart([undefined, 30, 10, 20])).toBe(10)
    expect(approvalTurnStart([undefined])).toBeNull()
  })
})

describe('the transcript’s approvals', () => {
  it('places this conversation’s tool calls only, oldest first per turn', () => {
    const rows = [
      request({ id: 'later', createdAt: '2026-01-01T10:06:00.000Z' }),
      request({ id: 'earlier', status: 'allowed' }),
      request({ id: 'join', kind: 'join' }),
      request({ id: 'task', sessionId: 'task-1', parentSessionId: 'session-1' }),
      request({ id: 'other', sessionId: 'session-2' })
    ]
    const placed = placeTranscriptApprovals(turns, rows, 'session-1')
    expect([...placed.keys()]).toEqual(['b:3', 'b:2'])
    expect(placed.get('b:2')?.map((row) => row.id)).toEqual(['earlier'])
    expect(placed.get('b:3')?.map((row) => row.id)).toEqual(['later'])
    expect(placedApprovalIds(turns, rows, 'session-1')).toEqual(new Set(['earlier', 'later']))
  })
})

describe('where a settled request was answered', () => {
  it('names the console and a chat platform, and nothing it cannot tell', () => {
    expect(approvalAnswerPlace('user:user-1')).toEqual({ kind: 'here' })
    expect(approvalAnswerPlace('slack:T1:U1')).toEqual({ kind: 'platform', name: 'Slack' })
    expect(approvalAnswerPlace('telegram:42')).toEqual({ kind: 'platform', name: 'Telegram' })
    expect(approvalAnswerPlace('feishu:ou_1')).toEqual({ kind: 'platform', name: 'Lark' })
    expect(approvalAnswerPlace('robot:1')).toBeNull()
    expect(approvalAnswerPlace('user')).toBeNull()
    expect(approvalAnswerPlace(null)).toBeNull()
    expect(approvalAnswerPlace(undefined)).toBeNull()
  })
})

describe('askedApprovalIds', () => {
  it('names the requests a live turn already shows as its own confirmation card', () => {
    const steps = [
      { elicit: { requestId: 'tool:turn-1:req-1' } },
      { elicit: { requestId: 'question-7' } },
      {},
      { elicit: { requestId: 'tool:turn-1:req-2' } }
    ]
    expect([...askedApprovalIds(steps)]).toEqual(['req-1', 'req-2'])
  })
})

describe('approvalCommandText', () => {
  it('names a command once when the record repeats it as title and detail', () => {
    expect(approvalCommandText('ls /missing: ls /missing')).toBe('ls /missing')
    expect(approvalCommandText('Bash: rm -rf /tmp/x')).toBe('Bash: rm -rf /tmp/x')
    expect(approvalCommandText('echo a: b')).toBe('echo a: b')
    expect(approvalCommandText('')).toBe('')
  })
})
