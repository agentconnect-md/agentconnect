// What a follow-up watches (assistant-mode.md §5.14): the daemon keeps the URL and the outcome, and the Control Plane mirrors them.
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
    items: s.assistantItems,
    port: {
      request: async (_agentId, req) => {
        requests.push(req)
        if (cp.link === undefined) throw new Error('control plane unreachable')
        return cp.answer(req)
      },
      link: () => cp.link
    },
    log: { warn: () => {} }
  })
  const item = async (title: string) =>
    await s.assistantItems.create({
      agentId: AGENT,
      title,
      doneWhen: 'It merged',
      status: 'waiting',
      origin: { platform: 'slack', channel: 'C0EXAMPLE', transportScope: null },
      taskKey: `slack:C0EXAMPLE:subsession:check-${title}:${AGENT}`
    })
  return { s, cp, watches, requests, item }
}

describe('a follow-up’s watch', () => {
  it('keeps what the Control Plane took, refused, or could not answer', async () => {
    const { s, cp, watches, item } = await setup()
    const one = await item('one')
    expect(await watches.set(AGENT, one.id, PR)).toEqual({ kind: 'watching', target: 'example-org/example-repo#12' })

    cp.answer = (req) => ({ results: [{ followUpId: req.watches[0]!.followUpId, refused: 'no_access' }] })
    const two = await item('two')
    expect(await watches.set(AGENT, two.id, ISSUE)).toEqual({
      kind: 'refused',
      reason: 'your code-host access does not cover it'
    })

    cp.link = undefined
    const three = await item('three')
    expect(await watches.set(AGENT, three.id, ISSUE)).toEqual({ kind: 'pending' })
    expect((await s.assistantItems.get(AGENT, three.id))?.watch).toEqual({
      url: ISSUE,
      target: null,
      state: 'pending',
      reason: null
    })
  })

  it('sends an agent’s whole set once per link, the pending ones included, and the refused ones left out', async () => {
    const { s, cp, watches, requests, item } = await setup()
    const watched = await item('watched')
    const pending = await item('pending')
    const refused = await item('refused')
    await s.assistantItems.setWatch(AGENT, watched.id, { url: PR, target: 'x', state: 'watching', reason: null })
    await s.assistantItems.setWatch(AGENT, pending.id, { url: ISSUE, target: null, state: 'pending', reason: null })
    await s.assistantItems.setWatch(AGENT, refused.id, { url: PR, target: null, state: 'refused', reason: 'limit' })

    await watches.sync(AGENT)
    await watches.sync(AGENT)
    expect(requests.map((req) => [req.mode, req.watches.map((watch) => watch.followUpId).sort()])).toEqual([
      ['full', [watched.id, pending.id].sort()]
    ])
    expect((await s.assistantItems.get(AGENT, pending.id))?.watch).toMatchObject({
      state: 'watching',
      target: 'example-org/example-repo#7'
    })

    cp.link = 2
    await watches.sync(AGENT)
    expect(requests).toHaveLength(2)
  })

  it('stops watching an open follow-up, and drops an ended one’s subscription', async () => {
    const { s, watches, requests, item } = await setup()
    const one = await item('one')
    await watches.set(AGENT, one.id, PR)
    expect(await watches.clear(AGENT, one.id)).toEqual({ kind: 'none' })
    expect((await s.assistantItems.get(AGENT, one.id))?.watch).toBeNull()
    expect(requests.map((req) => req.mode)).toEqual(['set', 'remove'])
  })
})
