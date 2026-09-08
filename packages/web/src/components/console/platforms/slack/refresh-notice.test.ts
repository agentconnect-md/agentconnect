import { describe, expect, it } from 'vitest'
import type { SlackBotRefreshDto } from '@/lib/api'
import { slackManifestScopeFragment, slackRefreshNoticeState } from './refresh-notice'

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

describe('slackManifestScopeFragment', () => {
  it('renders one quoted, comma-terminated item per line so it pastes right after the bot array opener', () => {
    expect(slackManifestScopeFragment(['commands', 'im:read'])).toBe('"commands",\n"im:read",')
  })
})

describe('slackRefreshNoticeState', () => {
  it('does not request manifest review when workspace permissions already match', () => {
    expect(slackRefreshNoticeState(refreshResult({ manifest: 'manual_update_required' }))).toEqual({
      needsAttention: false,
      message: 'Workspace permissions match AgentConnect’s requirements.',
      action: null,
      scopeFragment: null,
      offerDelete: false
    })
  })

  it('keeps a fully synced app in the success state', () => {
    expect(slackRefreshNoticeState(refreshResult())).toEqual({
      needsAttention: false,
      message: 'Slack app configuration and workspace permissions are up to date.',
      action: null,
      scopeFragment: null,
      offerDelete: false
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

  it('sends a short grant the manifest could not be synced for to the manifest editor, with the scopes to paste', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'manual_update_required',
          authorization: 'reinstall_required',
          missingScopes: ['chat:write.customize', 'lists:read']
        })
      )
    ).toMatchObject({
      needsAttention: true,
      message:
        'Add the missing scopes to the app manifest in Slack — copy them and paste the list at the top of oauth_config.scopes.bot — then reinstall the app.',
      action: {
        href: 'https://app.slack.com/app-settings/T0123/A0123/app-manifest',
        label: 'Open App Manifest'
      },
      scopeFragment: '"chat:write.customize",\n"lists:read",',
      offerDelete: false
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
      },
      scopeFragment: null
    })
  })

  it('offers reinstallation AND forgetting the bot when Slack rejects the stored token', () => {
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
      },
      offerDelete: true
    })
  })

  it('offers only forgetting the bot when the app itself was deleted in Slack', () => {
    expect(
      slackRefreshNoticeState(refreshResult({ manifest: 'manual_update_required', authorization: 'app_deleted' }))
    ).toEqual({
      needsAttention: true,
      message: 'This app no longer exists in Slack — it was deleted there. Delete it here to clean up.',
      action: null,
      scopeFragment: null,
      offerDelete: true
    })
  })
})
