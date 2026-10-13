// A schedule's or hook's configured target counts as consent: the bot joins it without asking, and nothing else (#2979).
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { markNotJoined } from '../src/platforms/not-joined.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-1'
const INT = 'int-s'
const TARGET = 'C-TARGET'

const notIn = (channel: string): Error => markNotJoined(new Error('An API error occurred: not_in_channel'), channel)

/** A daemon whose Slack bot is in no channel until it joins one. */
async function world() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'talk',
    integrations: [
      {
        id: INT,
        platform: 'slack',
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          gated: false,
          sessionModes: [],
          externalChannels: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: { botToken: 'x', appToken: 'y' }
      }
    ]
  })
  const joined = new Set<string>()
  const conn = {
    postMessage: vi.fn(async (channel: string) => {
      if (!joined.has(channel)) throw notIn(channel)
      return '1700000000.000100'
    }),
    getChannelHistory: vi.fn(async (channel: string) => {
      if (!joined.has(channel)) throw notIn(channel)
      return { messages: [], hasMore: false }
    }),
    joinChannel: vi.fn(async (channel: string) => void joined.add(channel)),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: id === TARGET ? 'target' : 'other', isPrivate: false })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  daemon.connByIntegration.set(INT, conn)
  const dispatch = vi.fn(async () => 'acp-1')
  daemon.dispatch = dispatch
  const run = (source: 'cron' | 'hook'): NormalizedMessage =>
    ({
      msgId: `${source}:1`,
      traceId: `${source}:1`,
      source,
      platform: 'slack',
      channel: TARGET,
      sender: { id: source, isBot: true },
      text: 'post the weekly digest',
      mentionedBots: [],
      isDm: false
    }) as NormalizedMessage
  return { daemon, store, conn, dispatch, run }
}

describe('a run posting into the target an editor configured', () => {
  it('joins a schedule’s public target the bot is not in, and posts there with no card', async () => {
    const w = await world()
    await w.daemon.onCronFire(AGENT, w.run('cron'), {
      id: 'weekly',
      trigger: 'post the weekly digest',
      schedule: '0 9 * * 1',
      target: { channel: TARGET, integrationId: INT }
    })
    expect(w.conn.joinChannel).toHaveBeenCalledWith(TARGET)
    expect(w.conn.postMessage).toHaveBeenCalledTimes(2)
    expect(w.conn.postMessage.mock.calls[1]![0]).toBe(TARGET)
    // The run itself goes on in its target, and no one was asked.
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect((w.dispatch.mock.calls[0] as unknown as [string, { channel: string }])[1].channel).toBe(TARGET)
    expect(await w.store.listPermissionRequests(AGENT)).toEqual([])
    await w.store.close()
  })

  it('joins a hook’s public target the same way', async () => {
    const w = await world()
    const anchored = await w.daemon
      .githubReviewHost()
      .anchorTrigger(
        AGENT,
        w.run('hook'),
        { channel: TARGET, integrationId: INT },
        'A pull request opened',
        'hook "h1"'
      )
    expect(w.conn.joinChannel).toHaveBeenCalledWith(TARGET)
    expect(anchored).toMatchObject({ postAttempted: true, message: { channel: TARGET } })
    expect(await w.store.listPermissionRequests(AGENT)).toEqual([])
    await w.store.close()
  })

  it('still asks, or fails, for any other channel the run reaches', async () => {
    const w = await world()
    await w.daemon.onCronFire(AGENT, w.run('cron'), {
      id: 'weekly',
      trigger: 'post the weekly digest',
      schedule: '0 9 * * 1',
      target: { channel: TARGET, integrationId: INT }
    })
    const ctx = {
      agentId: AGENT,
      platform: 'slack',
      integrationId: INT,
      isDm: false,
      channel: TARGET,
      thread: '1700000000.000100',
      deliveryThread: '1700000000.000100',
      tools: [],
      integrations: [{ id: INT, platform: 'slack' }]
    } as SessionContext
    // The schedule's own turn has no person behind it, so another unjoined channel is refused, never joined.
    const deps = {
      gatewayFor: () => w.conn,
      readAskers: async () => ({ people: [], nobody: true }),
      confirmJoin: vi.fn()
    } as unknown as OpsDeps
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-OTHER' }, deps)).rejects.toThrow(
      /the bot is not in #other; invite it, or ask from a conversation/
    )
    expect(w.conn.joinChannel).toHaveBeenCalledTimes(1)
    expect(w.conn.joinChannel).not.toHaveBeenCalledWith('C-OTHER')
    await w.store.close()
  })
})
