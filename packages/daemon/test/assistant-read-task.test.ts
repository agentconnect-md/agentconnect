// readTask and the ids every task read inlines (assistant-mode.md §5.18 ④): one task's record and words, judged like recall of its place on every call, and never waking it.
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOSED_LOOKUPS,
  NOT_SHARED_HERE,
  type ReadAsker,
  type ReadLookups,
  type TurnAskers
} from '../src/assistant/place-access.js'
import { CheckedTasks } from '../src/assistant/checked-tasks.js'
import { shortTaskIds } from '../src/assistant/task-ids.js'
import { createdObjectOf, feedbackPullOf } from '../src/codehost/opened-object.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { LIST_TASKS_TOOL, READ_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import type { PlaceStore } from '../src/mcp/ops/place-gate.js'
import type { TaskReadDeps } from '../src/mcp/ops/read-task.js'
import { CLOSED_TASK_RETENTION_MS } from '../src/store/closed-tasks.js'
import { sessionKey, type LocalStore, type SessionRecord, type TranscriptRow } from '../src/store/local-store.js'
import { StoreRetentionSweeper } from '../src/store/retention.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-read'
const SCOPE = 'T0EXAMPLE'
const BOT = 'int-slack'
const DEPLOY = 'C0DEPLOY'
const PRIV = 'C0PRIVATE'
const THREAD = '1700000000.000100'
const PR = 'https://github.com/example-org/example-repo/pull/12'

const coordinatorKey = (channel: string) => sessionKey('slack', channel, 'append:coordinator-1', AGENT, SCOPE)
const taskKey = (channel: string, thread = THREAD) => sessionKey('slack', channel, thread, AGENT, SCOPE)
const watchKey = sessionKey('slack', DEPLOY, 'subsession:check-pr', AGENT, SCOPE)
/** A task key as every task read shows it: cut before the agent's id. */
const short = (key: string) => key.slice(0, key.lastIndexOf(`:${AGENT}`))

const alice: ReadAsker = { kind: 'member', platform: 'slack', integrationId: BOT, userId: 'U0EXAMPLE1' }
const guest: ReadAsker = { kind: 'member', platform: 'slack', integrationId: BOT, userId: 'U0EXAMPLE2' }
const consoleUser: ReadAsker = { kind: 'console', userId: 'user-1' }
const asking = (...people: ReadAsker[]): TurnAskers => ({ people, nobody: false })

/** Alice is a full member; the guest is a member of nothing; the console user sees the coordinator's sessions only. */
const LOOKUPS: ReadLookups = {
  ...CLOSED_LOOKUPS,
  fullMember: async (_bot, user) => user === alice.userId,
  member: async (_bot, channel, user) => user === alice.userId && channel !== PRIV,
  console: async (who, ids) =>
    who.kind === 'console'
      ? { asker: 'linked', visible: new Set(ids.filter((id) => id.startsWith('sid-coordinator'))) }
      : { asker: 'unidentifiable' }
}

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const session = (key: string, channel: string, thread: string, sessionId: string): SessionRecord => ({
  key,
  agentId: AGENT,
  platform: 'slack',
  channel,
  thread,
  transportScope: SCOPE,
  acpSessionId: `acp-${sessionId}`,
  sessionId,
  conversationKind: 'channel',
  state: 'idle',
  lastDeliveredTs: null,
  updatedAt: 1_000
})

/** The task's own transcript, twelve text rows a minute apart and one tool row; recall's rows on the coordinator's session. */
function transcript(): Map<string, TranscriptRow[]> {
  let seq = 0
  const row = (sender: string, minute: number, text: string, over: Partial<TranscriptRow> = {}): TranscriptRow => ({
    channel: DEPLOY,
    thread: THREAD,
    seq: ++seq,
    revision: seq,
    eventTimeUs: 60_000 * minute * 1000,
    ts: `1700000${String(minute).padStart(3, '0')}.000100`,
    sender,
    kind: 'text',
    text,
    ...over
  })
  const task = [
    ...Array.from({ length: 12 }, (_, n) => row(n % 2 ? AGENT : alice.userId, n + 1, `step ${n + 1}`)),
    row(AGENT, 13, 'Bash(gh pr create)', { kind: 'tool' })
  ]
  const place = [
    row(alice.userId, 0, 'can you retry the webhook sender with backoff?', { ts: THREAD, thread: null }),
    row(guest.userId, 20, 'is it merged?', { ts: '1700000020.000100' }),
    row(AGENT, 21, 'Started a task.', { ts: '1700000021.000100' }),
    row(guest.userId, 22, 'unrelated chatter', { ts: '1700000022.000100', thread: null })
  ]
  return new Map([
    [taskKey(DEPLOY), task],
    [coordinatorKey(DEPLOY), place]
  ])
}

function placeStore(sessions: SessionRecord[], rows = transcript()): PlaceStore {
  return {
    listSessions: async () => sessions,
    latestSession: async (_agent, channel) => sessions.find((s) => s.channel === channel),
    transcriptPageForAgent: async (scope, before, limit) => {
      const all = (rows.get(scope.sessionKey) ?? [])
        .filter((r) => before === null || r.seq < before)
        .sort((a, b) => b.seq - a.seq)
      return { rows: all.slice(0, limit), hasMore: all.length > limit }
    },
    getDisplayNames: async (ids) => new Map(ids.filter((id) => id === alice.userId).map((id) => [id, 'Alice']))
  }
}

/** The daemon's wiring of taskReads over the real store. */
function reads(s: LocalStore): NonNullable<TaskReadDeps['taskReads']> {
  const checked = new CheckedTasks({ watchTasks: s.assistantWatchTasks, items: s.assistantItems })
  return {
    resolve: (a, id) => s.assistantSubsessions.resolve(a, id),
    record: (a, key) => s.assistantSubsessions.record(a, key),
    checked: (a, key) => checked.get(a, key),
    opened: (a, key) => s.assistantSubsessions.opened(a, key),
    watchUrls: (a) => s.assistantSubsessions.watchUrls(a),
    session: (key) => s.getSession(key),
    shortIds: async (a) => {
      const ids = shortTaskIds(await s.assistantSubsessions.taskKeys(a), a)
      return (key) => ids.get(key) ?? key
    },
    openedFor: (a, message) => s.assistantSubsessions.taskOpenedFor(a, message),
    holding: (a, at) => s.assistantSubsessions.taskOfThread(a, at)
  }
}

interface World {
  s: LocalStore
  sessions: SessionRecord[]
  askers: { current: TurnAskers }
  deps: OpsDeps
}

/** A coordinator in a public channel with a task that opened a pull request a follow-up watches, and one in a private channel. */
async function world(): Promise<World> {
  const s = (store = await openTestStore())
  const sessions = [
    session(coordinatorKey(DEPLOY), DEPLOY, 'append:coordinator-1', 'sid-coordinator-deploy'),
    session(taskKey(DEPLOY), DEPLOY, THREAD, 'sid-task-deploy'),
    session(coordinatorKey(PRIV), PRIV, 'append:coordinator-1', 'sid-coordinator-priv'),
    session(taskKey(PRIV), PRIV, THREAD, 'sid-task-priv')
  ]
  for (const one of sessions) await s.upsertSession(one)
  const index = s.assistantSubsessions
  for (const channel of [DEPLOY, PRIV]) {
    await index.open({
      agentId: AGENT,
      childSessionKey: taskKey(channel),
      parentSessionId: `sid-coordinator-${channel === DEPLOY ? 'deploy' : 'priv'}`,
      parentSessionKey: coordinatorKey(channel),
      title: 'Add retry with backoff to the webhook sender',
      background: 'can you retry the webhook sender with backoff?',
      openedFor: { place: `slack:${channel}`, messageId: `msg-${THREAD}` },
      now: 1_000
    })
    await index.attachThread({
      agentId: AGENT,
      childSessionKey: taskKey(channel),
      platform: 'slack',
      channel,
      transportScope: SCOPE,
      thread: THREAD,
      sinceRound: 1,
      now: 1_000
    })
    await index.finish(AGENT, taskKey(channel), 'done', undefined, 1_500)
  }
  await index.setSummary(AGENT, taskKey(DEPLOY), { summary: 'Waiting on review: PR #12 is open.', now: 2_000 })
  await index.recordOpened(AGENT, taskKey(DEPLOY), {
    kind: 'pull request',
    label: 'example-org/example-repo#12',
    url: PR,
    now: 1_800
  })
  await s.assistantWatchTasks.open({
    agentId: AGENT,
    taskKey: watchKey,
    title: 'Tell Alice when PR #12 merges',
    origin: { platform: 'slack', channel: DEPLOY, transportScope: SCOPE },
    owner: { sessionId: 'sid-coordinator-deploy', key: coordinatorKey(DEPLOY) },
    now: 1_900
  })
  await s.assistantWatchTasks.setWatch(AGENT, watchKey, {
    url: `${PR}/files`,
    target: 'example-org/example-repo#12',
    state: 'watching',
    reason: null
  })
  const askers = { current: asking(alice) }
  const deps = {
    gatewayFor: () => undefined,
    placeIntegrationFor: () => BOT,
    placeSnapshot: (_bot: string, channel: string) => ({ kind: 'channel' as const, isPrivate: channel === PRIV }),
    // recall reads the coordinators' sessions; readTask reads a task's own through taskReads.
    placeStore: placeStore(sessions.filter((one) => one.thread.startsWith('append:'))),
    readAskers: async () => askers.current,
    readLookups: () => LOOKUPS,
    taskReads: reads(s)
  } as unknown as OpsDeps
  return { s, sessions, askers, deps }
}

/** A coordinator turn in Alice's DM. */
const inDm: SessionContext = {
  agentId: AGENT,
  platform: 'slack',
  integrationId: BOT,
  transportScope: SCOPE,
  isDm: true,
  channel: 'D0EXAMPLE1',
  thread: 'append:1',
  deliveryThread: '1.1',
  tools: [READ_TASK_TOOL],
  integrations: [{ id: BOT, platform: 'slack' }]
}

const read = async (w: World, taskId: string, after?: string) =>
  (await executeTool(inDm, 'readTask', { taskId, ...(after ? { after } : {}) }, w.deps)) as Record<string, any>

const refused = (taskId: string) => ({ taskId, refused: true, answer: NOT_SHARED_HERE, note: expect.any(String) })

describe('readTask (assistant-mode.md §5.18 ④)', () => {
  it('reads another place’s task: its record, the ids related to it and its latest words, page by page', async () => {
    const w = await world()
    const before = await w.s.assistantSubsessions.record(AGENT, taskKey(DEPLOY))
    const first = await read(w, short(taskKey(DEPLOY)))
    expect(first).toMatchObject({
      taskId: short(taskKey(DEPLOY)),
      kind: 'delegated task',
      mode: 'work',
      title: 'Add retry with backoff to the webhook sender',
      status: 'idle',
      summary: 'Waiting on review: PR #12 is open.',
      summaryAt: new Date(2_000).toISOString(),
      place: `slack:${DEPLOY}`,
      openedFor: { place: `slack:${DEPLOY}`, messageId: `msg-${THREAD}` },
      opened: [{ kind: 'pull request', label: 'example-org/example-repo#12', url: PR, watchedBy: [short(watchKey)] }]
    })
    // The newest ten text rows, shown oldest first; the tool row is never one.
    expect(first.excerpts.map((e: { text: string }) => e.text)).toEqual(
      Array.from({ length: 10 }, (_, n) => `step ${n + 3}`)
    )
    expect(first.excerpts[0]).toMatchObject({ from: 'Alice', messageId: 'msg-1700000003.000100' })
    expect(first.excerpts[1]).toMatchObject({ from: 'task' })
    expect(first.nextCursor).toMatch(/^t\./)
    const second = await read(w, taskKey(DEPLOY), first.nextCursor)
    expect(second.excerpts.map((e: { text: string }) => e.text)).toEqual(['step 1', 'step 2'])
    expect(second).not.toHaveProperty('nextCursor')
    // Reading wakes nothing: the record is as it was.
    expect(await w.s.assistantSubsessions.record(AGENT, taskKey(DEPLOY))).toEqual(before)
    await expect(read(w, taskKey(DEPLOY), 'not-a-cursor')).rejects.toThrow(/after must be a nextCursor/)
  })

  it('reads a follow-up as a watch task, with what it watches', async () => {
    const w = await world()
    expect(await read(w, short(watchKey))).toMatchObject({
      taskId: short(watchKey),
      kind: 'follow-up',
      mode: 'watch',
      title: 'Tell Alice when PR #12 merges',
      status: 'waiting',
      watching: { url: `${PR}/files`, label: 'example-org/example-repo#12' },
      excerpts: [],
      note: 'Its conversation is no longer kept: only its record is left.'
    })
  })

  it('judges every asker of the turn, on the first page and on every continuation', async () => {
    const w = await world()
    const first = await read(w, taskKey(DEPLOY))
    expect(first.nextCursor).toBeDefined()
    w.askers.current = asking(alice, guest)
    expect(await read(w, taskKey(DEPLOY), first.nextCursor)).toEqual(refused(taskKey(DEPLOY)))
    w.askers.current = asking(guest)
    expect(await read(w, taskKey(DEPLOY))).toEqual(refused(taskKey(DEPLOY)))
    // A console user is judged by the task's own sessions, which the console does not show them.
    w.askers.current = asking(consoleUser)
    expect(await read(w, taskKey(DEPLOY))).toEqual(refused(taskKey(DEPLOY)))
    // A turn nobody is behind reads a public channel's task on its own bot.
    w.askers.current = { people: [], nobody: true }
    expect(await read(w, taskKey(DEPLOY))).toMatchObject({ taskId: short(taskKey(DEPLOY)) })
  })

  it('answers a task the turn may not read exactly as an unknown id or an ambiguous prefix', async () => {
    const w = await world()
    w.askers.current = asking(alice)
    expect(await read(w, taskKey(PRIV))).toEqual(refused(taskKey(PRIV)))
    expect(await read(w, 'slack:C0NOPE')).toEqual(refused('slack:C0NOPE'))
    expect(await read(w, 'slack:C0')).toEqual(refused('slack:C0'))
    // Its own place's task is the coordinator's to read, as recall of the current place is.
    const inPrivate = { ...inDm, isDm: false, channel: PRIV, thread: 'append:coordinator-1' }
    expect(await executeTool(inPrivate, 'readTask', { taskId: taskKey(PRIV) }, w.deps)).toMatchObject({
      taskId: short(taskKey(PRIV)),
      status: 'idle'
    })
  })

  it('reads a closed task within its window, its words until it closed while its session is kept, and none past it', async () => {
    const w = await world()
    const index = w.s.assistantSubsessions
    // Closed after its sixth row; a later session on the same key is not the task's.
    expect(await index.closeTask(AGENT, taskKey(DEPLOY), 6 * 60_000)).toBe(true)
    const closed = await read(w, short(taskKey(DEPLOY)))
    expect(closed).toMatchObject({
      status: 'closed',
      closedAt: new Date(6 * 60_000).toISOString(),
      summary: 'Waiting on review: PR #12 is open.',
      openedFor: { messageId: `msg-${THREAD}` },
      opened: [{ label: 'example-org/example-repo#12' }]
    })
    expect(closed.excerpts.map((e: { text: string }) => e.text)).toEqual(
      Array.from({ length: 6 }, (_, n) => `step ${n + 1}`)
    )
    // Its session purged, the record still answers, without words.
    await w.s.deleteSession(taskKey(DEPLOY), { reason: 'retention', at: 7 * 60_000 })
    expect(await read(w, taskKey(DEPLOY))).toMatchObject({
      status: 'closed',
      summary: 'Waiting on review: PR #12 is open.',
      excerpts: [],
      note: 'Its conversation is no longer kept: only its record is left.'
    })
    const sweeper = new StoreRetentionSweeper({
      store: w.s,
      settings: { scale: 1, deleteOrphans: false },
      clock: { now: () => 6 * 60_000 + CLOSED_TASK_RETENTION_MS } as never,
      log: { info: () => {}, warn: () => {} }
    })
    expect((await sweeper.sweepAgeOnly())?.byRule['closed-task']).toBe(1)
    expect(await read(w, taskKey(DEPLOY))).toEqual(refused(taskKey(DEPLOY)))
  })
})

describe('inlined ids (assistant-mode.md §5.18 ④)', () => {
  it('gives each recall excerpt its message id, and the task it was handed to where the turn may read that task', async () => {
    const w = await world()
    const recalled = async () =>
      (
        (await executeTool(inDm, 'recall', { place: `slack:${DEPLOY}` }, w.deps)) as {
          excerpts: { text: string; messageId: string; taskId?: string }[]
        }
      ).excerpts.map(({ text, messageId, taskId }) => [text, messageId, taskId])
    expect(await recalled()).toEqual([
      ['can you retry the webhook sender with backoff?', `msg-${THREAD}`, short(taskKey(DEPLOY))],
      ['is it merged?', 'msg-1700000020.000100', short(taskKey(DEPLOY))],
      ['Started a task.', 'msg-1700000021.000100', undefined],
      ['unrelated chatter', 'msg-1700000022.000100', undefined]
    ])
    // The console user may read the place by its sessions, not the task by its own: its id is left out.
    w.askers.current = asking(consoleUser)
    expect((await recalled()).map(([, , taskId]) => taskId)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('lists the message a task was opened for and what it opened, under its short id', async () => {
    const w = await world()
    const inPlace: SessionContext = {
      ...inDm,
      isDm: false,
      channel: DEPLOY,
      thread: 'append:coordinator-1',
      tools: [LIST_TASKS_TOOL, READ_TASK_TOOL]
    }
    const deps = {
      ...w.deps,
      taskReach: async () => 'delegate' as const,
      assistantSubsessions: {
        sessionIdOf: async () => 'sid-coordinator-deploy',
        listForOwner: w.s.assistantSubsessions.listForOwner.bind(w.s.assistantSubsessions),
        opened: (agentId: string, key: string) => w.s.assistantSubsessions.opened(agentId, key),
        shortIds: (w.deps as TaskReadDeps).taskReads!.shortIds,
        now: () => 3_000
      }
    } as unknown as OpsDeps
    const listed = (await executeTool(inPlace, 'listTasks', {}, deps)) as { tasks: Record<string, unknown>[] }
    expect(listed.tasks[0]).toMatchObject({
      taskId: short(taskKey(DEPLOY)),
      openedFor: { place: `slack:${DEPLOY}`, messageId: `msg-${THREAD}` },
      opened: [{ kind: 'pull request', label: 'example-org/example-repo#12', url: PR }]
    })
  })
})

describe('what the daemon sees a task open (assistant-mode.md §5.18 ④)', () => {
  it('reads a created merge request or pull request from its broker result', () => {
    expect(
      createdObjectOf({
        mergeRequest: { iid: 3, webUrl: 'https://gitlab.example.test/group/project/-/merge_requests/3' }
      })
    ).toEqual({
      kind: 'merge request',
      label: 'group/project!3',
      url: 'https://gitlab.example.test/group/project/-/merge_requests/3'
    })
    expect(
      createdObjectOf({ pullRequest: { number: 7, htmlUrl: 'https://git.example.test/org/repo/pulls/7' } })
    ).toEqual({
      kind: 'pull request',
      label: 'org/repo#7',
      url: 'https://git.example.test/org/repo/pulls/7'
    })
    expect(createdObjectOf({ note: {} })).toBeUndefined()
  })

  it('names the pull request a feedback continuation says the session opened', () => {
    const base = { repoFullName: 'example-org/example-repo', pullNumber: 12 }
    expect(feedbackPullOf(base)).toEqual({ kind: 'pull request', label: 'example-org/example-repo#12', url: PR })
    expect(feedbackPullOf({ ...base, provider: 'gitlab', host: 'https://gitlab.example.test/' })).toMatchObject({
      label: 'example-org/example-repo!12',
      url: 'https://gitlab.example.test/example-org/example-repo/-/merge_requests/12'
    })
    expect(feedbackPullOf({ ...base, provider: 'gitea' })).toBeUndefined()
  })
})
