import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { agentChatUrls, aiSdkProxySnippet } from './agent-api'

describe('agentChatUrls', () => {
  it('uses the deployment API base and relay, and escapes resource ids', () => {
    expect(
      agentChatUrls('https://api.example.test/v1/', 'org/one', 'agent two', 'https://relay.example.test/')
    ).toEqual({
      mintUrl: 'https://api.example.test/v1/orgs/org%2Fone/agents/agent%20two/webchat/token',
      chatTemplate: 'https://relay.example.test/ai-sdk/chat/{conversationId}'
    })
    expect(agentChatUrls('https://api.example.test/v1/', 'org', 'agent').chatTemplate).toBeNull()
  })
})

const MINT = 'https://api.example.test/v1/token'
const CONVERSATION = '11111111-1111-4111-8111-111111111111'

/** The snippet's server half, compiled and run with a fake `fetch`: its POST handler. */
function proxy(fetch: typeof globalThis.fetch): (req: Request) => Promise<Response> {
  const snippet = aiSdkProxySnippet(MINT)
  const server = snippet.slice(0, snippet.indexOf('// Browser'))
  const js = ts.transpileModule(server, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: { POST?: (req: Request) => Promise<Response> } = {}
  new Function('exports', 'fetch', 'process', js)(exports, fetch, { env: { AGENTCONNECT_API_KEY: 'example-key' } })
  return exports.POST!
}

const turn = (userTurns: number, cookie?: string) =>
  new Request('https://site.example.test/api/chat', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body: JSON.stringify({
      messages: Array.from({ length: userTurns }, (_, i) => ({ id: `m${i}`, role: 'user', parts: [] }))
    })
  })

describe('aiSdkProxySnippet', () => {
  it('keeps the key on the server and gives the browser only the proxy route', () => {
    const snippet = aiSdkProxySnippet(MINT)
    expect(snippet).toContain('process.env.AGENTCONNECT_API_KEY')
    const browser = snippet.slice(snippet.indexOf('// Browser'))
    expect(browser).not.toContain('AGENTCONNECT_API_KEY')
    expect(browser).toContain('api: "/api/chat"')
  })

  it('streams the relay answer back and continues one conversation per browser on one token', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === MINT) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer example-key')
        return Response.json({
          token: 'example-token',
          relayUrl: 'https://relay.example.test',
          conversationId: CONVERSATION,
          expiresAt: new Date(Date.now() + 300_000).toISOString()
        })
      }
      expect(String(url)).toBe(`https://relay.example.test/ai-sdk/chat/${CONVERSATION}`)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer example-token')
      return new Response('data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' }
      })
    })
    const POST = proxy(fetch as typeof globalThis.fetch)

    const first = await POST(turn(1))
    expect(await first.text()).toBe('data: [DONE]\n\n')
    expect(first.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(first.headers.get('set-cookie')).toContain(`chat_conversation=${CONVERSATION}`)

    // The follow-up continues the cookie's conversation on the cached token: no second mint.
    const second = await POST(turn(2, `chat_conversation=${CONVERSATION}`))
    expect(second.status).toBe(200)
    expect(fetch.mock.calls.filter(([url]) => String(url) === MINT)).toHaveLength(1)
  })
})
