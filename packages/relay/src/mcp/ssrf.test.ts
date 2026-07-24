import { describe, it, expect } from 'vitest'
import { isBlockedIp } from './ssrf.js'

describe('isBlockedIp — SSRF egress guard address classification', () => {
  it('blocks IPv4 loopback, private, CGNAT, link-local (incl. cloud metadata), and reserved', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '169.254.1.1', // link-local
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1', // multicast
      '255.255.255.255'
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })

  it('blocks IPv6 loopback, unspecified, ULA, link-local, IPv4-mapped (dotted + hex), and bracketed literals', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1', // Node's canonical hex form of ::ffff:127.0.0.1
      '::ffff:a00:1', // hex ::ffff:10.0.0.1
      '[::1]' // bracketed literal (as URL.hostname yields it)
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('allows public IPv6 and IPv4-mapped public (dotted + hex)', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })
})
