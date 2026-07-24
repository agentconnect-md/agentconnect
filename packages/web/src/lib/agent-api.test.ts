import { describe, expect, it } from 'vitest'
import { agentApiSnippet, agentApiUrls } from './agent-api'

describe('agentApiUrls', () => {
  it('uses the deployment API base and escapes resource ids', () => {
    expect(agentApiUrls('https://api.example.test/v1/', 'org/one', 'agent two', 'https://relay.example.test/')).toEqual(
      {
        mintUrl: 'https://api.example.test/v1/orgs/org%2Fone/agents/agent%20two/webchat/token',
        socketTemplate: 'wss://relay.example.test/webchat?token=<token>&conversation_id=<conversationId>'
      }
    )
    expect(agentApiUrls('https://api.example.test/v1/', 'org', 'agent').socketTemplate).toBeNull()
  })
})

describe('agentApiSnippet', () => {
  it('keeps the API key out of source and safely quotes the prompt', () => {
    const snippet = agentApiSnippet('https://api.example.test/v1/token', 'Say "hello"\nnext')

    expect(snippet).toContain('process.env.AGENTCONNECT_API_KEY')
    expect(snippet).toContain('Say \\"hello\\"\\nnext')
    expect(snippet).toContain('conversation_id: credentials.conversationId')
    expect(snippet).not.toContain('ac_')
  })
})
