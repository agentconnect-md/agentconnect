// Looking back at open tasks (assistant-mode.md §5.20): which quiet tasks a look lists, what an item says, and how the coordinator settles one.
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOOK_BACK_INTERVAL_MS,
  LOOK_BACK_KIND,
  LOOK_BACK_LEAVES_MAX,
  LOOK_BACK_REMINDER_GAP_MS,
  LOOK_BACK_REPLY_TAIL_CHARS,
  LOOK_BACK_WINDOW_MS,
  LookBack,
  firstSentence,
  lookBackItemText,
  lookBackStale,
  lookBackVerdict,
  placeDue,
  replyTail,
  requiredQuietMs,
  sentBackText,
  type LookBackFacts,
  type LookBackHost,
  type LookBackItem,
  type LookBackTask
} from '../src/assistant/look-back.js'
import { coordinatorPrompt, LOOK_BACK_PROMPT } from '../src/auto-session/coordinator-prompt.js'
import { CoordinatorSessions, deliveredMessage } from '../src/auto-session/coordinator-sessions.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { coordinatorCoordinate } from '../src/session/append-coordinate.js'
import type { PlacedSubsession, TaskLookBack } from '../src/store/assistant-subsessions.js'
import { sessionKey, type LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const H = 60 * 60_000
const NOW = 1_800_000_000_000
const idle = { busy: false, muted: false }

const task = (quietFor: number, look: Partial<TaskLookBack> = {}, created = NOW - 2 * 24 * H): LookBackTask => ({
  changedAt: NOW - quietFor,
  createdAt: created,
  lookBack: { reminders: 0, sentBack: 0, left: 0, ...look }
})

describe('the look-back listing rule', () => {
  it.each([
    [0, 4 * H],
    [1, 8 * H],
    [2, 16 * H],
    [3, 24 * H],
    [7, 24 * H]
  ])('after %i sends back to work asks for %i ms of quiet', (sentBack, quiet) => {
    expect(requiredQuietMs(sentBack)).toBe(quiet)
    expect(lookBackVerdict(task(quiet - 1, { sentBack }), NOW, idle)).toEqual({ listed: false, why: 'quiet' })
    expect(lookBackVerdict(task(quiet, { sentBack }), NOW, idle)).toMatchObject({ listed: true })
  })

  it('lists a task with nothing kept yet once it has been quiet four hours, with a reminder open', () => {
    expect(lookBackVerdict({ changedAt: NOW - 5 * H, createdAt: NOW - 6 * H }, NOW, idle)).toEqual({
      listed: true,
      remind: true,
      left: 1
    })
  })

  it('never lists a task whose turn runs or waits', () => {
    expect(lookBackVerdict(task(10 * H), NOW, { busy: true, muted: false })).toEqual({ listed: false, why: 'busy' })
  })

  it('keeps a task a person stopped, or whose thread they muted, off the list', () => {
    expect(lookBackVerdict(task(10 * H, { stoppedAt: NOW - 9 * H }), NOW, idle)).toEqual({
      listed: false,
      why: 'stopped'
    })
    expect(lookBackVerdict(task(10 * H), NOW, { busy: false, muted: true })).toEqual({
      listed: false,
      why: 'stopped'
    })
  })

  it('lists nothing more than seven days after the last person’s message, else after the task opened', () => {
    expect(lookBackVerdict(task(10 * H, { personAt: NOW - LOOK_BACK_WINDOW_MS }), NOW, idle)).toMatchObject({
      listed: true
    })
    expect(lookBackVerdict(task(10 * H, { personAt: NOW - LOOK_BACK_WINDOW_MS - 1 }), NOW, idle)).toEqual({
      listed: false,
      why: 'window'
    })
    expect(lookBackVerdict(task(10 * H, {}, NOW - 8 * 24 * H), NOW, idle)).toEqual({ listed: false, why: 'window' })
  })

  it('reminds twice at most, the second no sooner than a day after the first', () => {
    // One reminder an hour ago and no round since: not listed until the day has passed.
    const once = (remindedAgo: number, quietFor = 30 * H) =>
      task(quietFor, { reminders: 1, remindedAt: NOW - remindedAgo })
    expect(lookBackVerdict(once(H), NOW, idle)).toEqual({ listed: false, why: 'reminded' })
    expect(lookBackVerdict(once(LOOK_BACK_REMINDER_GAP_MS - 1), NOW, idle)).toEqual({
      listed: false,
      why: 'reminded'
    })
    expect(lookBackVerdict(once(LOOK_BACK_REMINDER_GAP_MS), NOW, idle)).toEqual({ listed: true, remind: true, left: 1 })
    // A round since the reminder lists it on the quiet rule, but the second reminder still waits for the day.
    expect(lookBackVerdict(once(10 * H, 5 * H), NOW, idle)).toEqual({ listed: true, remind: false, left: 1 })
    // After the second, only a round lists it again, and never with a reminder open.
    const twice = (quietFor: number) => task(quietFor, { reminders: 2, remindedAt: NOW - 3 * 24 * H })
    expect(lookBackVerdict(twice(4 * 24 * H), NOW, idle)).toEqual({ listed: false, why: 'reminded' })
    expect(lookBackVerdict(twice(5 * H), NOW, idle)).toEqual({ listed: true, remind: false, left: 1 })
  })

  it('lists a task left six looks in a row no more until it changes', () => {
    const lookedAt = NOW - LOOK_BACK_INTERVAL_MS
    for (let left = 0; left < LOOK_BACK_LEAVES_MAX; left++)
      expect(lookBackVerdict(task(30 * H, { left, lookedAt }), NOW, idle)).toEqual({
        listed: true,
        remind: true,
        left: left + 1
      })
    expect(lookBackVerdict(task(30 * H, { left: LOOK_BACK_LEAVES_MAX, lookedAt }), NOW, idle)).toEqual({
      listed: false,
      why: 'left'
    })
    // A round since the last look starts the run over.
    expect(lookBackVerdict(task(5 * H, { left: LOOK_BACK_LEAVES_MAX, lookedAt: NOW - 6 * H }), NOW, idle)).toEqual({
      listed: true,
      remind: true,
      left: 1
    })
  })

  it('starts over once a person writes, which the store records as counts cleared', () => {
    const spent = task(30 * H, { reminders: 2, remindedAt: NOW - 2 * H, sentBack: 3, left: 6, lookedAt: NOW - H })
    expect(lookBackVerdict(spent, NOW, idle)).toMatchObject({ listed: false })
    const cleared = task(5 * H, { personAt: NOW - 5 * H, lookedAt: NOW - H })
    expect(lookBackVerdict(cleared, NOW, idle)).toEqual({ listed: true, remind: true, left: 1 })
  })

  it('finds an item stale once its task was stopped, heard from a person or ran a round after the look', () => {
    const looked = { lookedAt: NOW - H }
    expect(lookBackStale(task(5 * H, looked), false)).toBeUndefined()
    expect(lookBackStale(task(5 * H), false)).toBeUndefined()
    expect(lookBackStale(undefined, false)).toMatch(/no longer open/)
    expect(lookBackStale({ ...task(5 * H, looked), closedAt: NOW }, false)).toMatch(/no longer open/)
    expect(lookBackStale(task(5 * H, { ...looked, stoppedAt: NOW - 1 }), false)).toMatch(/stopped by a person/)
    expect(lookBackStale(task(5 * H, looked), true)).toMatch(/stopped by a person/)
    expect(lookBackStale(task(5 * H, { ...looked, personAt: NOW - 1 }), false)).toMatch(/heard from a person/)
    expect(lookBackStale(task(H / 2, looked), false)).toMatch(/run a round/)
  })

  it('looks at a place once every four hours at most', () => {
    expect(placeDue(undefined, NOW)).toBe(true)
    expect(placeDue(NOW - LOOK_BACK_INTERVAL_MS + 1, NOW)).toBe(false)
    expect(placeDue(NOW - LOOK_BACK_INTERVAL_MS, NOW)).toBe(true)
  })
})

describe('a look-back item', () => {
  const facts = (over: Partial<LookBackFacts> = {}): LookBackFacts => ({
    title: 'Move the cache to the new node',
    quietSince: Date.UTC(2026, 10, 12, 9, 0),
    summary: 'Waiting on Alice to approve the cutover. Scope: move the cache. Next: start the copy.',
    summaryAt: Date.UTC(2026, 10, 12, 8, 58),
    lastReply: 'The copy is ready. Alice, may I start it, and who runs the cutover?',
    failed: false,
    person: { name: 'Alice', at: Date.UTC(2026, 10, 12, 8, 40), zone: 'America/Los_Angeles' },
    reminders: 0,
    sentBack: 0,
    remind: true,
    now: Date.UTC(2026, 10, 13, 4, 0),
    ...over
  })

  it('carries the title, the summary’s first sentence, the reply’s end and the person’s local times', () => {
    const text = lookBackItemText(facts())
    expect(text).toContain(
      '[look back] Task "Move the cache to the new node" has been quiet since 2026-11-12T09:00Z (19 hours).'
    )
    expect(text).toContain('Its summary (written 2026-11-12T08:58Z): Waiting on Alice to approve the cutover.\n')
    expect(text).not.toContain('Scope:')
    expect(text).toContain(
      'The end of its last reply: "The copy is ready. Alice, may I start it, and who runs the cutover?"'
    )
    expect(text).toContain(
      'Last person to write in its threads: Alice, at 2026-11-12T08:40Z; their local time then Thu 00:40, ' +
        'now Thu 20:00 (America/Los_Angeles).'
    )
    expect(text).not.toContain('failed')
    expect(text).not.toContain('do not remind')
  })

  it('leaves the local times out where the person’s zone is unknown, never using another zone', () => {
    const text = lookBackItemText(facts({ person: { name: 'Alice', at: Date.UTC(2026, 10, 12, 8, 40) } }))
    expect(text).toContain('Last person to write in its threads: Alice, at 2026-11-12T08:40Z.')
    expect(text).not.toContain('local time')
    expect(lookBackItemText(facts({ person: { name: 'Alice', at: 1, zone: 'Not/AZone' } }))).not.toContain('local time')
  })

  it('says a round failed, what earlier looks did, and when a reminder is not open', () => {
    const text = lookBackItemText(
      facts({ failed: true, reminders: 2, remindedAt: Date.UTC(2026, 10, 12, 20, 0), sentBack: 1, remind: false })
    )
    expect(text).toContain('Its last round failed.')
    expect(text).toContain(
      'Since that person wrote, earlier looks reminded twice, last at 2026-11-12T20:00Z and sent back to work once.'
    )
    expect(text).toContain('It has had every reminder it may get: do not remind again.')
    expect(lookBackItemText(facts({ reminders: 1, remind: false }))).toContain(
      'Its last reminder is less than a day old'
    )
  })

  it('bounds the reply it quotes and the summary sentence', () => {
    const long = `${'word '.repeat(300)}final question?`
    const tail = replyTail(long)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith('final question?')).toBe(true)
    expect([...tail].length).toBeLessThanOrEqual(LOOK_BACK_REPLY_TAIL_CHARS + 1)
    expect(firstSentence('Blocked on review. Then more.')).toBe('Blocked on review.')
    expect([...firstSentence('x'.repeat(900))].length).toBe(200)
  })

  it('frames what a task sent back to work receives as no person’s message', () => {
    const text = sentBackText('Start the copy you were approved to run.')
    expect(text).toMatch(/^\[look back\] No person sent this/)
    expect(text).toContain('A step that needs a decision is asked in your thread and waits there.')
    // A round that finds nothing new posts nothing, as a follow-up's check stays silent.
    expect(text).toContain('When nothing has changed and nothing needs a person, post nothing')
    expect(text).toContain('reply with exactly `AC_NO_RESPONSE`')
    expect(text).toContain("Your coordinator's note: Start the copy you were approved to run.")
    expect(sentBackText()).not.toContain('note')
  })
})

describe('the coordinator prompt', () => {
  const input = { agentName: 'Helper', platform: 'Slack', channelId: 'C0EXAMPLE1', peers: [] }

  it('explains look-back items only to an assistant-mode coordinator', () => {
    expect(coordinatorPrompt({ ...input, lookBack: true })).toContain(LOOK_BACK_PROMPT)
    expect(coordinatorPrompt(input)).not.toContain('# Looking back')
  })
})

describe('the look-back sweep', () => {
  const COORDINATOR_KEY = sessionKey('slack', 'C0EXAMPLE1', coordinatorCoordinate(1), 'agent-a')
  const placed = (thread: string, over: Partial<PlacedSubsession> = {}): PlacedSubsession => ({
    agentId: 'agent-a',
    childSessionKey: sessionKey('slack', 'C0EXAMPLE1', thread, 'agent-a'),
    parentSessionId: 'sid-co',
    parentSessionKey: COORDINATOR_KEY,
    state: 'done',
    createdAt: NOW - 2 * 24 * H,
    changedAt: NOW - 10 * H,
    title: `Task ${thread}`,
    owner: { platform: 'slack', channel: 'C0EXAMPLE1' },
    threadSessions: [],
    ...over
  })

  function sweepHost(candidates: PlacedSubsession[], lastLook?: number) {
    const looked: { key: string; left: number }[] = []
    const delivered: LookBackItem[][] = []
    const host: LookBackHost = {
      now: () => NOW,
      agents: () => [{ id: 'agent-a', assistantMode: { enabled: true } } as never],
      mayLook: () => true,
      draining: () => false,
      index: {
        lookBackCandidates: async () => candidates,
        lastLooks: async () => new Map(lastLook === undefined ? [] : [[COORDINATOR_KEY, lastLook]]),
        markLooked: async (_agentId, key, look) => {
          looked.push({ key, left: look.left })
          return true
        }
      },
      busy: async (key) => key.includes(':2.2:'),
      muted: async () => false,
      facts: async (_agentId, t, remind) => ({
        ...(t.title ? { title: t.title } : {}),
        quietSince: t.changedAt!,
        failed: false,
        reminders: 0,
        sentBack: 0,
        remind,
        now: NOW
      }),
      deliver: async (_agentId, _place, items) => void delivered.push(items),
      log: { info: () => {}, warn: () => {} }
    }
    return { host, looked, delivered }
  }

  it('hands a due place its quiet idle tasks as one delivery, marked before it goes', async () => {
    const { host, looked, delivered } = sweepHost([placed('1.1'), placed('2.2'), placed('3.3', { changedAt: NOW - H })])
    await new LookBack(host).sweep()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.map((item) => item.task.title)).toEqual(['Task 1.1'])
    expect(looked).toEqual([{ key: placed('1.1').childSessionKey, left: 1 }])
  })

  it('costs nothing where nothing is quiet, and nothing before the place is due', async () => {
    const quiet = sweepHost([placed('3.3', { changedAt: NOW - H })])
    await new LookBack(quiet.host).sweep()
    expect(quiet.delivered).toEqual([])
    const early = sweepHost([placed('1.1')], NOW - H)
    await new LookBack(early.host).sweep()
    expect(early.delivered).toEqual([])
    expect(early.looked).toEqual([])
  })

  it('looks only at a coordinator’s tasks, never a webchat conversation’s', async () => {
    const other = sweepHost([
      placed('1.1', { parentSessionKey: sessionKey('slack', 'C0EXAMPLE1', 'append:1', 'agent-a') }),
      placed('4.4', { owner: { platform: 'webchat', channel: 'conv-1' } })
    ])
    await new LookBack(other.host).sweep()
    expect(other.delivered).toEqual([])
  })
})

describe('the coordinator settling a look-back item', () => {
  const COORDINATOR = coordinatorCoordinate(1)
  const coordinatorKey = sessionKey('slack', 'C1', COORDINATOR, 'bot-a')
  const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a')
  const otherKey = sessionKey('slack', 'C1', '2.2', 'bot-a')
  let store: LocalStore | undefined
  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  async function setup() {
    store = await openTestStore()
    const s = store
    for (const [key, thread] of [
      [taskKey, '1.1'],
      [otherKey, '2.2']
    ] as const) {
      await s.assistantSubsessions.open({
        agentId: 'bot-a',
        childSessionKey: key,
        parentSessionId: 'sid-co',
        parentSessionKey: coordinatorKey,
        title: `Task ${thread}`,
        now: 1
      })
      await s.assistantSubsessions.finish('bot-a', key, 'done')
    }
    const sentBack: { taskKey: string; note?: string }[] = []
    const settled: string[] = []
    const posted: string[] = []
    const sessions = new CoordinatorSessions({
      store: () => s,
      now: () => 1_000,
      dispatch: () => {},
      post: async (_agentId, _integrationId, _msg, text) => {
        posted.push(text)
        return undefined
      },
      reportAnswered: () => {},
      showTriaging: () => () => {},
      sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
      reportTaskOwners: async () => {},
      sendBack: async (_agentId, key, note) => void sentBack.push({ taskKey: key, ...(note ? { note } : {}) }),
      lookBackSettled: async (_agentId, key, outcome) => void settled.push(`${outcome}:${key}`),
      warn: () => {}
    })
    const ctx: SessionContext = {
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: COORDINATOR,
      deliveryThread: '1.1',
      isDm: false,
      tools: []
    }
    const item = (ts: string, over: { kind?: string; remind?: boolean } = {}) =>
      deliveredMessage(
        {
          msgId: `agentcall:C1:assistant-report:${ts}`,
          traceId: `t-${ts}`,
          source: 'agent',
          platform: 'slack',
          channel: 'C1',
          thread: '1.1',
          sessionThread: COORDINATOR,
          transcriptTs: ts,
          parentReport: true,
          sender: { id: 'bot-a', isBot: true },
          text: '[look back] Task "Task 1.1" has been quiet',
          mentionedBots: [],
          isDm: false
        } as NormalizedMessage,
        'int-bot-a',
        false,
        {
          task: taskKey,
          kind: over.kind ?? LOOK_BACK_KIND,
          title: 'Task 1.1',
          ...(over.kind === undefined ? { lookBack: { remind: over.remind ?? true } } : {})
        }
      )
    return { sessions, ctx, item, sentBack, settled, posted }
  }

  it('posts a reminder with replyToMessage and records it', async () => {
    const { sessions, ctx, item, settled, posted } = await setup()
    sessions.turns.begin(coordinatorKey, [item('9.1')])
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-9.1', message: 'Alice, may it start the copy?' })
    ).resolves.toMatchObject({ ok: true })
    expect(posted).toEqual(['Alice, may it start the copy?'])
    expect(settled).toEqual([`reminded:${taskKey}`])
  })

  it('refuses a reminder once the task has had every reminder it may get for now', async () => {
    const { sessions, ctx, item, posted } = await setup()
    sessions.turns.begin(coordinatorKey, [item('9.1', { remind: false })])
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-9.1', message: 'Alice?' })
    ).rejects.toThrow(/every reminder it may get/)
    expect(posted).toEqual([])
    // The refusal gives the item back, so it can still be left.
    await expect(
      sessions.decide(ctx, { action: 'ignoreMessage', messageId: 'msg-9.1', reason: 'night' })
    ).resolves.toEqual({ ok: true, ignored: 'msg-9.1' })
  })

  it('sends its own task back to work with messageTask, by its whole key or a prefix of it', async () => {
    const { sessions, ctx, item, sentBack, settled } = await setup()
    sessions.turns.begin(coordinatorKey, [item('9.1'), item('9.2')])
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-9.1', taskId: taskKey, message: 'Start the copy.' })
    ).resolves.toMatchObject({ ok: true, taskId: taskKey })
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-9.2', taskId: 'slack:C1:1.1' })
    ).resolves.toMatchObject({ ok: true, taskId: taskKey })
    expect(sentBack).toEqual([{ taskKey, note: 'Start the copy.' }, { taskKey }])
    expect(settled).toEqual([`sent back:${taskKey}`, `sent back:${taskKey}`])
  })

  it('refuses messageTask to any other task, and delegateTask', async () => {
    const { sessions, ctx, item, sentBack, settled } = await setup()
    sessions.turns.begin(coordinatorKey, [item('9.1')])
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-9.1', taskId: otherKey })
    ).rejects.toThrow(/sends back to work only the task its item names/)
    await expect(sessions.decide(ctx, { action: 'delegateTask', messageId: 'msg-9.1', title: 'Copy' })).rejects.toThrow(
      /is a report, not a channel message/
    )
    expect(sentBack).toEqual([])
    expect(settled).toEqual([])
  })

  it('acts on no item whose task a person stopped after the look listed it, and still lets it be left', async () => {
    const { sessions, ctx, item, sentBack, settled, posted } = await setup()
    await store!.assistantSubsessions.markLooked('bot-a', taskKey, { now: 500, left: 1 })
    await store!.assistantSubsessions.markStopped('bot-a', taskKey, 600)
    sessions.turns.begin(coordinatorKey, [item('9.1')])
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-9.1', taskId: taskKey, message: 'Go on.' })
    ).rejects.toThrow(/stopped by a person since/)
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-9.1', message: 'Alice?' })
    ).rejects.toThrow(/stopped by a person since/)
    expect(sentBack).toEqual([])
    expect(posted).toEqual([])
    expect(settled).toEqual([])
    await expect(
      sessions.decide(ctx, { action: 'ignoreMessage', messageId: 'msg-9.1', reason: 'stopped' })
    ).resolves.toEqual({ ok: true, ignored: 'msg-9.1' })
  })

  it('acts on no item whose task heard from a person after the look', async () => {
    const { sessions, ctx, item, posted } = await setup()
    await store!.assistantSubsessions.markLooked('bot-a', taskKey, { now: 500, left: 1 })
    await store!.assistantSubsessions.notePerson('bot-a', taskKey, {
      asker: { kind: 'member', platform: 'slack', integrationId: 'int-bot-a', userId: 'U0EXAMPLE1' },
      now: 600
    })
    sessions.turns.begin(coordinatorKey, [item('9.1')])
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-9.1', message: 'Alice?' })
    ).rejects.toThrow(/heard from a person since/)
    expect(posted).toEqual([])
  })

  it('leaves an ordinary report as it was: messageTask is refused there', async () => {
    const { sessions, ctx, item, sentBack } = await setup()
    sessions.turns.begin(coordinatorKey, [item('9.1', { kind: 'delegated task' })])
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-9.1', taskId: taskKey })
    ).rejects.toThrow(/is a report, not a channel message/)
    expect(sentBack).toEqual([])
  })
})
