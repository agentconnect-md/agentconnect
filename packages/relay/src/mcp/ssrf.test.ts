import type { LookupAddress, lookup as dnsLookup } from 'node:dns'
import { describe, it, expect } from 'vitest'
import { isBlockedIp, makeGuardedLookup } from './ssrf.js'

function staticResolve(addresses: LookupAddress[]): typeof dnsLookup {
  return ((
    _hostname: string,
    _options: unknown,
    cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
  ) => {
    cb(null, addresses)
  }) as unknown as typeof dnsLookup
}

function runLookupAll(
  lookup: ReturnType<typeof makeGuardedLookup>,
  hostname: string
): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    ;(
      lookup as unknown as (
        host: string,
        opts: { all: boolean },
        cb: (err: Error | null, addrs: Array<{ address: string; family: number }>) => void
      ) => void
    )(hostname, { all: true }, (err, addrs) => {
      if (err) reject(err)
      else resolve(addrs)
    })
  })
}

function runLookupOne(
  lookup: ReturnType<typeof makeGuardedLookup>,
  hostname: string
): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (err, address, family) => {
      if (err) reject(err)
      else if (typeof address !== 'string' || typeof family !== 'number') {
        reject(new Error('expected single-address lookup result'))
      } else {
        resolve({ address, family })
      }
    })
  })
}

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
      'ff02::1',
      'fd00:ec2::254',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1', // Node's canonical hex form of ::ffff:127.0.0.1
      '::ffff:a00:1', // hex ::ffff:10.0.0.1
      '::ffff:0:a9fe:a9fe', // IPv4-translated IMDS
      '64:ff9b::169.254.169.254', // NAT64 IMDS
      '64:ff9b:1::10.0.0.1', // NAT64 local-use RFC1918
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

describe('makeGuardedLookup — dual-stack and SSRF pinning', () => {
  it('returns all validated dual-stack addresses when allowPrivate is true and all is true', async () => {
    const lookup = makeGuardedLookup(
      true,
      staticResolve([
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ])
    )
    await expect(runLookupAll(lookup, 'localhost')).resolves.toEqual([
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 }
    ])
    await expect(runLookupOne(lookup, 'localhost')).resolves.toEqual({ address: '::1', family: 6 })
  })

  it('rejects mixed [public, private] resolutions when allowPrivate is false', async () => {
    const lookup = makeGuardedLookup(
      false,
      staticResolve([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ])
    )
    await expect(runLookupAll(lookup, 'rebind.example.test')).rejects.toThrow(
      'ssrf: blocked address 127.0.0.1 for rebind.example.test'
    )
    await expect(runLookupOne(lookup, 'rebind.example.test')).rejects.toThrow(
      'ssrf: blocked address 127.0.0.1 for rebind.example.test'
    )
  })

  it('returns all public dual-stack addresses when allowPrivate is false and all is true', async () => {
    const lookup = makeGuardedLookup(
      false,
      staticResolve([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '1.1.1.1', family: 4 }
      ])
    )
    await expect(runLookupAll(lookup, 'mcp.example.test')).resolves.toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 }
    ])
  })
})
