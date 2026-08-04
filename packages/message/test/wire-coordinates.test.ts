import { describe, it, expect } from 'vitest'
import { isThreadRootMessage, nativeMessageId } from '../src/wire-coordinates.js'

describe('wire coordinates', () => {
  it('extracts the native id as the tail past the LAST colon, for every minted format', () => {
    // One case per normalizer in this package — the parse is the inverse of the
    // minting, so each format pins the invariant it depends on.
    expect(nativeMessageId('slack:C123:1720000000.000100')).toBe('1720000000.000100')
    expect(nativeMessageId('telegram:-1002233:87')).toBe('87')
    expect(nativeMessageId('discord:99887766:11223344')).toBe('11223344')
    expect(nativeMessageId('feishu:oc_abc:om_xyz')).toBe('om_xyz')
  })

  it('detects a thread root (thread == own native id) and never a follow-up', () => {
    // Slack top-level: normalizer sets thread = own ts → root.
    expect(isThreadRootMessage({ msgId: 'slack:C1:1.100', thread: '1.100' })).toBe(true)
    // Slack follow-up: thread anchors on the ROOT's ts, not this message's.
    expect(isThreadRootMessage({ msgId: 'slack:C1:2.200', thread: '1.100' })).toBe(false)
    // Feishu topic root: thread = rootId ?? messageId → own id.
    expect(isThreadRootMessage({ msgId: 'feishu:oc_a:om_root', thread: 'om_root' })).toBe(true)
    expect(isThreadRootMessage({ msgId: 'feishu:oc_a:om_reply', thread: 'om_root' })).toBe(false)
    // Feishu DM: thread is the CHAT id — never a message coordinate.
    expect(isThreadRootMessage({ msgId: 'feishu:oc_a:om_1', thread: 'oc_a' })).toBe(false)
    // No thread coordinate at all.
    expect(isThreadRootMessage({ msgId: 'slack:C1:3.300' })).toBe(false)
  })
})
