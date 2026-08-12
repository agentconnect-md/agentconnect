import { describe, it, expect } from 'vitest'
import { imageRepository, imageTag, withImageTag, isNewerVersion, parseVersion, InvalidImageTagError } from './image.js'

describe('image reference arithmetic', () => {
  it('splits a plain tagged reference', () => {
    expect(imageRepository('ghcr.io/acme/daemon:1.4.0')).toBe('ghcr.io/acme/daemon')
    expect(imageTag('ghcr.io/acme/daemon:1.4.0')).toBe('1.4.0')
  })

  it('does not mistake a registry port for a tag', () => {
    expect(imageRepository('registry.example:5000/acme/daemon')).toBe('registry.example:5000/acme/daemon')
    expect(imageTag('registry.example:5000/acme/daemon')).toBeNull()
    expect(imageTag('registry.example:5000/acme/daemon:1.4.0')).toBe('1.4.0')
    expect(withImageTag('registry.example:5000/acme/daemon:1.4.0', '1.5.0')).toBe(
      'registry.example:5000/acme/daemon:1.5.0'
    )
  })

  it('reads an untagged reference as having no tag', () => {
    expect(imageTag('daemon')).toBeNull()
    expect(withImageTag('daemon', '1.4.0')).toBe('daemon:1.4.0')
  })

  // The guard that keeps a substituted tag from naming somebody else's image. It lives
  // here because this is the one place a registry reference is composed.
  it('refuses a tag that could repoint the reference', () => {
    for (const bad of ['1.5.0/evil', 'evil.test/fork/daemon:1.5.0', '1.5.0:latest', 'a@b', '', ' 1.5.0', '-1.5.0']) {
      expect(() => withImageTag('ghcr.io/acme/daemon:1.4.0', bad)).toThrow(InvalidImageTagError)
    }
    expect(withImageTag('ghcr.io/acme/daemon:1.4.0', '1.5.0-rc.2')).toBe('ghcr.io/acme/daemon:1.5.0-rc.2')
  })

  // A digest is an exact pin; rewriting it to a tag would discard what an operator chose.
  it('leaves a digest reference alone', () => {
    const digest = 'ghcr.io/acme/daemon@sha256:' + 'a'.repeat(64)
    expect(imageTag(digest)).toBeNull()
    expect(imageRepository(digest)).toBe(digest)
    expect(withImageTag(digest, '1.5.0')).toBe(digest)
  })
})

describe('parseVersion', () => {
  it('accepts a release and a prerelease', () => {
    expect(parseVersion('1.4.0')).toEqual({ release: ['1', '4', '0'], prerelease: null })
    expect(parseVersion('1.5.0-rc.2')).toEqual({ release: ['1', '5', '0'], prerelease: ['rc', '2'] })
  })

  it('rejects a floating tag', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('rc')).toBeNull()
    expect(parseVersion('v1.4.0')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('orders release versions numerically, not lexicographically', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true)
    expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false)
  })

  it('ranks a release above its own prereleases', () => {
    expect(isNewerVersion('1.5.0', '1.5.0-rc.9')).toBe(true)
    expect(isNewerVersion('1.5.0-rc.9', '1.5.0')).toBe(false)
  })

  it('orders prereleases of one release', () => {
    expect(isNewerVersion('1.5.0-rc.2', '1.5.0-rc.1')).toBe(true)
    expect(isNewerVersion('1.5.0-rc.10', '1.5.0-rc.2')).toBe(true)
    expect(isNewerVersion('1.5.0-rc', '1.5.0-rc.1')).toBe(false)
    expect(isNewerVersion('1.5.0-rc.1', '1.4.9')).toBe(true)
  })

  // The whole point of the guard: an unparseable side is never "older", so a sweep
  // cannot roll a deliberately floated or digest-pinned envelope backwards.
  it('never calls an unparseable version newer or older', () => {
    expect(isNewerVersion('1.5.0', 'latest')).toBe(false)
    expect(isNewerVersion('latest', '1.5.0')).toBe(false)
  })
})
