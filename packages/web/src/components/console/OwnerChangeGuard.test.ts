// A move needs confirming only on a declaring platform, off a resolvable gated owner, to a different one (linear-integration.md §6.2).

import { describe, expect, it } from 'vitest'
import { conversationGate } from '@/lib/data'
import { ownerChangeNeedsWarning } from './OwnerChangeGuard'

const priv = { id: 'agent-b', label: 'triage-bot', gate: 'private' as const }
const open = { id: 'agent-c', label: 'docs-bot', gate: null }
const assistantAgent = { visibility: 'org' as const, assistantMode: { enabled: true } }
const assistant = { id: 'agent-d', label: 'ops-bot', gate: conversationGate(assistantAgent) }

describe('ownerChangeNeedsWarning', () => {
  it('warns when a declaring platform moves a team off a private agent', () => {
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: priv, toId: 'agent-a', room: 'ENG' })).toBe(true)
  })

  // #2979 B7: assistant mode gates nothing, so an Everyone agent in it holds no grant to lose.
  it('stays silent for an unrestricted owner, in assistant mode or not, an unchanged one, or an unknown one', () => {
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: open, toId: 'agent-a', room: 'ENG' })).toBe(false)
    expect(ownerChangeNeedsWarning({ platform: 'linear', from: assistant, toId: 'agent-a', room: 'ENG' })).toBe(false)
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
