import { describe, it, expect } from 'vitest'
import { isThreadRootMessage, nativeMessageCoordinates, nativeMessageId } from '../src/wire-coordinates.js'

describe('wire coordinates', () => {
  it('extracts the native id as the tail past the LAST colon, for every minted format', () => {
    // One case per normalizer in this package — the parse is the inverse of the
    // minting, so each format pins the invariant it depends on.
    expect(nativeMessageId('slack:C123:1720000000.000100')).toBe('1720000000.000100')
    expect(nativeMessageId('telegram:-1002233:87')).toBe('87')
    expect(nativeMessageId('discord:99887766:11223344')).toBe('11223344')
    expect(nativeMessageId('feishu:oc_abc:om_xyz')).toBe('om_xyz')
  })

  it('splits the native (container, message) pair for every minted format', () => {
    expect(nativeMessageCoordinates({ platform: 'slack', msgId: 'slack:C123:1720000000.000100' })).toEqual({
      channel: 'C123',
      messageId: '1720000000.000100'
    })
    expect(nativeMessageCoordinates({ platform: 'telegram', msgId: 'telegram:-1002233:87' })).toEqual({
      channel: '-1002233',
      messageId: '87'
    })
    expect(nativeMessageCoordinates({ platform: 'feishu', msgId: 'feishu:oc_abc:om_xyz' })).toEqual({
      channel: 'oc_abc',
      messageId: 'om_xyz'
    })
  })

  it('reports the THREAD a Discord message lives in, which its normalized channel is not', () => {
    // The normalizer emits the parent channel for a threaded message; only the id's own
    // container addresses the message, so the pair must come from the id, not the message.
    expect(nativeMessageCoordinates({ platform: 'discord', msgId: 'discord:55551111:11223344' })).toEqual({
      channel: '55551111',
      messageId: '11223344'
    })
  })

  it('reports no pair for an id no normalizer minted', () => {
    // A hook delivery's `<hookId>:<deliveryKey>` names no platform message.
    expect(
      nativeMessageCoordinates({ platform: 'hook', msgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:msg_1' })
    ).toBeUndefined()
    // Prefix present but nothing behind or ahead of the separator.
    expect(nativeMessageCoordinates({ platform: 'slack', msgId: 'slack:C123' })).toBeUndefined()
    expect(nativeMessageCoordinates({ platform: 'slack', msgId: 'slack::1.1' })).toBeUndefined()
    expect(nativeMessageCoordinates({ platform: 'slack', msgId: 'slack:C123:' })).toBeUndefined()
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
