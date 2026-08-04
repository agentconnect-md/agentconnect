import { describe, it, expect } from 'vitest'
import { sessionLinkSourceFor } from '../src/platforms/link-source.js'

describe('session-link source strategy', () => {
  it('brands Slack and GitHub as themselves', () => {
    expect(sessionLinkSourceFor('slack')).toBe('slack')
    expect(sessionLinkSourceFor('github')).toBe('github')
  })

  it('brands Feishu/Lark by integration region', () => {
    // Feishu and Lark share one protocol platform id; the region is the brand.
    expect(sessionLinkSourceFor('feishu', { feishu: { region: 'lark' } })).toBe('lark')
    expect(sessionLinkSourceFor('feishu', { feishu: { region: 'feishu' } })).toBe('feishu')
    // No integration resolved → no hint, exactly the pre-seam behavior.
    expect(sessionLinkSourceFor('feishu')).toBeUndefined()
    expect(sessionLinkSourceFor('feishu', {})).toBeUndefined()
  })

  it('contributes no hint anywhere else', () => {
    for (const p of ['telegram', 'discord', 'webchat', 'hook', 'some-future-platform']) {
      expect(sessionLinkSourceFor(p, { feishu: { region: 'lark' } })).toBeUndefined()
    }
  })
})
