import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { canRevokeShare, canSharePublicly, shareLink, sharePageProblem, shareTokenOf } from './artifact-share'

const member = { artifact: { viewerIsOwner: false }, role: 'collaborator', userId: 'user-2' }

describe('who may act in the Share dialog (artifacts.md §6.3)', () => {
  it('leaves public shares and audience changes to the owner and organization owners', () => {
    expect(canSharePublicly({ ...member, artifact: { viewerIsOwner: true } })).toBe(true)
    expect(canSharePublicly({ ...member, role: 'owner' })).toBe(true)
    expect(canSharePublicly(member)).toBe(false)
    expect(canSharePublicly({ ...member, role: 'viewer' })).toBe(false)
  })

  it('lets a share’s creator revoke their own, and only theirs', () => {
    const by = (userId: string | null) => ({ createdBy: { userId, displayName: null, email: null, platform: null } })
    expect(canRevokeShare(member, by('user-2'))).toBe(true)
    expect(canRevokeShare(member, by('user-3'))).toBe(false)
    expect(canRevokeShare({ ...member, userId: null }, by(null))).toBe(false)
    expect(canRevokeShare({ ...member, role: 'owner' }, by('user-3'))).toBe(true)
  })
})

describe('shareLink', () => {
  it('takes the link the server built, or builds it on this origin', () => {
    const origin = 'https://console.example.test'
    expect(shareLink({ link: 'https://web.example.test/share/tok', linkPath: '/share/tok' }, origin)).toBe(
      'https://web.example.test/share/tok'
    )
    expect(shareLink({ link: null, linkPath: '/share/tok' }, origin)).toBe('https://console.example.test/share/tok')
  })
})

describe('sharePageProblem', () => {
  it.each([
    [new ApiError('gone', 410, 'ARTIFACT_SHARE_REVOKED'), 'revoked'],
    [new ApiError('no', 404, 'ARTIFACT_SHARE_NOT_FOUND'), 'notFound'],
    [new ApiError('members', 404, 'ARTIFACT_SHARE_MEMBERS_ONLY'), 'membersOnly'],
    [new ApiError('sign in', 401), 'signIn'],
    [new ApiError('off', 409, 'ARTIFACTS_NOT_ENABLED'), 'notEnabled'],
    [new ApiError('boom', 500), 'failed'],
    [new TypeError('network'), 'failed']
  ])('reads %o as %s', (error, problem) => {
    expect(sharePageProblem(error)).toBe(problem)
  })
})

describe('shareTokenOf', () => {
  it('accepts what the server mints and refuses anything else', () => {
    expect(shareTokenOf('abcDEF0123456789_-xyz')).toBe('abcDEF0123456789_-xyz')
    expect(shareTokenOf(undefined)).toBeNull()
    expect(shareTokenOf('a%2Fb')).toBeNull()
    expect(shareTokenOf('%E0%A4%A')).toBeNull()
  })
})
