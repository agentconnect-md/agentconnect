import { describe, it, expect } from 'vitest'
import { slackWorkspaceLine, slackWorkspaceUrl } from '@/lib/slack-identity'

// Synthetic Slack ids throughout — never a real workspace.
const LINKED = { linked: true as const, teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }

describe('slackWorkspaceLine', () => {
  it('shows the workspace name Slack sent, and nothing else', () => {
    // The raw id is deliberately absent: this line is read by people managing
    // their own sign-in methods, to whom `T…` is noise.
    expect(slackWorkspaceLine({ ...LINKED, teamName: 'Example Workspace' })).toBe('Example Workspace')
  })

  it('falls back to the workspace domain when there is no name', () => {
    expect(slackWorkspaceLine({ ...LINKED, teamDomain: 'example-workspace' })).toBe('example-workspace.slack.com')
  })

  it('shows the bare team id only when Slack sent neither label', () => {
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

describe('slackWorkspaceUrl', () => {
  it('addresses the workspace by its domain', () => {
    expect(slackWorkspaceUrl({ ...LINKED, teamDomain: 'example-workspace' })).toBe(
      'https://example-workspace.slack.com'
    )
  })

  it('stays undefined without a domain, since the team id does not address one', () => {
    // The label still renders — it just renders as plain text rather than a
    // link that would 404.
    expect(slackWorkspaceUrl({ ...LINKED, teamName: 'Example Workspace' })).toBeUndefined()
  })

  it('stays undefined when there is no Slack identity at all', () => {
    expect(slackWorkspaceUrl({ linked: false })).toBeUndefined()
    expect(slackWorkspaceUrl(undefined)).toBeUndefined()
  })
})
