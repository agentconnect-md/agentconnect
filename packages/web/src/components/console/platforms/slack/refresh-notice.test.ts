import { describe, expect, it } from 'vitest'
import type { SlackBotRefreshDto } from '@/lib/api'
import { slackRefreshNoticeState } from './refresh-notice'

const refreshResult = (overrides: Partial<SlackBotRefreshDto> = {}): SlackBotRefreshDto => ({
  manifest: 'synced',
  authorization: 'current',
  missingScopes: [],
  settingsUrl: 'https://api.slack.com/apps/A0123',
  manifestUrl: 'https://app.slack.com/app-settings/T0123/A0123/app-manifest',
  permissionsUrl: 'https://app.slack.com/app-settings/T0123/A0123/oauth',
  reinstallUrl: 'https://api.slack.com/apps/A0123/install-on-team?',
  ...overrides
})

describe('slackRefreshNoticeState', () => {
  it('does not request manifest review when workspace permissions already match', () => {
    expect(slackRefreshNoticeState(refreshResult({ manifest: 'manual_update_required' }))).toEqual({
      needsAttention: false,
      message: 'Workspace permissions match AgentConnect’s requirements.',
      action: null
    })
  })

  it('keeps a fully synced app in the success state', () => {
    expect(slackRefreshNoticeState(refreshResult())).toEqual({
      needsAttention: false,
      message: 'Slack app configuration and workspace permissions are up to date.',
      action: null
    })
  })

  it('keeps an unknown manifest check actionable even when permissions are current', () => {
    expect(slackRefreshNoticeState(refreshResult({ manifest: 'unknown' }))).toMatchObject({
      needsAttention: true,
      message: 'The Slack app manifest could not be confirmed. Review it in Slack or try again.',
      action: {
        href: 'https://app.slack.com/app-settings/T0123/A0123/app-manifest',
        label: 'Open App Manifest'
      }
    })
  })

  it('offers only permission updates when the requested scopes are not synced', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'manual_update_required',
          authorization: 'reinstall_required',
          missingScopes: ['chat:write.customize']
        })
      )
    ).toMatchObject({
      needsAttention: true,
      message: 'Add the missing scopes in Slack’s OAuth & Permissions page, then reinstall the app.',
      action: {
        href: 'https://app.slack.com/app-settings/T0123/A0123/oauth',
        label: 'Update permissions'
      }
    })
  })

  it('offers only reinstallation when the manifest already requests the missing scopes', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({ authorization: 'reinstall_required', missingScopes: ['chat:write.customize'] })
      )
    ).toMatchObject({
      needsAttention: true,
      message: 'Slack app configuration is synced. Reinstall it to grant the missing scopes.',
      action: {
        href: 'https://api.slack.com/apps/A0123/install-on-team?',
        label: 'Reinstall workspace'
      }
    })
  })

  it('offers only reinstallation when Slack rejects the stored token', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'manual_update_required',
          authorization: 'invalid',
          // Reinstall is app-scoped and does not need the team id that an invalid
          // token can no longer reveal through auth.test.
          reinstallUrl: 'https://api.slack.com/apps/A0123/install-on-team?'
        })
      )
    ).toMatchObject({
      needsAttention: true,
      action: {
        href: 'https://api.slack.com/apps/A0123/install-on-team?',
        label: 'Reinstall workspace'
      }
    })
  })
})
