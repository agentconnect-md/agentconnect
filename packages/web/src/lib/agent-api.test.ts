import { describe, expect, it } from 'vitest'
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

describe('aiSdkProxySnippet', () => {
  it('keeps the key on the server and gives the browser only the proxy route', () => {
    const snippet = aiSdkProxySnippet('https://api.example.test/v1/token')

    expect(snippet).toContain('"https://api.example.test/v1/token"')
    expect(snippet).toContain('process.env.AGENTCONNECT_API_KEY')
    expect(snippet).toContain('/ai-sdk/chat/${minted.conversationId}')
    const browser = snippet.slice(snippet.indexOf('// Browser'))
    expect(browser).not.toContain('AGENTCONNECT_API_KEY')
    expect(browser).not.toContain('token')
  })
})
