import { describe, expect, it } from 'vitest'
import { buildSlackManifest, slackCreateAppUrl, SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID } from './slack-manifest'

describe('buildSlackManifest', () => {
  it('brands the app with the given background_color, and omits it otherwise', () => {
    // No color ⇒ no background_color key (mirrors the CP auto-install manifest).
    expect(buildSlackManifest({ name: 'acme' }).display_information.background_color).toBeUndefined()
    // A color (from the owning agent's icon) ⇒ display_information.background_color.
    const branded = buildSlackManifest({ name: 'acme' }, { backgroundColor: '#c62a78' })
    expect(branded.display_information.background_color).toBe('#c62a78')
  })

  it('prefills the Slack create-app link with the manifest', () => {
    const url = new URL(slackCreateAppUrl({ name: 'acme' }))

    expect(url.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(url.searchParams.get('manifest_json')!)).toEqual(buildSlackManifest({ name: 'acme' }))
  })

  it('declares the message shortcut and its required commands scope', () => {
    const manifest = buildSlackManifest({ name: 'acme' })

    expect(manifest.oauth_config.scopes.bot).toContain('commands')
    expect(manifest.features.shortcuts).toEqual([
      {
        name: 'Manage AgentConnect session',
        type: 'message',
        callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
        description: 'View or update the AgentConnect session for this conversation'
      }
    ])
  })
})
