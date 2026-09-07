import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_ENDPOINT,
  codexConfigWithUserInputTool,
  codexGatewayAuthRequest
} from '../src/runtimes/codex-config.js'

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

describe('codexConfigWithUserInputTool', () => {
  it('turns on the feature that puts request_user_input in a Default-mode tool list', () => {
    expect(JSON.parse(codexConfigWithUserInputTool(undefined))).toEqual({
      features: { default_mode_request_user_input: true }
    })
  })

  it('merges into the features table instead of replacing the account-apps switch', () => {
    const raw = JSON.stringify({ model: 'gpt-test', features: { apps: false, memories: false } })
    expect(JSON.parse(codexConfigWithUserInputTool(raw))).toEqual({
      model: 'gpt-test',
      features: { apps: false, memories: false, default_mode_request_user_input: true }
    })
  })

  it('rejects a malformed config rather than silently dropping it', () => {
    expect(() => codexConfigWithUserInputTool('not-json')).toThrow('CODEX_CONFIG must be a valid JSON object')
    expect(() => codexConfigWithUserInputTool(JSON.stringify({ features: 'all' }))).toThrow(
      'CODEX_CONFIG.features must be a JSON object'
    )
  })
})
