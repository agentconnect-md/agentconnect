import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from '@/lib/api'
import type { SessionStep } from '@/lib/data'
import { WEBCHAT_THREAD_SHAPE } from './coordinator-threads'
import { buildTurns, type BuildTurnsInput } from './session-turns'

const AGENT = 'agent_1'

const row = (seq: number, sender: string, text: string, extra: Partial<SessionMessageDto> = {}): SessionMessageDto => ({
  seq,
  sender,
  ts: new Date(Date.UTC(2026, 10, 3, 9, seq)).toISOString(),
  kind: 'text',
  text,
  ...extra
})

const input = (over: Partial<BuildTurnsInput> = {}): BuildTurnsInput => ({
  session: {
    id: 'ses_1',
    agentId: AGENT,
    agentName: 'Builder',
    model: 'm',
    platform: 'webchat',
    user: 'u',
    time: '',
    steps: []
  },
  rows: [],
  liveSteps: [],
  source: { session: new WeakMap(), turn: new WeakMap(), platform: new WeakMap(), agent: new WeakMap() },
  threadsView: false,
  threadShape: undefined,
  agentById: new Map(),
  asCron: () => null,
  participantAgent: () => undefined,
  isSelf: (sender) => sender === 'me',
  senderLabel: (sender, fallback) => fallback ?? sender ?? '',
  ownsDecisionSeq: (m) => m.sender !== AGENT,
  viewer: { initials: 'ME' },
  pictureOf: () => undefined,
  sourceLabel: 'Webchat',
  ...over
})

const shape = (turns: ReturnType<typeof buildTurns>['turns']) =>
  turns.map((t) => (t.kind === 'user' ? ['user', t.key, t.text] : ['bot', t.key, t.steps.length, t.inThread ?? null]))

describe('buildTurns', () => {
  it('draws each person’s message as its own turn and an agent’s consecutive rows as one', () => {
    const { turns, speakers } = buildTurns(
      input({
        rows: [
          row(1, 'me', 'fix the build'),
          row(2, AGENT, 'gh run list', { kind: 'tool' }),
          row(3, AGENT, 'Fixed.'),
          row(4, 'user_dana', 'thanks')
        ]
      })
    )
    expect(shape(turns)).toEqual([
      ['user', 'u:ses_1#1', 'fix the build'],
      ['bot', 'b:ses_1#2', 2, null],
      ['user', 'u:ses_1#4', 'thanks']
    ])
    expect(turns[0]).toMatchObject({ sp: { handle: '@you' }, avatarInitials: 'ME', seq: 1, sourceLabel: 'Webchat' })
    expect([...speakers.keys()]).toEqual(['me', 'user_dana'])
  })

  it('binds the run after a background-task wake to the wake’s block and keeps its key', () => {
    const { turns } = buildTurns(
      input({ rows: [row(1, 'background-task:job_1', 'job finished'), row(2, AGENT, 'The job passed.')] })
    )
    expect(shape(turns)).toEqual([['bot', 'b:ses_1#1', 2, null]])
    expect(turns[0]).toMatchObject({ kind: 'bot', wake: false })
  })

  it('drops a recorded question while its live copy stands', () => {
    const ask = { requestId: 'q1', options: [{ value: 'yes', label: 'Yes' }] }
    const live: SessionStep[] = [{ kind: 'elicit', turnId: 't1', text: 'Ship it?', elicit: ask }]
    const { turns } = buildTurns(
      input({
        rows: [row(1, AGENT, 'Ship it?', { kind: 'elicit', body: JSON.stringify(ask) })],
        liveSteps: live
      })
    )
    expect(shape(turns)).toEqual([['bot', 'b:live:t1:', 1, null]])
  })

  it('leaves a thread’s message out of the roots view and labels the coordinator turn answering it', () => {
    const { turns } = buildTurns(
      input({
        rows: [
          row(1, 'me', 'root', { postId: 'p1' }),
          row(2, 'me', 'in thread', { thread: 'p1' }),
          row(3, AGENT, 'ok')
        ],
        threadsView: true,
        threadShape: WEBCHAT_THREAD_SHAPE
      })
    )
    expect(shape(turns)).toEqual([
      ['user', 'u:ses_1#1', 'root'],
      ['bot', 'b:ses_1#3', 1, 'p1']
    ])
  })

  it('builds from the session’s own steps when there are no rows', () => {
    const steps: SessionStep[] = [
      { kind: 'msg', turnId: 't1', who: 'me', text: 'hi', time: '9:00' },
      { kind: 'done', turnId: 't1', agentId: AGENT, text: 'hello' }
    ]
    const { turns } = buildTurns(input({ rows: undefined, session: { ...input().session, steps, time: '9:00' } }))
    expect(shape(turns)).toEqual([
      ['user', 'u:live:t1', 'hi'],
      ['bot', `b:live:t1:${AGENT}`, 1, null]
    ])
  })
})
