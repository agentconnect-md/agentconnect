import { describe, it, expect } from 'vitest'
import { originKindOf } from '@agentconnect.md/protocol'
import { DEFAULT_MANIFEST, manifestFor } from '../src/platforms/manifest.js'

/**
 * The §5 manifest's load-bearing claim is not its field values — those are
 * checked by the behavior tests of the branches they replaced. It is that lookup
 * is TOTAL and its miss arm is FAIL-CLOSED, because the branches being retired
 * were all written as "Slack does X, everyone else does Y". If an unregistered id
 * ever resolved to a Slack-shaped answer, an unknown platform would take a path
 * it cannot serve.
 */
describe('platform manifest', () => {
  it('is total — an unregistered id resolves rather than throwing', () => {
    const m = manifestFor('some-future-platform')
    expect(m.platform).toBe('some-future-platform')
    expect(m.membershipEnumeration).toBe(DEFAULT_MANIFEST.membershipEnumeration)
    expect(m.statusSurface).toBe(DEFAULT_MANIFEST.statusSurface)
  })

  it('defaults to the conservative arm of every axis', () => {
    // No bulk enumeration API is assumed to exist; no status bar is assumed
    // editable. Both are the "everyone else" arm of the branches this replaces.
    expect(DEFAULT_MANIFEST.membershipEnumeration).toBe('per-conversation')
    expect(DEFAULT_MANIFEST.statusSurface).toBe('on-demand')
  })

  it('keeps Slack the only bulk-enumeration, turn-bar platform', () => {
    // This is what made the retired branches readable as `=== 'slack'`; pin it so
    // a later manifest edit cannot silently widen a Slack-only path.
    for (const p of ['slack', 'telegram', 'discord', 'feishu']) {
      const m = manifestFor(p)
      expect(m.membershipEnumeration === 'bulk').toBe(p === 'slack')
      expect(m.statusSurface === 'turn-bar').toBe(p === 'slack')
    }
  })

  it('composes with origin kind for arms whose fall-through serves non-chat origins', () => {
    // emitStatusBar's skip arm and backfillChannelNames both gate on BOTH axes:
    // hook / dream / webchat have no manifest and must keep the core path, so a
    // bare manifest read would have changed their behavior.
    for (const nonChat of ['hook', 'dream', 'webchat']) {
      expect(originKindOf(nonChat)).not.toBe('chat')
      // The default manifest alone would have sent them down the on-demand arm.
      expect(manifestFor(nonChat).statusSurface).toBe('on-demand')
    }
    for (const chat of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(originKindOf(chat)).toBe('chat')
    }
  })

  it('leaves an unknown chat-shaped id on the pre-existing default path', () => {
    // originKindOf returns undefined for an id this build does not know, so every
    // rewritten conjunction evaluates exactly as the old platform-literal OR did.
    expect(originKindOf('some-future-platform')).toBeUndefined()
  })
})
