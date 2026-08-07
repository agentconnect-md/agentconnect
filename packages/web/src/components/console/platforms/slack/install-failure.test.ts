import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  SLACK_MISSING_SCOPES_CODE,
  slackMissingScopesFromError,
  slackMissingScopesMessage,
  slackPlatformInstallFailure
} from './install-failure'

const missingScopesError = (missingScopes?: unknown) =>
  new ApiError('Slack didn’t grant every permission this app needs.', 409, SLACK_MISSING_SCOPES_CODE, {
    ...(missingScopes === undefined ? {} : { missingScopes })
  })

describe('slackMissingScopesFromError', () => {
  it('returns the withheld scopes from the CP’s short-grant refusal', () => {
    expect(slackMissingScopesFromError(missingScopesError(['channels:history', 'users:read']))).toEqual([
      'channels:history',
      'users:read'
    ])
  })

  // The code is what identifies the failure — a refusal that somehow arrives
  // without a list is still the scope failure, and the console must render the
  // remedy rather than fall through to a generic error.
  it('still identifies the failure when the list is absent or malformed', () => {
    expect(slackMissingScopesFromError(missingScopesError())).toEqual([])
    expect(slackMissingScopesFromError(missingScopesError('chat:write'))).toEqual([])
    expect(slackMissingScopesFromError(missingScopesError([1, 'chat:write']))).toEqual(['chat:write'])
  })

  it('leaves every other failure to the generic error path', () => {
    expect(slackMissingScopesFromError(new ApiError('agent not found', 404))).toBeNull()
    expect(
      slackMissingScopesFromError(new ApiError('conflict', 409, 'SOMETHING_ELSE', { missingScopes: ['x'] }))
    ).toBeNull()
    expect(slackMissingScopesFromError(new Error('network down'))).toBeNull()
  })
})

describe('slackPlatformInstallFailure', () => {
  it('names the withheld scopes and the remedy on a short grant', () => {
    const message = slackPlatformInstallFailure('missing_scopes', ['channels:history', 'users:read'])
    expect(message).toContain('Reinstall the app in your Slack workspace')
    expect(message).toContain('Missing: channels:history, users:read')
  })

  it('states the remedy even when the scope list did not come through', () => {
    expect(slackPlatformInstallFailure('missing_scopes')).toBe(slackMissingScopesMessage([]))
    expect(slackPlatformInstallFailure('missing_scopes')).not.toContain('Missing:')
  })

  it('keeps the existing copy for the other terminal outcomes', () => {
    expect(slackPlatformInstallFailure('denied')).toBe('The install was cancelled in Slack.')
    expect(slackPlatformInstallFailure('workspace_taken')).toBe(
      'That Slack workspace is already connected to another organization.'
    )
  })

  it('falls back for an unknown or absent reason', () => {
    expect(slackPlatformInstallFailure(null)).toBe('The Slack install did not complete.')
    expect(slackPlatformInstallFailure('something_new')).toBe('The Slack install did not complete.')
  })

  // A non-scope failure must not pick up a stale list.
  it('ignores scopes passed alongside another reason', () => {
    expect(slackPlatformInstallFailure('denied', ['chat:write'])).toBe('The install was cancelled in Slack.')
  })
})
