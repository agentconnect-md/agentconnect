// Follow-ups as watch tasks (assistant-mode.md §5.18): one id, the task key, in the task store; the v74 migration on SQLite and on PostgreSQL; the board, listTasks and updateTask on one.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckedTasks } from '../src/assistant/checked-tasks.js'
import { checkPrompt, checkTools } from '../src/assistant/follow-up-checks.js'
import { readOpenWork, renderWorkBoard, workBoardView } from '../src/assistant/work-board.js'
import { coordinatorPrompt } from '../src/auto-session/coordinator-prompt.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { LIST_TASKS_TOOL, UPDATE_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { WATCH_TASK_COLUMN_TYPES } from '../src/store/assistant-watch-tasks.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

const AGENT = 'agent-watch'
const SCOPE = 'T0EXAMPLE'
const ALICE = 'slack:T0EXAMPLE:U0EXAMPLE1'
const GENERAL = { platform: 'slack', channel: 'C0EXAMPLE1', transportScope: SCOPE }
const DM = { platform: 'slack', channel: 'D0EXAMPLE1', transportScope: SCOPE }
const PLACE_KEY = sessionKey('slack', GENERAL.channel, 'append:1', AGENT, SCOPE)
const OWNER = { sessionId: 'sid-place', key: PLACE_KEY }
const key = (id: string, channel = GENERAL.channel) =>
  sessionKey('slack', channel, `subsession:check-${id}`, AGENT, SCOPE)

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

const watchTask = (
  s: LocalStore,
  id: string,
  over: { nextAt?: number; origin?: typeof GENERAL; shared?: boolean; now?: number; title?: string } = {}
) =>
  s.assistantWatchTasks.open({
    agentId: AGENT,
    taskKey: key(id, (over.origin ?? GENERAL).channel),
    title: over.title ?? `Watch ${id}`,
    doneWhen: 'It shipped',
    origin: over.origin ?? GENERAL,
    owner: OWNER,
    asker: ALICE,
    background: 'Alice asked to hear when it ships.',
    ...(over.nextAt !== undefined ? { nextAt: over.nextAt } : {}),
    ...(over.shared ? { shared: true } : {}),
    now: over.now ?? 1_000
  })

describe('a follow-up is a watch task of the task store', () => {
  it('has one id, its task key, and lives on its task row in watch mode', async () => {
    const s = await open()
    const task = await watchTask(s, '1', { nextAt: 9_000 })
    expect(task).toEqual({
      taskKey: key('1'),
      agentId: AGENT,
      title: 'Watch 1',
      doneWhen: 'It shipped',
      nextAt: 9_000,
      status: 'active',
      origin: GENERAL,
      owner: OWNER,
      asker: ALICE,
      shared: false,
      replyThread: null,
      watch: null,
      background: 'Alice asked to hear when it ships.',
      summary: '',
      summaryUpdatedAt: null,
      observations: [],
      observationVersion: 0,
      version: 1,
      running: false,
      createdAt: 1_000,
      updatedAt: 1_000,
      changedAt: 1_000
    })
    expect(task).not.toHaveProperty('id')
    expect(await s.assistantSubsessions.get(AGENT, key('1'))).toMatchObject({
      mode: 'watch',
      watchStatus: 'active',
      nextAt: 9_000,
      state: 'done',
      title: 'Watch 1',
      parentSessionId: OWNER.sessionId,
      place: GENERAL
    })
    expect(await s.assistantItems.list(AGENT)).toEqual([])
    expect(await s.assistantWatchTasks.get('agent-other', key('1'))).toBeUndefined()
    await expect(watchTask(s, '1')).rejects.toThrow()
  })

  it('makes each check’s result its summary, cut to a summary’s length', async () => {
    const s = await open()
    await watchTask(s, '1')
    await s.assistantWatchTasks.appendObservation(AGENT, key('1'), { text: 'Rollout at 40%', now: 2_000 })
    expect(await s.assistantWatchTasks.get(AGENT, key('1'))).toMatchObject({
      summary: 'Rollout at 40%',
      summaryUpdatedAt: 2_000,
      observationVersion: 1,
      changedAt: 1_000
    })
    await s.assistantWatchTasks.appendObservation(AGENT, key('1'), { text: 'x'.repeat(600), now: 3_000 })
    const after = (await s.assistantWatchTasks.get(AGENT, key('1')))!
    expect([...after.summary]).toHaveLength(500)
    expect(after.observations.map((o) => o.version)).toEqual([1, 2])
  })

  it('schedules and ends it once, moving it on the board only when its schedule changes', async () => {
    const s = await open()
    await watchTask(s, '1', { nextAt: 9_000 })
    const tasks = s.assistantWatchTasks
    expect(await tasks.schedule(AGENT, key('1'), { status: 'active', nextAt: 9_000 }, 2_000)).toBe(true)
    expect((await tasks.get(AGENT, key('1')))?.changedAt).toBe(1_000)
    expect(await tasks.schedule(AGENT, key('1'), { status: 'waiting', nextAt: null }, 3_000)).toBe(true)
    expect(await tasks.get(AGENT, key('1'))).toMatchObject({ status: 'waiting', nextAt: null, changedAt: 3_000 })
    expect(await tasks.schedule(AGENT, key('1'), { status: 'dropped', nextAt: null }, 4_000)).toBe(true)
    expect(await tasks.schedule(AGENT, key('1'), { status: 'active', nextAt: 5_000 }, 5_000)).toBe(false)
    expect(await tasks.get(AGENT, key('1'))).toMatchObject({ status: 'dropped', version: 4 })
    // An ended one keeps its row, so a page or a proposal naming it still reads it, and closing work tasks leaves it.
    expect(await s.assistantSubsessions.closeTask(AGENT, key('1'))).toBe(false)
    expect(await tasks.get(AGENT, key('1'))).toBeDefined()
  })

  it('lists a place’s own and every shared one, and keeps what it watches', async () => {
    const s = await open()
    await watchTask(s, 'here', { now: 1_000 })
    await watchTask(s, 'dm', { origin: DM, now: 2_000 })
    await watchTask(s, 'shared', { origin: { ...GENERAL, channel: 'C0EXAMPLE2' }, shared: true, now: 3_000 })
    const keys = async (from: typeof GENERAL) =>
      (await s.assistantWatchTasks.list(AGENT, { status: ['active', 'waiting'], visibleFrom: from })).map(
        (t) => t.taskKey
      )
    expect(await keys(GENERAL)).toEqual([key('shared', 'C0EXAMPLE2'), key('here')])
    expect(await keys(DM)).toEqual([key('shared', 'C0EXAMPLE2'), key('dm', DM.channel)])
    const url = 'https://github.com/example-org/example-repo/pull/12'
    expect(
      await s.assistantWatchTasks.setWatch(AGENT, key('here'), { url, target: null, state: 'pending', reason: null })
    ).toBe(true)
    expect(await s.assistantWatchTasks.watching(AGENT)).toEqual([{ taskKey: key('here'), url }])
  })

  it('reads a getting-to-know task by its task key too, through the one resolver', async () => {
    const s = await open()
    await watchTask(s, '1')
    const lookKey = key('look-1')
    const look = await s.assistantItems.create({
      agentId: AGENT,
      title: 'Getting to know the channel',
      origin: GENERAL,
      taskKey: lookKey,
      gettingToKnow: 'joined'
    })
    const tasks = new CheckedTasks({ watchTasks: s.assistantWatchTasks, items: s.assistantItems })
    expect(await tasks.get(AGENT, key('1'))).toMatchObject({ gettingToKnow: null, title: 'Watch 1' })
    expect(await tasks.get(AGENT, lookKey)).toMatchObject({ gettingToKnow: 'joined', itemId: look.id })
    await tasks.appendObservation(AGENT, lookKey, { text: 'Read the channel.' })
    expect((await s.assistantItems.get(AGENT, look.id))?.observations.map((o) => o.text)).toEqual(['Read the channel.'])
  })
})

describe('the firing loop reads the task store', () => {
  it('finds a due watch task by its task key, before a getting-to-know task, and re-schedules from it', async () => {
    const s = await open()
    await watchTask(s, '1', { nextAt: 500 })
    await watchTask(s, 'later', { nextAt: 50_000 })
    await s.assistantItems.create({
      agentId: AGENT,
      title: 'Getting to know the channel',
      origin: GENERAL,
      taskKey: key('look-1'),
      gettingToKnow: 'joined',
      nextCheck: 100
    })
    expect(await s.assistantChecks.due(AGENT, 1_000, 10)).toEqual([
      { taskKey: key('1'), nextCheck: 500 },
      { taskKey: key('look-1'), nextCheck: 100 }
    ])
    await s.assistantChecks.begin(AGENT, key('1'), {
      key: key('1'),
      nextCheck: 500,
      observationVersion: 0,
      input: null,
      now: 1_000,
      staleBefore: 0,
      exclusive: true
    })
    await s.assistantChecks.succeed(AGENT, key('1'), key('1'), 1_100)
    expect((await s.assistantChecks.due(AGENT, 1_000, 10)).map((d) => d.taskKey)).toEqual([key('look-1')])
    await s.assistantWatchTasks.schedule(AGENT, key('1'), { status: 'active', nextAt: 2_000 }, 1_200)
    expect((await s.assistantChecks.due(AGENT, 3_000, 10)).map((d) => d.taskKey)).toEqual([key('1'), key('look-1')])
    await s.assistantWatchTasks.schedule(AGENT, key('1'), { status: 'done', nextAt: null }, 1_300)
    expect((await s.assistantChecks.due(AGENT, 3_000, 10)).map((d) => d.taskKey)).toEqual([key('look-1')])
  })
})

describe('a watch task on the board and in listTasks', () => {
  const HERE = { platform: 'slack', channel: GENERAL.channel, transportScope: SCOPE }
  const coordinator = {
    sessionId: 'sid-coordinator',
    key: sessionKey('slack', GENERAL.channel, 'append:c', AGENT, SCOPE)
  }

  it('shows next and its time while it waits, and running during a check', async () => {
    const s = await open()
    await watchTask(s, '1', { nextAt: Date.UTC(2030, 0, 2, 1), title: 'Tell Alice when PR #412 merges' })
    const board = async () =>
      renderWorkBoard(await workBoardView({ stores: s, agentId: AGENT, owner: coordinator, place: HERE }))
    expect((await board()).text).toContain(
      `- follow-up · next 2030-01-02T01:00Z · "Tell Alice when PR #412 merges" · ${key('1')}`
    )
    await s.assistantSubsessions.checking(AGENT, key('1'), 2_000)
    expect((await board()).text).toContain(`- follow-up · running · "Tell Alice when PR #412 merges" · ${key('1')}`)
    expect((await readOpenWork(s, AGENT, coordinator, HERE))[0]).toMatchObject({ changedAt: 2_000, status: 'running' })
  })

  it('lists it on a coordinator’s Here with the board’s status and its last check’s result', async () => {
    const s = await open()
    await watchTask(s, '1', { nextAt: Date.UTC(2030, 0, 2, 1) })
    await s.assistantWatchTasks.appendObservation(AGENT, key('1'), { text: 'PR #412 is open, CI running.', now: 1_500 })
    const tasks = new CheckedTasks({ watchTasks: s.assistantWatchTasks, items: s.assistantItems })
    const deps = {
      assistantSubsessions: {
        actor: () => ({ userId: AGENT, isBot: true }),
        sessionIdOf: async () => coordinator.sessionId,
        find: (agentId: string, id: string) => s.assistantSubsessions.get(agentId, id),
        stopSession: async () => false,
        listForOwner: s.assistantSubsessions.listForOwner.bind(s.assistantSubsessions),
        coordinatorOf: async () => coordinator,
        board: async () => await workBoardView({ stores: s, agentId: AGENT, owner: coordinator, place: HERE }),
        followUps: {
          own: async () => true,
          get: (agentId: string, taskKey: string) => tasks.get(agentId, taskKey),
          stop: async () => 'stopped' as const,
          reported: async () => false
        },
        now: () => 2_000
      }
    } as unknown as OpsDeps
    const ctx: SessionContext = {
      agentId: AGENT,
      platform: 'slack',
      integrationId: 'int-1',
      transportScope: SCOPE,
      isDm: false,
      channel: GENERAL.channel,
      thread: 'append:c',
      deliveryThread: '1700000000.000100',
      tools: [LIST_TASKS_TOOL]
    }
    const listed = (await executeTool(ctx, 'listTasks', {}, deps)) as any
    expect(listed.here).toEqual([
      expect.objectContaining({
        taskId: key('1'),
        kind: 'follow-up',
        title: 'Watch 1',
        state: 'waiting',
        status: 'next 2030-01-02T01:00Z',
        nextCheck: '2030-01-02T01:00:00.000Z',
        summary: 'PR #412 is open, CI running.',
        summaryUpdatedAt: new Date(1_500).toISOString()
      })
    ])
  })
})

describe('updateTask on a watch task', () => {
  const checkCtx = (id: string): SessionContext => ({
    agentId: AGENT,
    platform: 'slack',
    integrationId: 'int-1',
    transportScope: SCOPE,
    isDm: false,
    channel: GENERAL.channel,
    thread: `subsession:check-${id}`,
    deliveryThread: '1700000000.000100',
    tools: [UPDATE_TASK_TOOL]
  })
  const deps = (s: LocalStore) =>
    ({
      assistantSubsessions: {
        setSummary: s.assistantSubsessions.setSummary.bind(s.assistantSubsessions),
        now: () => 5_000
      }
    }) as unknown as OpsDeps

  it('renames it from its own check, which moves it on the board, and is refused to a getting-to-know task', async () => {
    const s = await open()
    await watchTask(s, '1')
    expect(checkTools([]).map((tool) => tool.name)).toContain('updateTask')
    expect(
      await executeTool(
        checkCtx('1'),
        'updateTask',
        { summary: 'Now watching the hotfix too.', title: 'Watch the hotfix' },
        deps(s)
      )
    ).toMatchObject({ result: 'updated', title: 'Watch the hotfix' })
    expect(await s.assistantWatchTasks.get(AGENT, key('1'))).toMatchObject({
      title: 'Watch the hotfix',
      changedAt: 5_000
    })
    await s.assistantItems.create({
      agentId: AGENT,
      title: 'Getting to know the channel',
      origin: GENERAL,
      taskKey: key('look-1'),
      gettingToKnow: 'joined'
    })
    expect(await executeTool(checkCtx('look-1'), 'updateTask', { summary: 'x' }, deps(s))).toMatchObject({
      result: 'refused'
    })
  })
})

describe('the prompts name one kind of task with two modes', () => {
  it('tells the coordinator about work and watch, and a check how to rename what it watches', () => {
    const prompt = coordinatorPrompt({ agentName: 'Example', platform: 'Slack', channelId: 'C0EXAMPLE1', peers: [] })
    expect(prompt).toContain(
      'A task runs in one of two modes: work, which does what it is given, or watch, a follow-up'
    )
    expect(prompt).toContain('"next" and the time of its next check, or "running" while a check runs')
    const check = checkPrompt(
      {
        taskKey: key('1'),
        title: 'Watch the deploy',
        doneWhen: null,
        background: 'Alice asked.',
        summary: '',
        observations: [],
        watch: null
      } as never,
      undefined
    )
    expect(check).toContain('Background: Alice asked.')
    expect(check).toContain('When a message changed what it watches, first rename it with updateTask')
  })
})

/** The v73 shape of what v74 moves: the task index by kind, follow-ups in the item ledger, checks by item id. */
const V73_RESHAPE = [
  "ALTER TABLE assistant_subsession ADD COLUMN kind TEXT NOT NULL DEFAULT 'delegation'",
  'ALTER TABLE assistant_subsession DROP COLUMN mode',
  ...WATCH_TASK_COLUMN_TYPES.map(([column]) => `ALTER TABLE assistant_subsession DROP COLUMN ${column}`),
  'DROP TABLE assistant_task_observation',
  'ALTER TABLE assistant_check_state RENAME COLUMN taskKey TO itemId',
  'ALTER TABLE assistant_check RENAME COLUMN taskKey TO itemId',
  ...['watchUrl', 'watchTarget', 'watchState', 'watchReason', 'watchRepoId'].map(
    (column) => `ALTER TABLE assistant_item ADD COLUMN ${column} TEXT`
  )
]

const ITEM = `INSERT INTO assistant_item (id, agentId, title, doneWhen, nextCheck, status, originPlatform, originChannel,
    originTransportScope, taskKey, asker, shared, replyThread, gettingToKnow, watchUrl, watchTarget, watchState,
    watchReason, watchRepoId, summary, observationVersion, version, createdAt, updatedAt, changedAt)
  VALUES (?, ?, ?, ?, ?, ?, 'slack', 'C0EXAMPLE1', 'T0EXAMPLE', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 500, 2000, ?)`
const ROW = `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, kind, changedAt)
  VALUES (?, ?, 'sid-place', ?, ?, 500, ?, ?)`
const PR = 'https://github.com/example-org/example-repo/pull/12'

/** What a v73 daemon left: follow-ups open, ended and unindexed, a getting-to-know task, a delegation, their checks, and a place session. */
const V73_ROWS: [string, unknown[]][] = [
  [
    ITEM,
    [
      'item-fu',
      AGENT,
      'Watch the release',
      'It is out',
      90_000,
      'active',
      key('fu'),
      ALICE,
      1,
      '100.1',
      null,
      PR,
      'example-org/example-repo#12',
      'watching',
      '42',
      'Alice asked.',
      2,
      3,
      2_500
    ]
  ],
  [
    ITEM,
    [
      'item-done',
      AGENT,
      'Rotate the key',
      null,
      null,
      'done',
      key('done'),
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      '',
      0,
      1,
      2_000
    ]
  ],
  [
    ITEM,
    [
      'item-bare',
      AGENT,
      'Watch the docs',
      null,
      null,
      'waiting',
      key('bare'),
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      '',
      0,
      1,
      2_000
    ]
  ],
  [
    ITEM,
    [
      'item-look',
      AGENT,
      'Getting to know the channel',
      null,
      50_000,
      'active',
      key('look-1'),
      null,
      0,
      null,
      'joined',
      null,
      null,
      null,
      null,
      '',
      0,
      1,
      2_000
    ]
  ],
  ...[1, 2].map((v): [string, unknown[]] => [
    `INSERT INTO assistant_item_observation (itemId, agentId, observationVersion, text, author, observedAt)
     VALUES ('item-fu', ?, ?, ?, 'check', ?)`,
    [AGENT, v, `seen ${v}`, v * 1_000]
  ]),
  [ROW, [AGENT, key('fu'), PLACE_KEY, 'done', 'follow-up', 3_000]],
  [ROW, [AGENT, key('done'), PLACE_KEY, 'done', 'follow-up', 3_000]],
  [ROW, [AGENT, key('look-1'), PLACE_KEY, 'done', 'follow-up', 3_000]],
  [
    ROW,
    [AGENT, sessionKey('slack', 'C0EXAMPLE1', 'subsession:del-1', AGENT, SCOPE), PLACE_KEY, 'open', 'delegation', 3_000]
  ],
  [
    `INSERT INTO assistant_check_state (agentId, itemId, checkedNextCheck, failures, stopped, updatedAt)
     VALUES (?, 'item-fu', 80000, 1, 0, 3000)`,
    [AGENT]
  ],
  [
    `INSERT INTO assistant_check_state (agentId, itemId, failures, stopped, updatedAt) VALUES (?, 'item-look', 0, 0, 3000)`,
    [AGENT]
  ],
  [
    `INSERT INTO assistant_check_state (agentId, itemId, failures, stopped, updatedAt) VALUES (?, 'item-gone', 0, 0, 3000)`,
    [AGENT]
  ],
  [
    `INSERT INTO assistant_check (agentId, itemId, checkNo, startedAt, endedAt, observation, reported)
     VALUES (?, 'item-fu', 1, 1000, 1100, 'seen 1', 0)`,
    [AGENT]
  ],
  [
    `INSERT INTO append_reservation (agentId, channel, transportScope, coordinate, updatedAt) VALUES (?, 'C0EXAMPLE1', 'T0EXAMPLE', 'append:1', 1)`,
    [AGENT]
  ],
  [
    `INSERT INTO sessions (key, agentId, platform, channel, thread, transportScope, sessionId, state, updatedAt)
     VALUES (?, ?, 'slack', 'C0EXAMPLE1', 'append:1', 'T0EXAMPLE', 'sid-place', 'idle', 1)`,
    [PLACE_KEY, AGENT]
  ]
]

/** A proposal of the follow-up's check and a follow-up form an approval took, both naming the item by its id, as v73 wrote them. */
async function seedProposals(s: LocalStore): Promise<string> {
  const draft = await s.assistantDrafts.createTask({
    agentId: AGENT,
    target: { platform: 'slack', integrationId: 'int-1', channel: 'C0EXAMPLE1', thread: null },
    task: 'Rebase PR #12 onto main and push.',
    sentence: 'I want to rebase PR #12.',
    why: 'It conflicts with main.',
    itemId: 'item-fu',
    itemVersion: 3,
    source: {
      platform: 'slack',
      integrationId: 'int-1',
      channel: 'C0EXAMPLE1',
      thread: 'subsession:check-fu',
      transportScope: SCOPE,
      sessionKey: key('fu'),
      sessionId: null,
      place: false
    },
    now: 1_000
  })
  return draft.id
}

/** After v74: the follow-ups are watch tasks keyed by their task key, the getting-to-know task stays an item, and every reference follows. */
async function expectMigrated(s: LocalStore, draftId: string): Promise<void> {
  expect((await s.assistantItems.list(AGENT)).map((i) => [i.id, i.taskKey])).toEqual([['item-look', key('look-1')]])
  const fu = await s.assistantWatchTasks.get(AGENT, key('fu'))
  expect(fu).toMatchObject({
    title: 'Watch the release',
    doneWhen: 'It is out',
    nextAt: 90_000,
    status: 'active',
    origin: GENERAL,
    owner: { sessionId: 'sid-place', key: PLACE_KEY },
    asker: ALICE,
    shared: true,
    replyThread: '100.1',
    watch: { url: PR, target: 'example-org/example-repo#12', state: 'watching', reason: null, repoId: '42' },
    background: 'Alice asked.',
    summary: 'seen 2',
    summaryUpdatedAt: 2_000,
    observationVersion: 2,
    version: 3,
    changedAt: 2_500
  })
  expect(fu!.observations.map((o) => o.text)).toEqual(['seen 1', 'seen 2'])
  expect(await s.assistantWatchTasks.get(AGENT, key('done'))).toMatchObject({ status: 'done' })
  // One no index row named gets one under its place's session.
  expect(await s.assistantWatchTasks.get(AGENT, key('bare'))).toMatchObject({
    status: 'waiting',
    owner: { sessionId: 'sid-place', key: PLACE_KEY }
  })
  expect(await s.assistantSubsessions.get(AGENT, key('look-1'))).toMatchObject({ mode: 'watch', place: GENERAL })
  expect(
    await s.assistantSubsessions.get(AGENT, sessionKey('slack', 'C0EXAMPLE1', 'subsession:del-1', AGENT, SCOPE))
  ).not.toHaveProperty('mode')
  expect(await s.assistantChecks.get(AGENT, key('fu'))).toMatchObject({ checkedNextCheck: 80_000, failures: 1 })
  expect(await s.assistantChecks.get(AGENT, key('look-1'))).toBeDefined()
  expect(await s.assistantChecks.get(AGENT, 'item-fu')).toBeUndefined()
  expect(await s.assistantChecks.get(AGENT, 'item-gone')).toBeUndefined()
  expect(await s.assistantChecks.checks(AGENT, key('fu'), 5)).toEqual([
    expect.objectContaining({ taskKey: key('fu'), checkNo: 1, observation: 'seen 1' })
  ])
  expect((await s.assistantDrafts.get(draftId))?.proposal).toMatchObject({ itemId: key('fu'), tookItemId: key('fu') })
  expect(await s.assistantChecks.due(AGENT, 100_000, 10)).toEqual([
    { taskKey: key('fu'), nextCheck: 90_000 },
    { taskKey: key('look-1'), nextCheck: 50_000 }
  ])
}

describe.skipIf(usingPostgresStore())('the v73 → v74 watch tasks on SQLite', () => {
  it('moves every follow-up into its task row under its task key, and keys its checks and proposals by it', async () => {
    const path = tempStorePath('ac-watch-v73-')
    const fresh = await LocalStore.open(path)
    const draftId = await seedProposals(fresh)
    await fresh.close()
    const old = new DatabaseSync(path)
    old.exec(`${V73_RESHAPE.join('; ')}; PRAGMA user_version = 73`)
    for (const [sql, params] of V73_ROWS) old.prepare(sql).run(...(params as never[]))
    old.exec("UPDATE assistant_draft SET tookItemId = 'item-fu'")
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      await expectMigrated(upgraded, draftId)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    try {
      expect(columns('assistant_subsession')).toEqual(expect.arrayContaining(['mode', 'nextAt', 'watchStatus']))
      expect(columns('assistant_subsession')).not.toContain('kind')
      expect(columns('assistant_item')).not.toContain('watchUrl')
      expect(columns('assistant_check_state')).toContain('taskKey')
      expect(columns('assistant_check')).not.toContain('itemId')
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})

/** `?` placeholders as PostgreSQL's numbered ones. */
const numbered = (sql: string): string => {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

describe.skipIf(!usingPostgresStore())('the v73 → v74 watch tasks on PostgreSQL', () => {
  it('moves every follow-up into its task row under its task key, and keys its checks and proposals by it', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      const draftId = await seedProposals(first)
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      for (const sql of V73_RESHAPE) await admin.query(sql)
      for (const [sql, params] of V73_ROWS) await admin.query(numbered(sql), params)
      await admin.query("UPDATE assistant_draft SET tookItemId = 'item-fu'")
      await admin.query('UPDATE _local_store_schema_version SET version = 73 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        await expectMigrated(upgraded, draftId)
      } finally {
        await upgraded.close()
      }
      const columns = async (table: string) =>
        (
          await admin.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
            [schema, table]
          )
        ).rows.map((row: { column_name: string }) => row.column_name)
      expect(await columns('assistant_subsession')).not.toContain('kind')
      expect(await columns('assistant_item')).not.toContain('watchurl')
      expect(await columns('assistant_check_state')).toContain('taskkey')
      const version = await admin.query('SELECT version FROM _local_store_schema_version')
      expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })
})
