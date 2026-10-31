// A row's session-mode offer here and the manifest's `appendKinds` the projection reads are one fact; they must agree.

import { describe, expect, it } from 'vitest'
import { manifestFor } from '@agentconnect.md/protocol'
import { channelListSemantics, platformRegistry } from './registry'

describe('session modes against the platform manifest', () => {
  it.each(platformRegistry.ids())('%s offers append exactly where the projection forces it', (id) => {
    const semantics = channelListSemantics(id)
    const kinds = manifestFor(id).appendKinds
    expect((semantics.sessionModes ?? ['createNew', 'append', 'auto']).includes('append'), 'rooms').toBe(
      kinds.includes('channel')
    )
    expect((semantics.dmSessionModes ?? []).includes('append'), 'DMs').toBe(kinds.includes('im'))
    expect((semantics.groupDmSessionModes ?? []).includes('append'), 'group DMs').toBe(kinds.includes('mpim'))
  })

  // Auto's coordinator is a conversation session of the append family (auto-session-mode.md §3.4), offered in rooms and group DMs only.
  it.each(platformRegistry.ids())('%s offers auto in rooms and group DMs exactly where it offers append', (id) => {
    const semantics = channelListSemantics(id)
    const rooms = semantics.sessionModes ?? ['createNew', 'append', 'auto']
    expect(rooms.includes('auto')).toBe(rooms.includes('append'))
    const groups = semantics.groupDmSessionModes ?? []
    expect(groups.includes('auto')).toBe(groups.includes('append'))
    expect(semantics.dmSessionModes ?? []).not.toContain('auto')
  })
})
