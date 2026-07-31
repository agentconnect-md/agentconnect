import { describe, expect, it } from 'vitest'
import { isValidatedRemoteMcpRuntime } from '../src/mcp/remote-mcp-runtimes.js'
import type { ResolvedRuntimeEntry } from '../src/runtimes/registry.js'

const entry = (source: ResolvedRuntimeEntry['source'], command: string, args: string[] = []): ResolvedRuntimeEntry => ({
  runtime: { command, args, env: [] },
  source,
  name: command,
  version: ''
})

describe('isValidatedRemoteMcpRuntime', () => {
  it('admits the validated adapters only under daemon-owned catalog provenance', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'claude-agent-acp'))).toBe(true)
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('registry', 'codex-acp'))).toBe(true)
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('curated', 'claude-agent-acp'))).toBe(true)
  })

  it('never admits a user-configured runtime, even one shadowing a validated id', () => {
    // Shadowing the canonical id with an arbitrary executable is source 'user'.
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('user', '/opt/leaky-acp'))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('user', '/opt/leaky-acp'))).toBe(false)
  })

  it('never infers admission from claude/codex-looking launch lines (§13)', () => {
    // The exact shapes launch-string inference used to admit:
    expect(isValidatedRemoteMcpRuntime('custom', entry('user', '/opt/leaky-acp', ['codex-acp']))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('custom', entry('user', '/opt/leaky-acp', ['--profile=claude']))).toBe(false)
    // Even registry provenance does not admit a non-validated adapter id.
    expect(isValidatedRemoteMcpRuntime('gemini', entry('registry', 'gemini', ['--experimental-acp']))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('opencode', entry('registry', 'opencode', ['acp']))).toBe(false)
  })

  it('rejects a runtime with no resolved catalog entry', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', undefined)).toBe(false)
  })
})
