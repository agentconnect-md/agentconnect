// What a follow-up watches (assistant-mode.md §5.14): the daemon keeps the URL and the outcome on its watch task, and the Control Plane mirrors them by its task key.
import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantFollowUpWatchReq, AssistantFollowUpWatchResult } from '@agentconnect.md/protocol'
import { FollowUpWatches } from '../src/assistant/follow-up-watches.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-watches'
const PR = 'https://github.com/example-org/example-repo/pull/12'
const ISSUE = 'https://github.com/example-org/example-repo/issues/7'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** A Control Plane that answers with `answer`, records each request, and is reachable while `link` is set. */
async function setup() {
  store = await openTestStore()
  const s = store
  const requests: Array<Pick<AssistantFollowUpWatchReq, 'mode' | 'watches'>> = []
  const cp: {
    link: number | undefined
    fullGate?: Promise<void>
    answer: (req: Pick<AssistantFollowUpWatchReq, 'mode' | 'watches'>) => AssistantFollowUpWatchResult | undefined
  } = {
    link: 1,
    answer: (req) => ({
      results: req.watches.map((watch) => ({
        followUpId: watch.followUpId,
        ...(watch.target
          ? {
              watched: {
                provider: watch.target.provider,
                repoPath: watch.target.repoPath,
                subject: watch.target.subject,
                number: watch.target.number
              }
            }
          : {})
      }))
    })
  }
  const watches = new FollowUpWatches({
    watchTasks: s.assistantWatchTasks,
    port: {
      request: async (_agentId, req) => {
        requests.push(req)
        if (cp.link === undefined) throw new Error('control plane unreachable')
        if (req.mode === 'full' && cp.fullGate) await cp.fullGate
        return cp.answer(req)
      },
      link: () => cp.link
    },
    log: { warn: () => {} }
  })
  const item = async (title: string) =>
    await s.assistantWatchTasks.open({
      agentId: AGENT,
      title,
      doneWhen: 'It merged',
      origin: { platform: 'slack', channel: 'C0EXAMPLE', transportScope: null },
      owner: { sessionId: 'sid-owner', key: `slack:C0EXAMPLE:append:1:${AGENT}` },
      taskKey: `slack:C0EXAMPLE:subsession:check-${title}:${AGENT}`
    })
  return { s, cp, watches, requests, item }
}

describe('a follow-up’s watch', () => {
  it('keeps what the Control Plane took, refused, or could not answer', async () => {
    const { s, cp, watches, item } = await setup()
    const one = await item('one')
    expect(await watches.set(AGENT, one.taskKey, PR)).toEqual({
      kind: 'watching',
      target: 'example-org/example-repo#12'
    })

    cp.answer = (req) => ({ results: [{ followUpId: req.watches[0]!.followUpId, refused: 'no_access' }] })
    const two = await item('two')
    expect(await watches.set(AGENT, two.taskKey, ISSUE)).toEqual({
      kind: 'refused',
      reason: 'your code-host access does not cover it'
    })

    cp.link = undefined
    const three = await item('three')
    expect(await watches.set(AGENT, three.taskKey, ISSUE)).toEqual({ kind: 'pending' })
    expect((await s.assistantWatchTasks.get(AGENT, three.taskKey))?.watch).toEqual({
      url: ISSUE,
      target: null,
      state: 'pending',
      reason: null,
      repoId: null
    })
  })

  it('sends an agent’s whole set once per link, the pending ones included, and the refused ones left out', async () => {
    const { s, cp, watches, requests, item } = await setup()
    const watched = await item('watched')
    const pending = await item('pending')
    const refused = await item('refused')
    await s.assistantWatchTasks.setWatch(AGENT, watched.taskKey, {
      url: PR,
      target: 'x',
      state: 'watching',
      reason: null
    })
    await s.assistantWatchTasks.setWatch(AGENT, pending.taskKey, {
      url: ISSUE,
      target: null,
      state: 'pending',
      reason: null
    })
    await s.assistantWatchTasks.setWatch(AGENT, refused.taskKey, {
      url: PR,
      target: null,
      state: 'refused',
      reason: 'limit'
    })

    await watches.sync(AGENT)
    await watches.sync(AGENT)
    expect(requests.map((req) => [req.mode, req.watches.map((watch) => watch.followUpId).sort()])).toEqual([
      ['full', [watched.taskKey, pending.taskKey].sort()]
    ])
    expect((await s.assistantWatchTasks.get(AGENT, pending.taskKey))?.watch).toMatchObject({
      state: 'watching',
      target: 'example-org/example-repo#7'
    })

    cp.link = 2
    await watches.sync(AGENT)
    expect(requests).toHaveLength(2)
  })

  it('lets a full set’s late answer overwrite no change made after it', async () => {
    const { s, cp, watches, requests, item } = await setup()
    const one = await item('one')
    await s.assistantWatchTasks.setWatch(AGENT, one.taskKey, { url: PR, target: null, state: 'pending', reason: null })
    let release!: () => void
    cp.fullGate = new Promise<void>((resolve) => (release = resolve))
    const slow = watches.sync(AGENT)
    // The move is asked for while the full set's answer is still on its way, and waits behind it.
    const moved = watches.set(AGENT, one.taskKey, ISSUE)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests.map((req) => req.mode)).toEqual(['full'])
    release()
    await Promise.all([slow, moved])
    expect(requests.map((req) => req.mode)).toEqual(['full', 'set'])
    expect((await s.assistantWatchTasks.get(AGENT, one.taskKey))?.watch).toMatchObject({
      url: ISSUE,
      target: 'example-org/example-repo#7'
    })
  })

  it('sends the full set again on the next sweep while a watch waits for an answer', async () => {
    const { s, cp, watches, requests, item } = await setup()
    const one = await item('one')
    await s.assistantWatchTasks.setWatch(AGENT, one.taskKey, { url: PR, target: null, state: 'pending', reason: null })
    cp.answer = (req) => ({
      results: req.watches.map((watch) => ({ followUpId: watch.followUpId, refused: 'unavailable' as const }))
    })
    await watches.sync(AGENT)
    await watches.sync(AGENT)
    expect(requests.map((req) => req.mode)).toEqual(['full', 'full'])
    expect((await s.assistantWatchTasks.get(AGENT, one.taskKey))?.watch?.state).toBe('pending')
  })

  it('stops watching an open follow-up, and drops an ended one’s subscription', async () => {
    const { s, watches, requests, item } = await setup()
    const one = await item('one')
    await watches.set(AGENT, one.taskKey, PR)
    expect(await watches.clear(AGENT, one.taskKey)).toEqual({ kind: 'none' })
    expect((await s.assistantWatchTasks.get(AGENT, one.taskKey))?.watch).toBeNull()
    expect(requests.map((req) => req.mode)).toEqual(['set', 'remove'])
  })
})
