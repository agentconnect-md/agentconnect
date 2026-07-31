import { describe, expect, it } from 'vitest'
import { isValidatedRemoteMcpRuntime } from '../src/mcp/remote-mcp-runtimes.js'

const def = (command: string, args: string[] = []) => ({ command, args, env: [] })

describe('isValidatedRemoteMcpRuntime', () => {
  it('admits the curated claude adapter by launch line, not runtime id', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', def('claude-agent-acp'))).toBe(true)
    expect(isValidatedRemoteMcpRuntime('my-alias', def('npx', ['@zed-industries/claude-agent-acp']))).toBe(true)
  })

  it('admits the curated codex adapter, including versioned launch paths', () => {
    expect(isValidatedRemoteMcpRuntime('codex-acp', def('codex-acp'))).toBe(true)
    expect(isValidatedRemoteMcpRuntime('codex', def('/opt/tools/codex-acp@1.2.3'))).toBe(true)
  })

  it('rejects runtimes outside the validated allowlist even with generic HTTP MCP support', () => {
    expect(isValidatedRemoteMcpRuntime('opencode', def('opencode', ['acp']))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('gemini', def('gemini', ['--experimental-acp']))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('custom', def('/usr/local/bin/my-acp-agent'))).toBe(false)
  })

  it('rejects a runtime with no definition', () => {
    expect(isValidatedRemoteMcpRuntime('ghost', undefined)).toBe(false)
  })
})
