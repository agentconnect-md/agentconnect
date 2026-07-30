import { describe, it, expect } from 'vitest'
import { slackWorkspaceLine } from '@/lib/slack-identity'

// Synthetic Slack ids throughout — never a real workspace.
const LINKED = { linked: true as const, teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }

describe('slackWorkspaceLine', () => {
  it('prefers the workspace name Slack sent, keeping the team id alongside', () => {
    expect(slackWorkspaceLine({ ...LINKED, teamName: 'Example Workspace' })).toBe('Example Workspace · T0EXAMPLE1')
  })

  it('falls back to the workspace domain when there is no name', () => {
    expect(slackWorkspaceLine({ ...LINKED, teamDomain: 'example-workspace' })).toBe(
      'example-workspace.slack.com · T0EXAMPLE1'
    )
  })

  it('shows the bare team id when Slack sent neither label', () => {
    expect(slackWorkspaceLine(LINKED)).toBe('T0EXAMPLE1')
  })

  it('renders nothing when the account has no Slack identity', () => {
    expect(slackWorkspaceLine({ linked: false })).toBeUndefined()
  })

  it('renders nothing while the read is pending or has failed', () => {
    // SWR leaves `data` undefined on both — the row must degrade to today's look
    // rather than showing a half-resolved workspace.
    expect(slackWorkspaceLine(undefined)).toBeUndefined()
  })
})
