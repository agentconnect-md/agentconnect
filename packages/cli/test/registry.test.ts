import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { verifyTarball } from '../src/registry.js'

const buf = Buffer.from('pretend tarball bytes')
const sha512 = createHash('sha512').update(buf).digest('base64')
const sha1 = createHash('sha1').update(buf).digest('hex')

describe('verifyTarball', () => {
  it('accepts a matching sha512 integrity', () => {
    expect(() => verifyTarball(buf, { integrity: `sha512-${sha512}` })).not.toThrow()
  })
  it('rejects a mismatched integrity', () => {
    expect(() => verifyTarball(buf, { integrity: 'sha512-AAAA' })).toThrow(/integrity check failed/)
  })
  it('rejects a malformed integrity string', () => {
    expect(() => verifyTarball(buf, { integrity: 'garbage' })).toThrow(/malformed integrity/)
  })
  it('falls back to shasum when integrity is absent', () => {
    expect(() => verifyTarball(buf, { shasum: sha1 })).not.toThrow()
    expect(() => verifyTarball(buf, { shasum: 'deadbeef' })).toThrow(/shasum check failed/)
  })
  it('refuses to install when neither integrity nor shasum is present', () => {
    expect(() => verifyTarball(buf, {})).toThrow(/refusing to install unverified bytes/)
  })
})
