import { describe, expect, it } from 'vitest'
import { slackAppLinks } from './bots.js'

describe('slackAppLinks', () => {
  it('opens the current Slack editors when the workspace id is known', () => {
    expect(slackAppLinks('A0123', 'T0456')).toEqual({
      settingsUrl: 'https://api.slack.com/apps/A0123',
      manifestUrl: 'https://app.slack.com/app-settings/T0456/A0123/app-manifest',
      permissionsUrl: 'https://app.slack.com/app-settings/T0456/A0123/oauth',
      reinstallUrl: 'https://api.slack.com/apps/A0123/install-on-team?'
    })
  })

  it('falls back to the app settings home when the workspace id is unavailable', () => {
    expect(slackAppLinks('A0123', null)).toEqual({
      settingsUrl: 'https://api.slack.com/apps/A0123',
      manifestUrl: 'https://api.slack.com/apps/A0123',
      permissionsUrl: 'https://api.slack.com/apps/A0123',
      reinstallUrl: 'https://api.slack.com/apps/A0123/install-on-team?'
    })
  })
})
