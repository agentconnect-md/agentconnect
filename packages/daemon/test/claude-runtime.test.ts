import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AcpHost } from '../src/acp/acp-host.js'
import { augmentClaudeEfforts, isClaudeRuntimeDef, ULTRACODE_EFFORT } from '../src/runtime-defs/claude-runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs')

describe('isClaudeRuntimeDef', () => {
  it('matches claude-ish command lines (command or args, any case)', () => {
    expect(isClaudeRuntimeDef({ command: 'claude-code-acp', args: [], env: [] })).toBe(true)
    expect(isClaudeRuntimeDef({ command: 'npx', args: ['@zed-industries/claude-agent-acp'], env: [] })).toBe(true)
    expect(isClaudeRuntimeDef({ command: 'CLAUDE', args: [], env: [] })).toBe(true)
  })

  it('rejects non-Claude runtimes', () => {
    expect(isClaudeRuntimeDef({ command: 'codex-acp', args: [], env: [] })).toBe(false)
    expect(isClaudeRuntimeDef({ command: 'npx', args: ['opencode', 'acp'], env: [] })).toBe(false)
  })
})

describe('augmentClaudeEfforts', () => {
  it('appends max + ultracode after the advertised levels, preserving order', () => {
    expect(augmentClaudeEfforts(['default', 'low', 'high'])).toEqual([
      'default',
      'low',
      'high',
      'max',
      ULTRACODE_EFFORT
    ])
  })

  it('does not duplicate an already-advertised synthetic level', () => {
    expect(augmentClaudeEfforts(['low', 'max', 'high'])).toEqual(['low', 'max', 'high', ULTRACODE_EFFORT])
    expect(augmentClaudeEfforts(['max', ULTRACODE_EFFORT])).toEqual(['max', ULTRACODE_EFFORT])
  })

  it('never augments an empty list (a model with no effort selector must not gain levels)', () => {
    expect(augmentClaudeEfforts([])).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = ['low']
    augmentClaudeEfforts(input)
    expect(input).toEqual(['low'])
  })
})

describe('AcpHost.sessionConfigOptions (raw reconciled options)', () => {
  it('returns the per-session option set exactly as the agent advertised it', async () => {
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      { onUpdate: () => {}, env: { AC_MODELS: 'model-a,model-b' } }
    )
    await host.start()
    const sid = await host.newSession('/tmp')
    // The raw array from the last reconciled response — no synthetic entries,
    // nothing dropped (augmentation only ever happens in the derived accessors).
    expect(host.sessionConfigOptions(sid)).toEqual([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [
          { value: 'model-a', name: 'model-a' },
          { value: 'model-b', name: 'model-b' }
        ]
      }
    ])
    expect(host.sessionConfigOptions('s-unknown')).toBeUndefined()
    await host.stop()
  })
})
