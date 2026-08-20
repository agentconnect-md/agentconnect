import { describe, expect, it } from 'vitest'
import { CODEX_DEFAULT_ENDPOINT, codexGatewayAuthRequest } from '../src/runtimes/codex-config.js'

describe('codexGatewayAuthRequest', () => {
  it('carries the pair as one gateway grant — base routed, key in the auth header', () => {
    expect(JSON.parse(codexGatewayAuthRequest('https://gw.example/v1', 'sk-issued'))).toEqual({
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: 'https://gw.example/v1',
          headers: { Authorization: 'Bearer sk-issued' },
          providerName: 'AgentConnect model egress'
        }
      }
    })
  })

  it('names the runtime default endpoint an endpoint-less key falls through to', () => {
    expect(CODEX_DEFAULT_ENDPOINT).toBe('https://api.openai.com/v1')
  })
})
