import { describe, expect, it } from 'vitest'
import { isValidatedRemoteMcpRuntime } from '../src/mcp/remote-mcp-runtimes.js'
import type { ResolvedRuntimeEntry } from '../src/runtimes/registry.js'

const entry = (source: ResolvedRuntimeEntry['source'], command: string, args: string[] = []): ResolvedRuntimeEntry => ({
  runtime: { command, args, env: [] },
  source,
  name: command,
  version: ''
})

const validClaude = entry('registry', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.64.0'])
const validCodex = entry('registry', 'npx', ['-y', '@agentclientprotocol/codex-acp@1.1.7'])

describe('isValidatedRemoteMcpRuntime', () => {
  it('admits only the validated artifact at or above the validated version', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', validClaude)).toBe(true)
    expect(isValidatedRemoteMcpRuntime('codex-acp', validCodex)).toBe(true)
    expect(
      isValidatedRemoteMcpRuntime(
        'claude-acp',
        entry('registry', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.65.2'])
      )
    ).toBe(true)
    // Older than the release the §13 evidence covers fails closed.
    expect(
      isValidatedRemoteMcpRuntime(
        'claude-acp',
        entry('registry', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.63.9'])
      )
    ).toBe(false)
    // Unpinned or unparseable versions prove nothing about the artifact.
    expect(
      isValidatedRemoteMcpRuntime(
        'claude-acp',
        entry('registry', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp'])
      )
    ).toBe(false)
  })

  it('rejects a registry definition that drifts to a different command or package', () => {
    // The reviewer's exact scenario: registry-sourced claude-acp pointing at an
    // arbitrary executable must not be admitted.
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', '/opt/leaky-acp'))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', ['-y', 'leaky-agent-acp@0.64.0']))).toBe(
      false
    )
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('registry', 'npx', ['-y', '@evil/codex-acp@1.1.7']))).toBe(
      false
    )
    // The specifier must be the npx artifact argument, not a trailing flag.
    expect(
      isValidatedRemoteMcpRuntime(
        'claude-acp',
        entry('registry', 'npx', ['-y', 'leaky', '@agentclientprotocol/claude-agent-acp@0.64.0'])
      )
    ).toBe(false)
  })

  it('never admits a user-configured runtime, even one shadowing a validated id and artifact', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', { ...validClaude, source: 'user' })).toBe(false)
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('user', '/opt/leaky-acp'))).toBe(false)
  })

  it('never infers admission from claude/codex-looking launch lines (§13)', () => {
    expect(isValidatedRemoteMcpRuntime('custom', entry('user', '/opt/leaky-acp', ['codex-acp']))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('custom', entry('user', '/opt/leaky-acp', ['--profile=claude']))).toBe(false)
    // A non-validated adapter id stays out even with registry provenance.
    expect(isValidatedRemoteMcpRuntime('gemini', entry('registry', 'npx', ['-y', 'gemini-acp@1.0.0']))).toBe(false)
  })

  it('rejects a runtime with no resolved catalog entry', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', undefined)).toBe(false)
  })
})
