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

// The gap that prompted this: eight tools shipped behind capability scopes, and an install
// predating them reported "up to date" while every one of those tools answered `missing_scope`.
describe('slackRefreshNoticeState: optional capabilities', () => {
  const healthy = {
    manifest: 'synced' as const,
    authorization: 'current' as const,
    missingScopes: [],
    reinstallUrl: 'https://slack.example.test/reinstall',
    permissionsUrl: 'https://slack.example.test/permissions',
    manifestUrl: 'https://slack.example.test/manifest',
    settingsUrl: 'https://slack.example.test/settings'
  }

  it('says nothing extra when every capability scope is granted', () => {
    const state = slackRefreshNoticeState({ ...healthy, missingCapabilityScopes: [] } as never)
    expect(state.message).toContain('up to date')
    expect(state.needsAttention).toBe(false)
    expect(state.action).toBeNull()
  })

  it('names the gap and offers the reinstall that closes it', () => {
    const state = slackRefreshNoticeState({
      ...healthy,
      missingCapabilityScopes: ['search:read.public', 'canvases:write']
    } as never)
    expect(state.message).toContain('2 optional permissions are not')
    expect(state.message).toContain('Reinstall to enable')
    expect(state.action).toEqual({ href: healthy.reinstallUrl, label: 'Reinstall workspace' })
    // Healthy, not broken: the install works, so this must not read as a failure.
    expect(state.needsAttention).toBe(false)
  })

  // The gap this fixes: an install predating a release is short on BOTH sets, `reinstall_required`
  // won the branch, and the capability half was never mentioned — so the operator added the
  // required scopes, reinstalled, and came back to find the tools still off.
  it('names both halves when required and optional scopes are missing', () => {
    const state = slackRefreshNoticeState({
      ...healthy,
      authorization: 'reinstall_required',
      missingScopes: ['commands', 'im:write'],
      missingCapabilityScopes: ['search:read.public']
    } as never)
    expect(state.message).toContain('required and optional')
    expect(state.needsAttention).toBe(true)
  })

  it('tells an unsynced both-missing install to add every scope first', () => {
    const state = slackRefreshNoticeState({
      ...healthy,
      manifest: 'manual_update_required',
      authorization: 'reinstall_required',
      missingScopes: ['commands'],
      missingCapabilityScopes: ['canvases:write']
    } as never)
    expect(state.message).toContain('every missing scope below')
  })

  it('sends an unsynced manifest to the permissions page instead', () => {
    const state = slackRefreshNoticeState({
      ...healthy,
      manifest: 'manual_update_required',
      missingCapabilityScopes: ['reactions:read']
    } as never)
    expect(state.message).toContain('1 optional permission is not')
    // An unsynced manifest cannot be fixed by reinstalling alone — the scopes must be added first.
    expect(state.message).toContain('OAuth & Permissions')
    expect(state.action).toEqual({ href: healthy.permissionsUrl, label: 'Update permissions' })
  })
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
