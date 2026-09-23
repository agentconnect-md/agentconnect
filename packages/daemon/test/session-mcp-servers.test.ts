import { describe, expect, it } from 'vitest'
import { sessionMcpServersScope } from '../src/runtimes/session-mcp-servers.js'

describe('sessionMcpServersScope', () => {
  it('keeps the audited OpenCode lineage per process and every other runtime per session', () => {
    expect(sessionMcpServersScope('opencode')).toBe('per-process')
    expect(sessionMcpServersScope('kilo')).toBe('per-process')
    expect(sessionMcpServersScope('claude-acp')).toBe('per-session')
    expect(sessionMcpServersScope('codex-acp')).toBe('per-session')
  })

  it('lets a RuntimeDef declaration win, and a harness reusing an audited id inherit its scope until it declares one', () => {
    expect(sessionMcpServersScope('opencode', { sessionMcpServers: 'per-session' })).toBe('per-session')
    expect(sessionMcpServersScope('openclaw', { sessionMcpServers: 'unsupported' })).toBe('unsupported')
    expect(sessionMcpServersScope('custom', { sessionMcpServers: 'per-process' })).toBe('per-process')
    expect(sessionMcpServersScope('opencode', {})).toBe('per-process')
  })
})
