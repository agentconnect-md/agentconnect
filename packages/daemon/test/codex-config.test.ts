import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_ENDPOINT,
  CODEX_MCP_STARTUP_GRACE_MS,
  codexConfigWithGuardianPolicy,
  codexConfigWithMcpStartupGrace,
  codexConfigWithProjectDocFallback,
  codexConfigWithUserInputTool,
  codexGatewayAuthRequest,
  codexGuardianOperatorPolicy
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

describe('codexConfigWithMcpStartupGrace', () => {
  it('raises the grace a first turn waits for a still-starting MCP server', () => {
    expect(JSON.parse(codexConfigWithMcpStartupGrace(undefined))).toEqual({
      mcp_optional_startup_grace_ms: CODEX_MCP_STARTUP_GRACE_MS
    })
  })

  it('keeps every other field', () => {
    const raw = JSON.stringify({ model: 'gpt-test', features: { apps: false } })
    expect(JSON.parse(codexConfigWithMcpStartupGrace(raw))).toEqual({
      model: 'gpt-test',
      features: { apps: false },
      mcp_optional_startup_grace_ms: CODEX_MCP_STARTUP_GRACE_MS
    })
  })

  it('leaves a grace the caller already chose', () => {
    const raw = JSON.stringify({ mcp_optional_startup_grace_ms: 0 })
    expect(JSON.parse(codexConfigWithMcpStartupGrace(raw))).toEqual({ mcp_optional_startup_grace_ms: 0 })
  })

  it('rejects a malformed config rather than silently dropping it', () => {
    expect(() => codexConfigWithMcpStartupGrace('not-json')).toThrow('CODEX_CONFIG must be a valid JSON object')
  })
})

describe('codexConfigWithProjectDocFallback', () => {
  it('lets Codex read CLAUDE.md where a directory has no AGENTS.md', () => {
    expect(JSON.parse(codexConfigWithProjectDocFallback(JSON.stringify({ model: 'gpt-test' })))).toEqual({
      model: 'gpt-test',
      project_doc_fallback_filenames: ['CLAUDE.md']
    })
  })

  it('leaves fallbacks the caller already chose, even none', () => {
    const raw = JSON.stringify({ project_doc_fallback_filenames: [] })
    expect(JSON.parse(codexConfigWithProjectDocFallback(raw))).toEqual({ project_doc_fallback_filenames: [] })
  })
})

describe('codexGuardianOperatorPolicy', () => {
  it('frames the instructions as operator authorization inside a delimited block', () => {
    const policy = codexGuardianOperatorPolicy('  Escalate by posting to Slack #support.\n')
    expect(policy).toContain('trusted authorization')
    expect(policy).toContain(
      '<operator_instructions>\nEscalate by posting to Slack #support.\n</operator_instructions>'
    )
  })

  it('gives no policy for an agent without instructions', () => {
    expect(codexGuardianOperatorPolicy(undefined)).toBeUndefined()
    expect(codexGuardianOperatorPolicy('  \n')).toBeUndefined()
  })
})

describe('codexConfigWithGuardianPolicy', () => {
  it("sets the Guardian's extra policy and keeps every other field", () => {
    const raw = JSON.stringify({ model: 'gpt-test', auto_review: { timeout_ms: 5000 } })
    expect(JSON.parse(codexConfigWithGuardianPolicy(raw, 'Operator policy.'))).toEqual({
      model: 'gpt-test',
      auto_review: { timeout_ms: 5000, extra_policy: 'Operator policy.' }
    })
  })

  it('appends after an extra policy the caller already set', () => {
    const raw = JSON.stringify({ auto_review: { extra_policy: 'Deployment policy.' } })
    expect(JSON.parse(codexConfigWithGuardianPolicy(raw, 'Operator policy.'))).toEqual({
      auto_review: { extra_policy: 'Deployment policy.\n\nOperator policy.' }
    })
  })

  it('rejects a malformed auto_review rather than silently dropping it', () => {
    expect(() => codexConfigWithGuardianPolicy(JSON.stringify({ auto_review: 'on' }), 'p')).toThrow(
      'CODEX_CONFIG.auto_review must be a JSON object'
    )
    expect(() => codexConfigWithGuardianPolicy(JSON.stringify({ auto_review: { extra_policy: 1 } }), 'p')).toThrow(
      'CODEX_CONFIG.auto_review.extra_policy must be a string'
    )
  })
})
