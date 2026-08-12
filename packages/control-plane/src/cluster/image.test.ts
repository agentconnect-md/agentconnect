import { describe, it, expect } from 'vitest'
import {
  imageRepository,
  imageTag,
  withImageTag,
  isNewerVersion,
  parseVersion,
  versionImageTag,
  versionTagStyle,
  InvalidImageTagError
} from './image.js'

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

  // The `v` prefix is accepted because one version is spelled two ways: npm reports
  // `1.5.0` and the released image is tagged `v1.5.0`, and these get compared.
  it('accepts the image tag spelling of the same version', () => {
    expect(parseVersion('v1.4.0')).toEqual({ release: ['1', '4', '0'], prerelease: null })
    expect(parseVersion('v1.5.0-rc.2')).toEqual({ release: ['1', '5', '0'], prerelease: ['rc', '2'] })
  })

  it('rejects a floating tag', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('rc')).toBeNull()
    expect(parseVersion('release-1.4.0')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  // What the sweep actually asks: is the channel's npm version newer than this image tag?
  it('compares an npm version against an image tag of the same release', () => {
    expect(isNewerVersion('1.5.0', 'v1.4.0')).toBe(true)
    expect(isNewerVersion('1.4.0', 'v1.4.0')).toBe(false)
    expect(isNewerVersion('1.4.0', 'v1.5.0')).toBe(false)
    expect(isNewerVersion('1.5.0-rc.2', 'v1.5.0-rc.1')).toBe(true)
  })

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

describe('versionTagStyle', () => {
  it('reads the convention off a tag that is itself a version', () => {
    expect(versionTagStyle('v1.4.0')).toBe('v-prefixed')
    expect(versionTagStyle('v1.5.0-rc.2')).toBe('v-prefixed')
    expect(versionTagStyle('1.4.0')).toBe('bare')
  })

  /**
   * A floating tag is NOT evidence. Reading its missing `v` as "bare" is how an upgrade
   * composes `:1.5.0` for a registry that only publishes `:v1.5.0` — a tag that does not
   * exist, so the pod lands in ImagePullBackOff instead of the caller being told no.
   */
  it('learns nothing from a floating or absent tag', () => {
    expect(versionTagStyle('latest')).toBeNull()
    expect(versionTagStyle('rc')).toBeNull()
    expect(versionTagStyle('main')).toBeNull()
    expect(versionTagStyle(null)).toBeNull()
  })
})

describe('versionImageTag', () => {
  // The release train tags images with the GIT tag, so an npm version is translated:
  // `.github/workflows/build.yaml` refuses anything but `vX.Y.Z(-rc.N)`.
  it('spells a version in the given convention', () => {
    expect(versionImageTag('v-prefixed', '1.5.0')).toBe('v1.5.0')
    expect(versionImageTag('v-prefixed', '1.5.0-rc.2')).toBe('v1.5.0-rc.2')
    expect(versionImageTag('bare', '1.5.0')).toBe('1.5.0')
  })
})
