// When a conversation-owner move has to be confirmed. Three conditions, and each one on
// its own is a reason to write straight through: the platform must declare the warning
// (owner-as-default, linear-integration.md §6.2), the outgoing owner must be resolvable
// AND private, and the incoming one must actually differ.

import { describe, expect, it } from 'vitest'
import { ownerChangeNeedsWarning } from './OwnerChangeGuard'

const priv = { id: 'agent-b', label: 'triage-bot', restricted: true }
const open = { id: 'agent-c', label: 'docs-bot', restricted: false }

describe('ownerChangeNeedsWarning', () => {
  it('warns when a declaring platform moves a team off a private agent', () => {
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: priv, toId: 'agent-a', room: 'ENG' })).toBe(true)
  })

  it('stays silent for an unrestricted owner, an unchanged one, or an unknown one', () => {
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: open, toId: 'agent-a', room: 'ENG' })).toBe(false)
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: priv, toId: priv.id, room: 'ENG' })).toBe(false)
    expect(ownerChangeNeedsWarning({ platform: 'linear', toId: 'agent-a', room: 'ENG' })).toBe(false)
  })

  it('stays silent on a platform whose owner compiles to a route', () => {
    // Slack's gated grant is the owner's channel-scoped route, which the move rewrites —
    // there is nothing to warn about, and no module declares the copy.
    for (const platform of ['slack', 'telegram', 'discord', 'feishu', 'not-a-platform', undefined]) {
      expect(ownerChangeNeedsWarning({ platform, from: priv, toId: 'agent-a', room: '#deploys' }), platform).toBe(false)
    }
  })
})
