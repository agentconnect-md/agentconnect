import { describe, expect, it } from 'vitest'
import { ComputerStunUrl, relayComputerViewBase, viewerPeerToPeerAllowed } from './computer-viewer.js'

const ID = '00000000-0000-4000-8000-000000000001'

describe('relayComputerViewBase', () => {
  it('builds the viewer API base from a public origin or a roster address', () => {
    expect(relayComputerViewBase('https://relay.example.com', ID)).toBe(
      `https://relay.example.com/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('https://relay.example.com/', ID)).toBe(
      `https://relay.example.com/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('wss://relay.example.com/i/relay-2/rd/ws?x=1', ID)).toBe(
      `https://relay.example.com/i/relay-2/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('ws://127.0.0.1:8090/rd/ws', ID)).toBe(
      `http://127.0.0.1:8090/cr/computers/${ID}/view/api`
    )
  })
})

describe('viewerPeerToPeerAllowed', () => {
  it('follows an explicit setting, and otherwise allows hole punching only while just the owner may watch', () => {
    expect(viewerPeerToPeerAllowed({ allowedMembers: [] }, 'owner')).toBe(true)
    expect(viewerPeerToPeerAllowed({ allowedMembers: ['owner'] }, 'owner')).toBe(true)
    expect(viewerPeerToPeerAllowed({ allowedMembers: ['owner', 'peer'] }, 'owner')).toBe(false)
    expect(viewerPeerToPeerAllowed({ allowedMembers: ['owner', 'peer'], viewerPeerToPeer: true }, 'owner')).toBe(true)
    expect(viewerPeerToPeerAllowed({ allowedMembers: ['owner'], viewerPeerToPeer: false }, 'owner')).toBe(false)
  })
})

describe('ComputerStunUrl', () => {
  it('takes a stun: host with an optional port and nothing else', () => {
    for (const ok of ['stun:stun-0.example.com:3478', 'stun:203.0.113.4', 'stun:[2001:db8::1]:3478']) {
      expect(ComputerStunUrl.safeParse(ok).success).toBe(true)
    }
    for (const bad of [
      'turn:turn.example.com:3478',
      'stun:',
      'stun:host:3478?transport=udp',
      'stuns:host',
      'stun:a b'
    ]) {
      expect(ComputerStunUrl.safeParse(bad).success).toBe(false)
    }
  })
})
