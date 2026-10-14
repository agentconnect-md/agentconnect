import { describe, expect, it } from 'vitest'
import { isHttpsGitAddress, isTrustedByUrl } from './skill-source'

describe('isTrustedByUrl', () => {
  it('marks only anonymous sources off GitHub', () => {
    expect(isTrustedByUrl({ source: 'https://git.example.test/ops/kit', credential: null })).toBe(true)
    expect(isTrustedByUrl({ source: 'https://gitlab.example.test/team/kit', credential: null })).toBe(true)
    expect(isTrustedByUrl({ source: 'https://gitlab.example.test/team/kit', credential: { provider: 'gitlab' } })).toBe(
      false
    )
    expect(isTrustedByUrl({ source: 'example-org/example-repo', credential: null })).toBe(false)
    expect(isTrustedByUrl({ source: 'github.com/example-org/example-repo', credential: null })).toBe(false)
    expect(isTrustedByUrl({ source: 'https://GitHub.com./example-org/example-repo', credential: null })).toBe(false)
    expect(isTrustedByUrl({ source: 'git@github.com:example-org/example-repo.git', credential: null })).toBe(false)
  })

  // A CP that predates `credential` cannot say whether a source is anonymous.
  it('says nothing when the credential is unknown', () => {
    expect(isTrustedByUrl({ source: 'https://git.example.test/ops/kit' })).toBe(false)
  })
})

describe('isHttpsGitAddress', () => {
  it('accepts a plain https repository address', () => {
    expect(isHttpsGitAddress(' https://git.example.test/ops/kit.git ')).toBe(true)
  })

  it('refuses other schemes, credentials and a bare host', () => {
    expect(isHttpsGitAddress('http://git.example.test/ops/kit')).toBe(false)
    expect(isHttpsGitAddress('git@git.example.test:ops/kit.git')).toBe(false)
    expect(isHttpsGitAddress('https://user:token@git.example.test/ops/kit')).toBe(false)
    expect(isHttpsGitAddress('https://git.example.test/')).toBe(false)
  })
})
