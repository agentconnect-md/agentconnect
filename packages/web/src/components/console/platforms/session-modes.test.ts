// A row's session-mode offer here and the manifest's `appendKinds` the projection reads are one fact; they must agree.

import { describe, expect, it } from 'vitest'
import { manifestFor } from '@agentconnect.md/protocol'
import { channelListSemantics, platformRegistry } from './registry'

describe('session modes against the platform manifest', () => {
  it.each(platformRegistry.ids())('%s offers append exactly where the projection forces it', (id) => {
    const semantics = channelListSemantics(id)
    const kinds = manifestFor(id).appendKinds
    expect((semantics.sessionModes ?? ['createNew', 'append']).includes('append'), 'rooms').toBe(
      kinds.includes('channel')
    )
    expect((semantics.dmSessionModes ?? []).includes('append'), 'DMs').toBe(kinds.includes('im'))
    // A group DM offers no session mode on any platform.
    expect(kinds).not.toContain('mpim')
  })
})
