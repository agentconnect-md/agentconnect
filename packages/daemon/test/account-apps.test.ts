import { describe, expect, it } from 'vitest'
import { accountAppIsolation, codexConfigWithAccountAppsDisabled } from '../src/acp/account-apps.js'
import type { RuntimeDef } from '../src/config/config-schema.js'

const runtime = (command: string, args: string[] = []): RuntimeDef => ({ command, args, env: [] })

// Registry-default distributions, keyed by ACP runtime id (July 2026).
const REG: Record<string, RuntimeDef> = {
  'codex-acp': runtime('npx', ['-y', '@agentclientprotocol/codex-acp@1.1.7']),
  'claude-acp': runtime('npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.62.0']),
  'grok-build': runtime('npx', ['-y', '@xai-official/grok@0.2.112', 'agent', 'stdio']),
  'github-copilot-cli': runtime('npx', ['-y', '@github/copilot@1.0.75', '--acp']),
  'open-interpreter': runtime('interpreter', ['acp']),
  gemini: runtime('npx', ['-y', '@google/gemini-cli@0.52.0', '--acp']),
  'qwen-code': runtime('npx', ['-y', '@qwen-code/qwen-code@0.21.0', '--acp']),
  cursor: runtime('./dist-package/cursor-agent', ['acp']),
  auggie: runtime('npx', ['-y', '@augmentcode/auggie@0.33.0', '--acp']),
  opencode: runtime('./opencode', ['acp'])
}

describe('accountAppIsolation — disabled (verified switches)', () => {
  it('Codex: forces features.apps=false while preserving existing CODEX_CONFIG', () => {
    const result = accountAppIsolation('codex-acp', REG['codex-acp']!, {
      CODEX_CONFIG: JSON.stringify({ model: 'gpt-test', features: { fast_mode: true, apps: true } })
    })
    expect(result.status).toBe('disabled')
    expect(result.runtime).toBe('codex-acp')
    expect(result.appendArgs).toEqual([])
    expect(JSON.parse(result.env.CODEX_CONFIG!)).toEqual({
      model: 'gpt-test',
      features: { fast_mode: true, apps: false }
    })
  })

  it('Claude: sets ENABLE_CLAUDEAI_MCP_SERVERS=false and nothing else', () => {
    const result = accountAppIsolation('claude-acp', REG['claude-acp']!, { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' })
    expect(result.status).toBe('disabled')
    expect(result.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
    expect(result.appendArgs).toEqual([])
    expect(result.warning).toBeUndefined()
  })

  it('Grok: disables managed MCP gateway via env', () => {
    const result = accountAppIsolation('grok-build', REG['grok-build']!, {})
    expect(result.status).toBe('disabled')
    expect(result.env).toEqual({
      GROK_MANAGED_MCPS_ENABLED: 'false',
      GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: 'false'
    })
  })

  it('Copilot: appends --disable-builtin-mcps as a CLI arg, no env', () => {
    const result = accountAppIsolation('github-copilot-cli', REG['github-copilot-cli']!, {})
    expect(result.status).toBe('disabled')
    expect(result.env).toEqual({})
    expect(result.appendArgs).toEqual(['--disable-builtin-mcps'])
  })

  it('Open Interpreter: disables only inherited Codex account apps', () => {
    const result = accountAppIsolation('open-interpreter', REG['open-interpreter']!, {})
    expect(result.status).toBe('disabled')
    expect(result.env).toEqual({})
    expect(result.appendArgs).toEqual(['--disable', 'apps'])
  })
})

describe('accountAppIsolation — not-applicable (clean machine inherits nothing)', () => {
  // Includes cursor + opencode: their only account-bound path is enterprise-team /
  // org-scoped, never present on a clean personal machine, so they no-op here.
  it.each([
    'gemini',
    'qwen-code',
    'goose',
    'amp-acp',
    'cline',
    'kimi',
    'devin',
    'factory-droid',
    'pi-acp',
    'hermes',
    'hermes-agent',
    'kiro-cli',
    'maki',
    'openclaw',
    'zeroclaw',
    'omp',
    'cursor',
    'opencode'
  ])('no-ops for %s', (id) => {
    const result = accountAppIsolation(id, REG[id] ?? runtime(id), {})
    expect(result.status).toBe('not-applicable')
    expect(result.env).toEqual({})
    expect(result.appendArgs).toEqual([])
    expect(result.warning).toBeUndefined()
  })
})

describe('accountAppIsolation — no-switch (inherits connectors, no safe lever)', () => {
  it('warns without changing env/args for auggie', () => {
    const result = accountAppIsolation('auggie', REG.auggie!, {})
    expect(result.status).toBe('no-switch')
    expect(result.env).toEqual({})
    expect(result.appendArgs).toEqual([])
    expect(result.warning).toContain('auggie')
    expect(result.warning).toContain('no narrow switch')
  })
})

describe('accountAppIsolation — unknown runtime', () => {
  it('warns for an unrecognized runtime id', () => {
    const result = accountAppIsolation('some-new-agent', runtime('some-new-agent', ['acp']), {})
    expect(result.status).toBe('unknown')
    expect(result.env).toEqual({})
    expect(result.appendArgs).toEqual([])
    expect(result.warning).toContain('not verified')
  })
})

describe('accountAppIsolation — command/args fallback for the disable set', () => {
  it('catches Codex launched under a non-standard id via its adapter package', () => {
    const result = accountAppIsolation('my-codex', REG['codex-acp']!, {})
    expect(result.status).toBe('disabled')
    expect(result.runtime).toBe('codex-acp')
    expect(JSON.parse(result.env.CODEX_CONFIG!)).toEqual({ features: { apps: false } })
  })

  it('catches Copilot launched under a non-standard id', () => {
    const result = accountAppIsolation('gh-cli', REG['github-copilot-cli']!, {})
    expect(result.status).toBe('disabled')
    expect(result.appendArgs).toEqual(['--disable-builtin-mcps'])
  })

  it('catches Grok from a direct binary command', () => {
    const result = accountAppIsolation(undefined, runtime('/usr/local/bin/grok', ['agent', 'stdio']), {})
    expect(result.status).toBe('disabled')
    expect(result.env.GROK_MANAGED_MCPS_ENABLED).toBe('false')
  })
})

describe('accountAppIsolation — Codex unsafe inherited config', () => {
  it.each(['not-json', '[]', 'null', '{"features":true}'])(
    'warns, discards unsafe CODEX_CONFIG, and still forces apps off: %s',
    (raw) => {
      const result = accountAppIsolation('codex-acp', runtime('codex-acp'), { CODEX_CONFIG: raw })
      expect(result.status).toBe('disabled')
      expect(JSON.parse(result.env.CODEX_CONFIG!)).toEqual({ features: { apps: false } })
      expect(result.warning).toContain('ignoring unsafe inherited CODEX_CONFIG')
    }
  )
})

describe('codexConfigWithAccountAppsDisabled', () => {
  it('creates a minimal config when CODEX_CONFIG is absent', () => {
    expect(JSON.parse(codexConfigWithAccountAppsDisabled(undefined))).toEqual({ features: { apps: false } })
  })

  it.each(['not-json', '[]', 'null', '{"features":true}'])('rejects an unsafe existing config: %s', (raw) => {
    expect(() => codexConfigWithAccountAppsDisabled(raw)).toThrow(/CODEX_CONFIG/)
  })
})
