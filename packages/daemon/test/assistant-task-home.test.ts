// auto-session-mode.md §6.9.1: an approved proposal answers in a thread of its place, on its card or on a root the daemon posts.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantTasks, type AssistantTasksHost, type TaskHome } from '../src/assistant/tasks.js'
import type { CheckedTask } from '../src/assistant/checked-tasks.js'
import type { CheckParent } from '../src/assistant/follow-up-checks.js'
import type { CallMeta } from '../src/daemon/turn-types.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { checkCoordinate, isTaskCoordinate } from '../src/session/subsession-coordinate.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { type LocalStore, sessionKey } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const SCOPE = 'T0EXAMPLE'
const CHANNEL = 'C0GENERAL'
const BY = { id: 'user:usr-1', name: 'Grace' }
const CARD = '1700000100.000100'
const ROOT = '1700000200.000200'

const threadKey = (agentId: string, thread: string): string => sessionKey('slack', CHANNEL, thread, agentId, SCOPE)

const parentOf = (agentId: string): CheckParent => ({
  key: threadKey(agentId, 'append:coordinator-1'),
  sessionId: 'sid-coordinator',
  platform: 'slack',
  channel: CHANNEL,
  thread: 'append:coordinator-1',
  transportScope: SCOPE,
  integrationId: 'int-a',
  inherited: {}
})

const ITEM = {
  origin: { platform: 'slack', channel: CHANNEL, transportScope: SCOPE },
  status: 'active',
  gettingToKnow: null,
  title: 'The nightly check',
  doneWhen: null,
  background: '',
  summary: '',
  version: 3
} as unknown as CheckedTask

async function boot(home: (draft: AssistantDraft) => TaskHome | undefined) {
  store = await openTestStore()
  const s = store
  const agentId = `agent-${randomUUID()}`
  const dispatched: { msg: NormalizedMessage; callMeta: CallMeta }[] = []
  const said: { thread: string; text: string }[] = []
  const reported: string[] = []
  const settled: AssistantDraft[] = []
  const host: AssistantTasksHost = {
    now: () => 2_000,
    log: { info: () => {}, warn: () => {} },
    ledger: () => s.assistantDrafts,
    subsessions: s.assistantSubsessions,
    items: { get: async () => ITEM },
    agent: () => ({ name: 'helper' }),
    servesAgent: () => true,
    parentFor: async (id) => parentOf(id),
    dispatch: async (_agentId, msg, _integrationId, callMeta, onAdmission) => {
      dispatched.push({ msg, callMeta })
      onAdmission({ accepted: true })
    },
    settleSubsession: async () => {},
    reportToParent: async (_agentId, _caller, _parent, text) => {
      reported.push(text)
      return true
    },
    settled: async (draft) => void settled.push(draft),
    homeFor: async (draft) => home(draft),
    say: async (_agentId, at, text) => void said.push({ thread: at.thread, text }),
    draining: () => false
  }
  const tasks = new AssistantTasks(host)
  const propose = async (card: { ts: string; thread: string } | undefined) => {
    const draft = await s.assistantDrafts.createTask({
      agentId,
      target: { platform: 'slack', integrationId: 'int-a', channel: CHANNEL, thread: null },
      task: 'Check each finding and name an owner.',
      sentence: 'I want to check the nightly findings because nobody owns them.',
      why: 'Three reports in a row.',
      itemId: 'item-1',
      itemVersion: 3,
      source: {
        platform: 'slack',
        integrationId: 'int-a',
        channel: CHANNEL,
        thread: checkCoordinate('1'),
        transportScope: SCOPE,
        sessionKey: threadKey(agentId, checkCoordinate('1')),
        sessionId: 'sid-check-1',
        place: false
      },
      now: 1_000
    })
    if (card) await s.assistantDrafts.setCard(draft.id, card.ts, card.thread)
    return (await s.assistantDrafts.get(draft.id))!
  }
  return { s, agentId, tasks, dispatched, said, reported, settled, propose }
}

describe('an approved proposal with a home', () => {
  it('opens on its card’s thread in the approval’s transaction and settles from its one turn, with no report', async () => {
    const roots: string[] = []
    const { s, agentId, tasks, dispatched, reported, settled, propose } = await boot((draft) => ({
      ...(draft.cardThread === '' && draft.cardTs ? { card: draft.cardTs } : {}),
      cardRooted: async (by) => {
        roots.push(`card rooted by ${by.name}`)
      },
      postRoot: async () => {
        roots.push('posted')
        return ROOT
      }
    }))
    const draft = await propose({ ts: CARD, thread: '' })
    expect(draft.cardThread).toBe('')
    expect(await tasks.start(draft, BY)).toEqual({ kind: 'started' })

    const key = threadKey(agentId, CARD)
    // No root is posted: the card is the root, and its place hears that it became one.
    expect(roots).toEqual([`card rooted by ${BY.name}`])
    expect(await s.assistantDrafts.get(draft.id)).toMatchObject({ status: 'executing', subsessionKey: key })
    expect(await s.assistantSubsessions.get(agentId, key)).toMatchObject({ state: 'open', replyThread: CARD })
    expect(
      await s.assistantSubsessions.taskOfThread(agentId, {
        platform: 'slack',
        channel: CHANNEL,
        transportScope: SCOPE,
        thread: CARD
      })
    ).toBe(key)
    // It answers in the thread, so no round of it reports to its coordinator.
    expect(await s.assistantSubsessions.reportsRound(agentId, key, 1)).toBe(false)

    expect(dispatched).toHaveLength(1)
    const { msg, callMeta } = dispatched[0]!
    expect(msg).toMatchObject({ channel: CHANNEL, thread: CARD, source: 'agent' })
    expect(msg.headless).toBeUndefined()
    expect(JSON.stringify(msg)).toContain('Your reply posts in this thread')
    expect(callMeta).toMatchObject({ approvedProposal: draft.id, platformOrigin: true })
    expect(callMeta.needsReply).toBeUndefined()

    await s.assistantSubsessions.finish(agentId, key, 'done')
    await tasks.homeTurnEnded({ agentId, key, outcome: 'completed', replayed: false })
    expect(await s.assistantDrafts.get(draft.id)).toMatchObject({ status: 'succeeded', failure: null })
    expect(settled.map((d) => d.status)).toEqual(['succeeded'])
    expect(reported).toEqual([])
  })

  it('wins the decision first, then posts a root, for a card in a thread or one whose thread a task took', async () => {
    const secondRoot = '1700000400.000400'
    const roots = [ROOT, secondRoot]
    const { s, agentId, tasks, dispatched, propose } = await boot((draft) => ({
      ...(draft.cardThread === '' && draft.cardTs ? { card: draft.cardTs } : {}),
      postRoot: async () => roots.shift()
    }))
    const inThread = await propose({ ts: CARD, thread: '1700000050.000050' })
    expect(await tasks.start(inThread, BY)).toEqual({ kind: 'started' })
    expect((await s.assistantDrafts.get(inThread.id))?.subsessionKey).toBe(threadKey(agentId, ROOT))
    expect(dispatched[0]?.msg.thread).toBe(ROOT)

    // Another proposal's card sits at the top level, but a task already holds its thread.
    const other = '1700000300.000300'
    const holder = threadKey(agentId, 'holder')
    await s.assistantSubsessions.open({
      agentId,
      childSessionKey: holder,
      parentSessionId: 'sid',
      parentSessionKey: 'k'
    })
    await s.assistantSubsessions.attachThread({
      agentId,
      childSessionKey: holder,
      platform: 'slack',
      channel: CHANNEL,
      transportScope: SCOPE,
      thread: other,
      sinceRound: 1,
      now: 1_500
    })
    const taken = await propose({ ts: other, thread: '' })
    expect(await tasks.start(taken, BY)).toEqual({ kind: 'started' })
    expect((await s.assistantDrafts.get(taken.id))?.subsessionKey).toBe(threadKey(agentId, secondRoot))
    expect(dispatched[1]?.msg.thread).toBe(secondRoot)
    // The thread under the card still belongs to the task that took it.
    expect(
      await s.assistantSubsessions.taskOfThread(agentId, {
        platform: 'slack',
        channel: CHANNEL,
        transportScope: SCOPE,
        thread: other
      })
    ).toBe(holder)
  })

  it('runs with no home when its root does not post, and denies a second decision', async () => {
    const { s, agentId, tasks, dispatched, propose } = await boot(() => ({ postRoot: async () => undefined }))
    const draft = await propose(undefined)
    expect(await tasks.start(draft, BY)).toEqual({ kind: 'started' })
    const live = await s.assistantDrafts.get(draft.id)
    expect(live?.status).toBe('executing')
    expect(live?.subsessionKey).toContain(':subsession:')
    expect(isTaskCoordinate(dispatched[0]?.msg.thread)).toBe(true)
    expect(dispatched[0]?.callMeta).toMatchObject({ needsReply: true })
    expect(dispatched[0]?.callMeta.approvedProposal).toBeUndefined()
    expect(JSON.stringify(dispatched[0]?.msg)).toContain('Nothing you write here is posted anywhere')
    expect(await tasks.start(draft, BY)).toEqual({ kind: 'lost' })
    expect(await s.assistantSubsessions.list(agentId, 10)).toHaveLength(1)
  })

  it('starts an approval cut before its root posted, with no home, and fails one whose follow-up is gone', async () => {
    const { s, agentId, tasks, dispatched, settled, propose } = await boot(() => undefined)
    const cut = await propose(undefined)
    expect(await s.assistantDrafts.beginTask(cut.id, BY, null, 2_000)).toBe(true)
    await tasks.recover([agentId])
    const live = await s.assistantDrafts.get(cut.id)
    expect(live?.status).toBe('executing')
    expect(isTaskCoordinate(dispatched[0]?.msg.thread)).toBe(true)
    expect(JSON.stringify(dispatched[0]?.msg)).toContain('Grace approved it')
    // It has a session now, so a second sweep leaves it to the run it started.
    await tasks.recover([agentId])
    expect(dispatched).toHaveLength(1)
    expect(settled).toEqual([])
  })

  it('tells the thread once when its turn was cut, and never runs it again', async () => {
    const { s, agentId, tasks, dispatched, said, reported, propose } = await boot((draft) => ({
      ...(draft.cardTs ? { card: draft.cardTs } : {}),
      postRoot: async () => ROOT
    }))
    const draft = await propose({ ts: CARD, thread: '' })
    await tasks.start(draft, BY)
    const key = threadKey(agentId, CARD)
    // A restart: nothing here runs it any more.
    const again = new AssistantTasks((tasks as unknown as { host: AssistantTasksHost }).host)
    await again.cut(agentId, key, { platform: 'slack', channel: CHANNEL, thread: CARD, transportScope: SCOPE })
    expect(await s.assistantDrafts.get(draft.id)).toMatchObject({ status: 'outcome_unknown' })
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({ thread: CARD })
    expect(said[0]?.text).toContain('will not be run again')
    expect(reported).toEqual([])
    expect(dispatched).toHaveLength(1)
  })
})

describe('the record and the index behind a home', () => {
  it('holds the thread and claims in one transaction, or changes nothing', async () => {
    store = await openTestStore()
    const s = store
    const agentId = `agent-${randomUUID()}`
    const at = { platform: 'slack', channel: CHANNEL, transportScope: SCOPE, thread: CARD }
    const row = (key: string) => ({
      agentId,
      childSessionKey: key,
      parentSessionId: 'sid',
      parentSessionKey: 'k',
      now: 1_000
    })
    const first = threadKey(agentId, CARD)
    expect(await s.assistantSubsessions.openClaiming(row(first), at, async () => false)).toBe('refused')
    expect(await s.assistantSubsessions.get(agentId, first)).toBeUndefined()
    expect(await s.assistantSubsessions.taskOfThread(agentId, at)).toBeUndefined()
    expect(await s.assistantSubsessions.openClaiming(row(first), at, async () => true)).toBe('opened')
    expect(await s.assistantSubsessions.taskOfThread(agentId, at)).toBe(first)
    // The thread is another task's, and a key indexed already is not opened twice.
    const second = threadKey(agentId, 'another')
    expect(await s.assistantSubsessions.openClaiming(row(second), at, async () => true)).toBe('held')
    expect(await s.assistantSubsessions.get(agentId, second)).toBeUndefined()
    expect(await s.assistantSubsessions.openClaiming(row(first), undefined, async () => true)).toBe('held')
  })
})
