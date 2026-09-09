import { describe, expect, it } from 'vitest'
import type { SlackBotRefreshDto } from '@/lib/api'
import { slackManifestScopeFragment, slackRefreshNoticeState } from './refresh-notice'

const refreshResult = (overrides: Partial<SlackBotRefreshDto> = {}): SlackBotRefreshDto => ({
  manifest: 'synced',
  manifestMissingScopes: [],
  authorization: 'current',
  rejection: null,
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
      scopeFragment: null
    })
  })

  it('keeps a fully synced app in the success state', () => {
    expect(slackRefreshNoticeState(refreshResult())).toEqual({
      needsAttention: false,
      message: 'Slack app configuration and workspace permissions are up to date.',
      action: null,
      scopeFragment: null
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
      scopeFragment: '"chat:write.customize",\n"lists:read",'
    })
  })

  it('sends a built-in app with a short grant to the platform reinstall, claiming nothing about its manifest', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'manual_update_required',
          authorization: 'reinstall_required',
          missingScopes: ['lists:read']
        }),
        { builtin: true }
      )
    ).toMatchObject({
      needsAttention: true,
      message: 'Reinstall the workspace to grant the missing scopes.',
      action: {
        href: 'https://api.slack.com/apps/A0123/install-on-team?',
        label: 'Reinstall workspace'
      },
      scopeFragment: null
    })
  })

  it('flags a built-in app whose manifest lacks required scopes, with the list to paste and the Setup Server as the fix', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'deployment_update_required',
          manifestMissingScopes: ['im:read', 'lists:read'],
          authorization: 'reinstall_required',
          missingScopes: ['lists:read']
        }),
        { builtin: true }
      )
    ).toMatchObject({
      needsAttention: true,
      message:
        "This app's manifest is missing scopes AgentConnect requires. Update it from the Setup Server (Slack → Apply update), or paste the copied list into oauth_config.scopes.bot in the App Manifest editor, then reinstall the workspace.",
      action: {
        href: 'https://app.slack.com/app-settings/T0123/A0123/app-manifest',
        label: 'Open App Manifest'
      },
      scopeFragment: '"im:read",\n"lists:read",'
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

  it('offers only reinstallation when Slack rejects the stored token', () => {
    expect(
      slackRefreshNoticeState(
        refreshResult({
          manifest: 'manual_update_required',
          authorization: 'invalid',
          rejection: 'invalid_auth',
          // Reinstall is app-scoped and does not need the team id that an invalid
          // token can no longer reveal through auth.test.
          reinstallUrl: 'https://api.slack.com/apps/A0123/install-on-team?'
        })
      )
    ).toMatchObject({
      needsAttention: true,
      // Slack's own code rides along: it is the only diagnosis the console has.
      message:
        'Slack rejected the stored bot token (invalid_auth). Reinstall the app if needed, then recreate this integration with the current Bot User OAuth Token.',
      action: {
        href: 'https://api.slack.com/apps/A0123/install-on-team?',
        label: 'Reinstall workspace'
      }
    })
  })
})
