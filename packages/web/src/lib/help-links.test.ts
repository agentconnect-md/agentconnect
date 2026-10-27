import { afterEach, describe, expect, it, vi } from 'vitest'
import { docsPageUrl } from './help-links'

afterEach(() => vi.unstubAllGlobals())

describe('docsPageUrl', () => {
  it('joins the default docs root and adds the zh prefix for Chinese', () => {
    vi.stubGlobal('window', { __AC_ENV: {} })
    expect(docsPageUrl('connect-automate/chat-platforms/slack', 'en')).toBe(
      'https://www.agentconnect.md/docs/connect-automate/chat-platforms/slack'
    )
    expect(docsPageUrl('connect-automate/chat-platforms/slack', 'zh-CN')).toBe(
      'https://www.agentconnect.md/docs/zh/connect-automate/chat-platforms/slack'
    )
  })

  it("follows a deployment's HELP_DOCS_URL", () => {
    vi.stubGlobal('window', { __AC_ENV: { HELP_DOCS_URL: 'https://docs.example.test/' } })
    expect(docsPageUrl('connect-automate/triggers-automation/webhooks', 'en')).toBe(
      'https://docs.example.test/connect-automate/triggers-automation/webhooks'
    )
  })
})
