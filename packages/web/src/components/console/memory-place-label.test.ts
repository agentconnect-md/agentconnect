import { describe, expect, it } from 'vitest'
import { placeLayerLabel } from './memory-place-label'

describe('placeLayerLabel', () => {
  it('names a room with its platform sigil and display name, and a DM as it is written', () => {
    expect(placeLayerLabel({ channelKey: 'k', channel: 'C0EXAMPLE1', platform: 'slack', name: 'launch-room' })).toBe(
      '#launch-room · Slack'
    )
    expect(placeLayerLabel({ channelKey: 'k', channel: 'G1', platform: 'feishu', name: 'Ops' })).toBe('Ops · Lark')
    expect(placeLayerLabel({ channelKey: 'k', channel: 'D0EXAMPLE', platform: 'slack', name: '@alex' })).toBe(
      '@alex · Slack'
    )
  })

  it('falls back to the channel id, then the folder key, and to the raw id of a platform no module names', () => {
    expect(placeLayerLabel({ channelKey: 'k', channel: 'C0EXAMPLE2', platform: 'slack', name: null })).toBe(
      'C0EXAMPLE2 · Slack'
    )
    expect(placeLayerLabel({ channelKey: 'k', channel: 'C0EXAMPLE3' })).toBe('C0EXAMPLE3')
    expect(placeLayerLabel({ channelKey: 'scope--C0EXAMPLE4-abc', channel: null })).toBe('scope--C0EXAMPLE4-abc')
    expect(placeLayerLabel({ channelKey: 'k', channel: 'R1', platform: 'example-chat', name: 'room' })).toBe(
      '#room · example-chat'
    )
  })
})
