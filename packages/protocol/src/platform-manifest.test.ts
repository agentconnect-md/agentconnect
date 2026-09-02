import { describe, it, expect } from 'vitest'
import { originKindOf } from './frames/route.js'
import { DEFAULT_MANIFEST, manifestFor } from './platform-manifest.js'

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
  })

  it('stays total for Object.prototype keys', () => {
    // A plain-record table would return inherited members here — `constructor`
    // would spread a function and advertise an undefined axis, which is fail-OPEN
    // in exactly the guarantee above. Hence the Map.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const m = manifestFor(key)
      expect(m.platform).toBe(key)
      expect(m.membershipEnumeration).toBe(DEFAULT_MANIFEST.membershipEnumeration)
    }
  })

  it('defaults to the conservative arm of every axis', () => {
    // No authoritative enumeration API is assumed to exist. That is the "everyone
    // else" arm of the branches this replaces.
    expect(DEFAULT_MANIFEST.membershipEnumeration).toBe('observed')
  })

  it('keeps Slack the only authoritative-enumeration platform', () => {
    // This is what made the retired branches readable as `=== 'slack'`; pin it so
    // a later manifest edit cannot silently widen a Slack-only path.
    for (const p of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(manifestFor(p).membershipEnumeration === 'authoritative').toBe(p === 'slack')
    }
  })

  it('admits bot senders on no platform but Slack — and never on an unknown id', () => {
    // Relay arbitration reads this BEFORE any target resolves (§8): a `true`
    // platform admits a third-party bot via explicit mention; everyone else and
    // every unknown id stays on the drop arm the retired `!== 'slack'` encoded.
    for (const p of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(manifestFor(p).botSenderRouting).toBe(p === 'slack')
    }
    expect(manifestFor('some-future-platform').botSenderRouting).toBe(false)
    expect(DEFAULT_MANIFEST.botSenderRouting).toBe(false)
  })

  it('declares multi-agent bots on Slack and Linear, and nowhere else', () => {
    // The CP's two install-time gates read this before a bot is reused or a
    // daemon is reached; it retired a core `platform === 'slack'` predicate, so
    // the Slack arm is an equivalence and Linear is the whole new behavior.
    for (const p of ['slack', 'linear']) expect(manifestFor(p).multiAgentShareable, p).toBe(true)
    for (const p of ['telegram', 'discord', 'feishu']) expect(manifestFor(p).multiAgentShareable, p).toBe(false)
    expect(manifestFor('some-future-platform').multiAgentShareable).toBe(false)
    expect(DEFAULT_MANIFEST.multiAgentShareable).toBe(false)
  })

  it('declares owner-as-default on Linear, and nowhere else', () => {
    // One CP read hangs off this before any route or owner exists: the compile projects a row's
    // owner into `conversationDefaults` and emits no channel-scoped route for it.
    expect(manifestFor('linear').ownerAsDefault).toBe(true)
    for (const p of ['slack', 'telegram', 'discord', 'feishu']) expect(manifestFor(p).ownerAsDefault, p).toBe(false)
    expect(manifestFor('some-future-platform').ownerAsDefault).toBe(false)
    expect(DEFAULT_MANIFEST.ownerAsDefault).toBe(false)
  })

  it('keeps Linear on the fail-closed arm of every axis it did not earn', () => {
    // Linear's row exists for `multiAgentShareable` and `ownerAsDefault` alone: no
    // membership snapshot API, no bot-sender admission, nothing but a conversation to leave.
    // Pin it so the row cannot pick up a Slack-shaped path in passing.
    const m = manifestFor('linear')
    expect(m.membershipEnumeration).toBe(DEFAULT_MANIFEST.membershipEnumeration)
    expect(m.botSenderRouting).toBe(DEFAULT_MANIFEST.botSenderRouting)
    expect(m.leaveGranularity).toBe(DEFAULT_MANIFEST.leaveGranularity)
    expect(m.dmChannelPattern).toBeUndefined()
  })

  it('composes with origin kind for arms whose fall-through serves non-chat origins', () => {
    // backfillChannelNames and the first-seen-chat refresh both gate on BOTH axes:
    // hook / dream / webchat have no manifest and must keep the core path, so a
    // bare manifest read would have changed their behavior.
    for (const nonChat of ['hook', 'dream', 'webchat']) {
      expect(originKindOf(nonChat)).not.toBe('chat')
      // The default manifest alone would have sent them down the observed arm.
      expect(manifestFor(nonChat).membershipEnumeration).toBe('observed')
    }
    for (const chat of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(originKindOf(chat)).toBe('chat')
    }
  })

  it('leaves an unknown chat-shaped id on the pre-existing default path', () => {
    // originKindOf returns undefined for an id this build does not know, so every
    // rewritten conjunction evaluates exactly as the old platform-literal OR did.
    expect(originKindOf('some-future-platform')).toBeUndefined()
    // Linear too: a manifest row is not a wire-vocabulary entry, and an
    // unclassified id is read as `chat` — the kind Linear wants (§3).
    expect(originKindOf('linear')).toBeUndefined()
  })
})
