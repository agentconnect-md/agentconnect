import { describe, expect, it } from 'vitest'
import { isValidatedRemoteMcpRuntime } from '../src/mcp/remote-mcp-runtimes.js'
import type { ResolvedRuntimeEntry } from '../src/runtimes/registry.js'

const entry = (
  source: ResolvedRuntimeEntry['source'],
  command: string,
  args: string[] = [],
  env: Array<{ name: string; value: string }> = []
): ResolvedRuntimeEntry => ({
  runtime: { command, args, env },
  source,
  name: command,
  version: ''
})

const CLAUDE = ['-y', '@agentclientprotocol/claude-agent-acp@0.64.0']
const CODEX = ['-y', '@agentclientprotocol/codex-acp@1.1.7']

describe('isValidatedRemoteMcpRuntime', () => {
  it('admits exactly the validated launch shapes', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', CLAUDE))).toBe(true)
    // codex-acp is deliberately NOT admitted: @1.1.7 never exposes remote MCP
    // tools to the model, so §13's tool-execution evidence cannot be met.
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('registry', 'npx', CODEX))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('curated', 'npx', CLAUDE))).toBe(true)
  })

  it('admits no version the evidence does not cover — newer, older, or prerelease', () => {
    for (const version of ['0.65.0', '99.0.0', '0.63.9', '0.64.0-malicious', '0.64.0-rc.1', '0.64.1']) {
      expect(
        isValidatedRemoteMcpRuntime(
          'claude-acp',
          entry('registry', 'npx', ['-y', `@agentclientprotocol/claude-agent-acp@${version}`])
        )
      ).toBe(false)
    }
    // Unpinned specifiers name no artifact at all.
    expect(
      isValidatedRemoteMcpRuntime(
        'claude-acp',
        entry('registry', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp'])
      )
    ).toBe(false)
  })

  it('admits no added adapter argument or injected env var', () => {
    // A behavior-changing flag on the validated artifact is a different,
    // unvalidated launch configuration.
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', [...CLAUDE, '--log-mcp-headers']))).toBe(
      false
    )
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', ['--silent', ...CLAUDE]))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', CLAUDE.slice(1)))).toBe(false)
    expect(
      isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', CLAUDE, [{ name: 'DEBUG', value: '*' }]))
    ).toBe(false)
  })

  it('rejects a registry definition that drifts to a different command or package', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', '/opt/leaky-acp'))).toBe(false)
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', ['-y', 'leaky-agent-acp@0.64.0']))).toBe(
      false
    )
    expect(isValidatedRemoteMcpRuntime('codex-acp', entry('registry', 'npx', ['-y', '@evil/codex-acp@1.1.7']))).toBe(
      false
    )
    // The specifier must be the npx artifact argument, not a trailing value.
    expect(
      isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', ['-y', 'leaky', ...CLAUDE.slice(1)]))
    ).toBe(false)
    // Cross-adapter mixups fail closed.
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('registry', 'npx', CODEX))).toBe(false)
  })

  it('never admits a user-configured runtime, even one shadowing a validated id and launch', () => {
    expect(isValidatedRemoteMcpRuntime('claude-acp', entry('user', 'npx', CLAUDE))).toBe(false)
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
