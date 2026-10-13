// A console user's linked chat account is asked of the Control Plane only behind read-access-linked-v1, and fails closed without it.
import { describe, expect, it, vi } from 'vitest'
import {
  READ_ACCESS_LINKED_V1_FEATURE,
  READ_ACCESS_V1_FEATURE,
  type AgentReadAccess,
  type AgentReadAccessOk
} from '@agentconnect.md/protocol'
import type { ReadLookups } from '../src/assistant/place-access.js'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-a'
const BOT = '33333333-3333-4333-8333-333333333333'
const BOTH = [READ_ACCESS_V1_FEATURE, READ_ACCESS_LINKED_V1_FEATURE]

function daemonWith(features: string[], reply: Partial<AgentReadAccessOk>) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const readAccess = vi.fn(async (_payload: AgentReadAccess): Promise<AgentReadAccessOk> => ({
    asker: 'linked',
    visibleSessionIds: [],
    consoleUserId: 'user-p',
    ...reply
  }))
  daemon.cpClient = { supportsServerFeature: (feature: string) => features.includes(feature), readAccess }
  return { lookups: daemon.placeMembers.lookupsFor(AGENT) as ReadLookups, readAccess }
}

describe("a console user's linked chat account", () => {
  it('is asked of the Control Plane for that bot, and answers none when they linked nothing there', async () => {
    const linked = daemonWith(BOTH, { linkedMemberId: 'U_P' })
    expect(await linked.lookups.linked(BOT, 'user-p')).toBe('U_P')
    expect(linked.readAccess.mock.calls[0]![0]).toEqual({
      agentId: AGENT,
      asker: { consoleUserId: 'user-p' },
      sessionIds: [],
      linkedOn: BOT
    })
    expect(await daemonWith(BOTH, { linkedMemberId: null }).lookups.linked(BOT, 'user-p')).toBeNull()
  })

  it('fails closed on a Control Plane without the feature, or whose answer lacks the field', async () => {
    const older = daemonWith([READ_ACCESS_V1_FEATURE], { linkedMemberId: 'U_P' })
    await expect(older.lookups.linked(BOT, 'user-p')).rejects.toThrow(/linked identity unavailable/)
    expect(older.readAccess).not.toHaveBeenCalled()
    await expect(daemonWith(BOTH, {}).lookups.linked(BOT, 'user-p')).rejects.toThrow(/linked identity unavailable/)
  })
})
