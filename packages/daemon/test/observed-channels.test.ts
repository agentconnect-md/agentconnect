import { describe, it, expect } from 'vitest'
import { observedChannelsFor, registerObservedChannels } from '../src/platforms/observed-channels.js'
import { discordObservedChannels } from '../src/platforms/discord/observed-channels.js'
import { linearObservedChannels } from '../src/platforms/linear/observed-channels.js'
import type { ObservedChannelsHost } from '../src/platforms/observed-channels.js'

registerObservedChannels(discordObservedChannels)
registerObservedChannels(linearObservedChannels)

/** A host over fixed scope/name tables. */
const host = (
  scopes: Record<string, { parentId?: string; spaceId?: string }>,
  names: Record<string, string>
): ObservedChannelsHost => ({
  channelScopes: async (ids) => new Map(ids.filter((id) => scopes[id]).map((id) => [id, scopes[id]!])),
  displayNames: async (ids) => new Map(ids.filter((id) => names[id]).map((id) => [id, names[id]!]))
})

describe('observed-channels strategies', () => {
  it('is registered for Discord and Linear only; other platforms pass rows through', () => {
    for (const p of ['telegram', 'feishu', 'slack', 'some-future-platform']) {
      expect(observedChannelsFor(p)).toBeUndefined()
    }
    expect(observedChannelsFor('discord')).toBe(discordObservedChannels)
    expect(observedChannelsFor('linear')).toBe(linearObservedChannels)
  })

  it('Linear folds session history to nothing — a team row comes from the CP or the team report, never a session', async () => {
    const h = host({}, { 'a2f2f0d4-0e33-4c4b-9a4b-4f7a0f1f0001': 'AgentConnect' })
    // The workspace-keyed channel of an issue-less (or pre-team-model) session must not earn a row.
    expect(await linearObservedChannels.collapse(h, [{ id: 'a2f2f0d4-0e33-4c4b-9a4b-4f7a0f1f0001' }])).toEqual([])
    expect(await linearObservedChannels.spaceFor(h, 'a2f2f0d4-0e33-4c4b-9a4b-4f7a0f1f0001')).toBeUndefined()
  })

  it('collapses thread rows onto their enclosing channel, labeled with the guild', async () => {
    const h = host(
      {
        T1: { parentId: 'C1' },
        T2: { parentId: 'C1' },
        C1: { spaceId: 'G1' }
      },
      { C1: '#general', G1: 'My Server' }
    )
    const rows = await discordObservedChannels.collapse(h, [{ id: 'T1', name: 'thread one' }, { id: 'T2' }])
    // Two threads of one channel fold to ONE row, named for the channel, carrying
    // the guild that keeps same-named channels in different servers apart.
    expect(rows).toEqual([{ id: 'C1', name: '#general', spaceId: 'G1', space: 'My Server' }])
  })

  it('resolves the guild through the parent when the thread never recorded one', async () => {
    // The observed thread's own scope has no spaceId; the folded-onto channel's does.
    const h = host({ T1: { parentId: 'C1' }, C1: { spaceId: 'G9' } }, { G9: 'Server Nine' })
    const rows = await discordObservedChannels.collapse(h, [{ id: 'T1', name: 'x' }])
    expect(rows[0]).toMatchObject({ id: 'C1', spaceId: 'G9', space: 'Server Nine' })
  })

  it('spaceFor answers only once the scope recorded a guild', async () => {
    const h = host({ C1: { spaceId: 'G1' } }, { G1: 'My Server' })
    expect(await discordObservedChannels.spaceFor(h, 'C1')).toEqual({ id: 'G1', name: 'My Server' })
    expect(await discordObservedChannels.spaceFor(h, 'C2')).toBeUndefined()
  })
})
