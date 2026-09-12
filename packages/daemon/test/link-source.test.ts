import { describe, it, expect } from 'vitest'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { GithubReviewOrchestrator } from '../src/github/review-orchestrator.js'
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

// A code-host reply's footer brands by the host that publishes it: all three linked `?source=github`
// while the hint came from the one platform id every code-host hook turn runs under.
describe('code-host footer session link', () => {
  const attributionFor = async (provider: CodeHostProvider): Promise<string> => {
    const orchestrator = new GithubReviewOrchestrator({
      log: () => ({ warn: () => undefined }),
      agents: () => new Map([['bot-review', { id: 'bot-review', name: 'bot-review', runtime: 'claude' }]]),
      agentLink: () => 'https://console.example.test/agents/bot-review',
      runtimeNames: () => ({ claude: 'Claude Code' }),
      outwardSessionId: async () => 'out-1',
      hostForStoredSession: async () => undefined,
      sessionLink: (sessionId: string, source?: string) =>
        `https://console.example.test/sessions/${sessionId}${source ? `?source=${source}` : ''}`
    } as never)
    return (await orchestrator.githubCommentAttribution('bot-review', 'acp-1', provider)).sessionUrl
  }

  it.each(['github', 'gitlab', 'gitea'] as const)('links the session as %s', async (provider) => {
    expect(await attributionFor(provider)).toBe(`https://console.example.test/sessions/out-1?source=${provider}`)
  })
})
