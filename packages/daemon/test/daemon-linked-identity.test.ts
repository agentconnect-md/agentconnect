// A person's linked chat account is asked of a Control Plane that advertises read-access-linked-v1; an older one leaves the console to decide.
import { describe, expect, it, vi } from 'vitest'
import {
  READ_ACCESS_LINKED_V1_FEATURE,
  READ_ACCESS_V1_FEATURE,
  type AgentReadAccess,
  type AgentReadAccessOk
} from '@agentconnect.md/protocol'
import {
  askerMayRead,
  readRefusal,
  type ReadAsker,
  type ReadLookups,
  type SourcePlace
} from '../src/assistant/place-access.js'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-a'
const LARK_BOT = '33333333-3333-4333-8333-333333333333'
const SLACK_BOT = '44444444-4444-4444-8444-444444444444'
const BOTH = [READ_ACCESS_V1_FEATURE, READ_ACCESS_LINKED_V1_FEATURE]
const CONSOLE_P: ReadAsker = { kind: 'console', userId: 'user-p' }
// A Feishu group the console shows user-p the agent's session in.
const GROUP: SourcePlace = {
  platform: 'feishu',
  channel: 'oc_group',
  kind: 'channel',
  private: true,
  sessions: ['ses-1']
}

function daemonWith(features: string[], reply: Partial<AgentReadAccessOk>, fails = false) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const readAccess = vi.fn(async (payload: AgentReadAccess): Promise<AgentReadAccessOk> => {
    if (fails && payload.linkedOn) throw new Error('read access lookup failed')
    return { asker: 'linked', visibleSessionIds: ['ses-1'], consoleUserId: 'user-p', ...reply }
  })
  daemon.cpClient = { supportsServerFeature: (feature: string) => features.includes(feature), readAccess }
  return { lookups: daemon.placeMembers.lookupsFor(AGENT) as ReadLookups, readAccess }
}

const judged = (lookups: ReadLookups, source: SourcePlace = GROUP) =>
  readRefusal(source, { people: [CONSOLE_P], nobody: false }, (a) => askerMayRead(a, source, LARK_BOT, lookups), false)

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

  it('leaves the console to decide on a Control Plane without the feature, as before', async () => {
    const older = daemonWith([READ_ACCESS_V1_FEATURE], {})
    expect(await older.lookups.linked(LARK_BOT, CONSOLE_P)).toBeNull()
    // The console shows the session, so the read is allowed; a session it does not show stays closed.
    expect(await judged(older.lookups)).toBeUndefined()
    expect(await judged(older.lookups, { ...GROUP, sessions: ['ses-2'] })).toBe('private')
    expect(older.readAccess.mock.calls.every((call) => call[0].linkedOn === undefined)).toBe(true)
  })

  it('refuses when a Control Plane that advertises the feature answers without the field, or fails', async () => {
    for (const cp of [daemonWith(BOTH, {}), daemonWith(BOTH, { linkedMemberId: 'on_p' }, true)]) {
      await expect(cp.lookups.linked(LARK_BOT, CONSOLE_P)).rejects.toThrow()
      // Even where the console would show the session.
      expect(await judged(cp.lookups)).toBe('private')
    }
  })
})
