// A hook's or schedule's target in a Google Chat Space is anchored, and its session keys on the thread Google put the anchor in (#4054).
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'agent-1'
const INT = 'int-gc'
const SPACE = 'spaces/AAAA'
const POST = `${SPACE}/messages/client-1`
const THREAD = `${SPACE}/threads/T1`

async function world(opts: { dm?: boolean } = {}) {
  const daemon: any = new Daemon({ sandboxMechanism: null })
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'talk',
    integrations: [
      {
        id: INT,
        platform: 'googlechat',
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          gated: false,
          sessionModes: [],
          externalChannels: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: {}
      }
    ]
  })
  // The gateway shape the send tool posts through: a post answers its message name, and the thread is asked for apart.
  const conn = {
    postMessage: vi.fn(async () => POST),
    threadOfPost: vi.fn((name: string) => (name === POST ? THREAD : undefined)),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: opts.dm ?? false })),
    listMembers: vi.fn(async () => [])
  }
  daemon.gcConnByIntegration.set(INT, conn)
  const hook = {
    msgId: 'hook:1',
    traceId: 'hook:1',
    source: 'hook',
    platform: 'googlechat',
    channel: SPACE,
    thread: 'h1:delivery-1',
    sender: { id: 'hook', isBot: true },
    text: 'summarize the alert',
    mentionedBots: [],
    isDm: false
  } as NormalizedMessage
  return { daemon, store, conn, hook }
}

describe('a trigger anchored into a Google Chat target', () => {
  it('posts the anchor into the Space and keys the session on the thread Google reports', async () => {
    const w = await world()
    const anchored = await w.daemon
      .githubReviewHost()
      .anchorTrigger(AGENT, w.hook, { channel: SPACE, integrationId: INT }, 'An alert fired', 'hook "h1"')
    expect(w.conn.postMessage).toHaveBeenCalledWith(SPACE, 'An alert fired')
    expect(anchored).toMatchObject({
      postAttempted: true,
      message: { channel: SPACE, thread: THREAD, transcriptTs: POST }
    })
    await w.store.close()
  })

  it('keys a direct message on its Space, as a reply there resolves', async () => {
    const w = await world({ dm: true })
    const anchored = await w.daemon
      .githubReviewHost()
      .anchorTrigger(AGENT, w.hook, { channel: SPACE, integrationId: INT }, 'An alert fired', 'hook "h1"')
    expect(anchored).toMatchObject({ postAttempted: true, message: { channel: SPACE, thread: SPACE, isDm: true } })
    await w.store.close()
  })
})
