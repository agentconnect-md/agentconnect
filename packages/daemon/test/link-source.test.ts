import { describe, it, expect } from 'vitest'
import { sessionLinkSourceFor } from '../src/platforms/link-source.js'

describe('session-link source strategy', () => {
  it('brands Slack and GitHub as themselves', () => {
    expect(sessionLinkSourceFor('slack')).toBe('slack')
    expect(sessionLinkSourceFor('github')).toBe('github')
  })

  const feishuInt = (config: Record<string, unknown>) => ({ id: 'i-fs', platform: 'feishu', config }) as never

  it('brands Feishu/Lark by integration region, read through the validated config', () => {
    // Feishu and Lark share one protocol platform id; the region is the brand.
    expect(sessionLinkSourceFor('feishu', feishuInt({ appId: 'c1', appSecret: 's', region: 'lark' }))).toBe('lark')
    expect(sessionLinkSourceFor('feishu', feishuInt({ appId: 'c1', appSecret: 's', region: 'feishu' }))).toBe('feishu')
    // The schema default supplies the region a hand-authored payload omitted —
    // the same 'feishu' the pre-flatten parse defaulted to.
    expect(sessionLinkSourceFor('feishu', feishuInt({ appId: 'c1', appSecret: 's' }))).toBe('feishu')
    // No integration resolved → no hint, exactly the pre-seam behavior; a
    // payload the module schema refuses reads the same way.
    expect(sessionLinkSourceFor('feishu')).toBeUndefined()
    expect(sessionLinkSourceFor('feishu', feishuInt({ appId: 'c1' }))).toBeUndefined()
  })

  it('contributes no hint anywhere else', () => {
    for (const p of ['telegram', 'discord', 'webchat', 'hook', 'some-future-platform']) {
      expect(sessionLinkSourceFor(p, feishuInt({ appId: 'c1', appSecret: 's', region: 'lark' }))).toBeUndefined()
    }
  })
})
