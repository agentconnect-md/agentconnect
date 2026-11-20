import { describe, expect, it } from 'vitest'
import type { MeDto, MemberDto, SessionMessageDto } from '@/lib/api'
import type { Agent, SessionStep } from '@/lib/data'
import { WEBCHAT_THREAD_SHAPE } from './coordinator-threads'
import { senderPeople } from './sender-people'
import { buildTurns, type BuildTurnsInput } from './session-turns'

const AGENT = 'agent_1'
const MEMBER: MemberDto = {
  userId: '',
  email: null,
  name: null,
  picture: null,
  role: 'collaborator',
  isCurrentUser: false,
  joinedAt: '2026-01-01T00:00:00Z'
}
const ME_PICTURE = 'https://avatars.example.test/me.png'
const DANA_PICTURE = 'https://avatars.example.test/dana.png'

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

  it('reads a sender by who the organization knows them as: the reader, a member, or the agent a bot speaks for', () => {
    const peer = { id: 'agent_2', name: 'Reviewer' } as Agent
    const { turns, speakers } = buildTurns(
      input({
        session: { ...input().session, platform: 'slack' },
        agentById: new Map([[peer.id, peer]]),
        participantAgent: (sender) => (sender === peer.id ? peer : undefined),
        senderLabel: (sender, fallback) => (sender === 'user_dana' ? 'Dana Reyes' : (fallback ?? sender ?? '')),
        viewer: { initials: 'ME', picture: 'https://avatars.example/me.png' },
        pictureOf: (sender) => (sender === 'user_dana' ? 'https://avatars.example/dana.png' : undefined),
        rows: [
          row(1, 'me', 'from the console'),
          row(2, 'U0ME', 'from Slack', { senderName: 'Morgan', senderUserId: 'me' }),
          row(3, 'U0DANA', 'me too', { senderName: 'dana.r', senderUserId: 'user_dana' }),
          row(4, 'U0BOT', 'Reviewed.', { senderName: 'reviewer-bot', senderAgentId: 'agent_2' }),
          row(5, 'U0STRANGER', 'hello', { senderName: 'Sam' })
        ]
      })
    )
    // The reader's own turns sit on their side whichever account wrote them; the linked one says which.
    expect(turns[0]).toMatchObject({ self: true, sp: { name: 'You' } })
    expect(turns[1]).toMatchObject({
      self: true,
      sp: { name: 'You (Slack)' },
      avatarUrl: 'https://avatars.example/me.png'
    })
    // A member reads by their console name and photo; a stranger by what the platform called them.
    expect(turns[2]).toMatchObject({ sp: { name: 'Dana Reyes' }, avatarUrl: 'https://avatars.example/dana.png' })
    expect(turns[2]).not.toHaveProperty('self')
    expect(turns[3]).toMatchObject({ kind: 'bot', agentId: 'agent_2' })
    expect(turns[4]).toMatchObject({ sp: { name: 'Sam' } })
    // One participant per person: the reader is not listed once per account.
    expect([...speakers.keys()]).toEqual(['me', 'user_dana', 'agent_2', 'U0STRANGER'])
    expect(speakers.get('me')?.sp.name).toBe('You')
  })

  it('reads a mail sender the Control Plane matched as the reader or a member, and an outsider by their address', () => {
    const members: MemberDto[] = [
      { ...MEMBER, userId: 'user_me', email: 'morgan@corp.example.test', name: 'Morgan', isCurrentUser: true },
      { ...MEMBER, userId: 'user_dana', email: 'dana@corp.example.test', name: 'Dana Reyes', picture: DANA_PICTURE }
    ]
    const me = { userId: 'user_me', email: 'morgan@corp.example.test', name: 'Morgan' } as MeDto
    const people = senderPeople(members, me, { initials: 'MO', picture: ME_PICTURE }, new Map())
    const { turns } = buildTurns(
      input({
        session: { ...input().session, platform: 'email' },
        isSelf: people.isSelf,
        senderLabel: people.label,
        pictureOf: people.pictureOf,
        viewer: people.viewer,
        rows: [
          // A verified address other than the sign-in one, which only the Control Plane's match names.
          row(1, 'morgan.alt@corp.example.test', 'from my other inbox', { senderUserId: 'user_me' }),
          row(2, 'dana.r@corp.example.test', 'me too', { senderName: 'D. Reyes', senderUserId: 'user_dana' }),
          row(3, 'outsider@other.example.test', 'hello')
        ]
      })
    )
    expect(turns[0]).toMatchObject({ self: true, sp: { name: 'You (Email)' }, avatarUrl: ME_PICTURE })
    expect(turns[1]).toMatchObject({ sp: { name: 'Dana Reyes' }, avatarUrl: DANA_PICTURE })
    expect(turns[1]).not.toHaveProperty('self')
    expect(turns[2]).toMatchObject({ sp: { name: 'outsider@other.example.test' } })
    expect(turns[2]).not.toHaveProperty('self')
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
