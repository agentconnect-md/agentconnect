// A person's linked chat account is asked of the Control Plane only behind read-access-linked-v1, and fails closed without it.
import { describe, expect, it, vi } from 'vitest'
import {
  READ_ACCESS_LINKED_V1_FEATURE,
  READ_ACCESS_V1_FEATURE,
  type AgentReadAccess,
  type AgentReadAccessOk
} from '@agentconnect.md/protocol'
import type { ReadAsker, ReadLookups } from '../src/assistant/place-access.js'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-a'
const LARK_BOT = '33333333-3333-4333-8333-333333333333'
const SLACK_BOT = '44444444-4444-4444-8444-444444444444'
const BOTH = [READ_ACCESS_V1_FEATURE, READ_ACCESS_LINKED_V1_FEATURE]
const CONSOLE_P: ReadAsker = { kind: 'console', userId: 'user-p' }

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

describe("a person's linked chat account", () => {
  it('is asked of the Control Plane for that bot, and answers none when they linked nothing there', async () => {
    const linked = daemonWith(BOTH, { linkedMemberId: 'on_p' })
    expect(await linked.lookups.linked(LARK_BOT, CONSOLE_P)).toBe('on_p')
    // A chat member is named by the bot they spoke on, which the Control Plane resolves to their console user.
    const slackMember: ReadAsker = { kind: 'member', platform: 'slack', integrationId: SLACK_BOT, userId: 'U_P' }
    expect(await linked.lookups.linked(LARK_BOT, slackMember)).toBe('on_p')
    expect(linked.readAccess.mock.calls.map((call) => call[0])).toEqual([
      { agentId: AGENT, asker: { consoleUserId: 'user-p' }, sessionIds: [], linkedOn: LARK_BOT },
      { agentId: AGENT, asker: { integrationId: SLACK_BOT, memberId: 'U_P' }, sessionIds: [], linkedOn: LARK_BOT }
    ])
    expect(await daemonWith(BOTH, { linkedMemberId: null }).lookups.linked(LARK_BOT, CONSOLE_P)).toBeNull()
  })

  it('fails closed on a Control Plane without the feature, or whose answer lacks the field', async () => {
    const older = daemonWith([READ_ACCESS_V1_FEATURE], { linkedMemberId: 'on_p' })
    await expect(older.lookups.linked(LARK_BOT, CONSOLE_P)).rejects.toThrow(/linked identity unavailable/)
    expect(older.readAccess).not.toHaveBeenCalled()
    const silent = daemonWith(BOTH, {})
    await expect(silent.lookups.linked(LARK_BOT, CONSOLE_P)).rejects.toThrow(/linked identity unavailable/)
  })
})
