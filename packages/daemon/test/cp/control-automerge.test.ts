// The `automerge/set` handler hands the arming session to the watcher as placement only: the watcher's identity is the pull request.
import type { AnyFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { autoMergeSet } from '../../src/cp/control/automerge.js'
import type { ControlWire } from '../../src/cp/control/context.js'
import type { AutoMergeWatcher } from '../../src/github/auto-merge/watcher.js'

function wire() {
  const replies: unknown[] = []
  const w = {
    reply: (_req: AnyFrame, _type: string, payload: unknown) => replies.push(payload),
    sendError: vi.fn(),
    emit: vi.fn(),
    log: { warn: vi.fn() }
  } as unknown as ControlWire
  return { w, replies }
}

const TARGET = { agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 }

describe('automerge/set', () => {
  it('passes the session beside the pull request, never inside the watcher’s identity', async () => {
    const set = vi.fn(async () => ({ ...TARGET, armed: true, placement: 'sandbox' as const }))
    const { w, replies } = wire()
    const frame = { id: 'f1', type: 'automerge/set', payload: { ...TARGET, enabled: true, sessionId: 'session-1' } }

    autoMergeSet(frame as unknown as AnyFrame, { autoMerge: { set } as unknown as AutoMergeWatcher }, w)
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(set).toHaveBeenCalledWith(TARGET, true, 'session-1')
  })

  it('arms with no session from an older Control Plane', async () => {
    const set = vi.fn(async () => ({ ...TARGET, armed: true }))
    const { w, replies } = wire()
    const frame = { id: 'f2', type: 'automerge/set', payload: { ...TARGET, enabled: true } }

    autoMergeSet(frame as unknown as AnyFrame, { autoMerge: { set } as unknown as AutoMergeWatcher }, w)
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(set).toHaveBeenCalledWith(TARGET, true, undefined)
  })
})
