import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, DUTY_ENFORCEMENT_ENV } from '../src/config/load-config.js'
import { McpServerDefSchema, RuntimeDefSchema, sessionRetentionMs } from '../src/config/config-schema.js'
import { CP_URL_ENV } from '@agentconnect.md/protocol'

function tmpRoot(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cfg-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify(config))
  return root
}

describe('loadConfig', () => {
  it('loads and validates a minimal config, applying defaults', () => {
    const root = tmpRoot({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] } }
    })
    const cfg = loadConfig({ root })
    expect(cfg.version).toBe(1)
    expect(cfg.runtimes.claude.command).toBe('npx')
    expect(cfg.security.isolateAccountApps).toBe(true)
    expect(cfg.security.workspaceGitAllowedOrigins).toEqual(['https://github.com', 'ssh://github.com'])
    expect(cfg.features.turnFinalContextRefresh).toBe(true)
    expect(cfg.limits.maxAgents).toBe(32)
    expect(cfg.agentsDir).toContain('agents')
    expect(cfg.sessions.retention).toBe('7d') // #485 session retention defaults on
  })

  // An envelope daemon is born with no config file and no key: the operator injects the
  // control plane's own address, and the pod's projected token is the credential.
  describe(`${CP_URL_ENV} (the in-cluster bootstrap)`, () => {
    const withEnv = <T>(value: string | undefined, run: () => T): T => {
      const previous = process.env[CP_URL_ENV]
      if (value === undefined) delete process.env[CP_URL_ENV]
      else process.env[CP_URL_ENV] = value
      try {
        return run()
      } finally {
        if (previous === undefined) delete process.env[CP_URL_ENV]
        else process.env[CP_URL_ENV] = previous
      }
    }

    it('supplies the control-plane URL and turns the connection on', () => {
      const cfg = withEnv('wss://api.example.test/daemon/ws', () => loadConfig({ root: tmpRoot({ version: 1 }) }))
      expect(cfg.controlPlane.url).toBe('wss://api.example.test/daemon/ws')
      expect(cfg.controlPlane.enabled).toBe(true)
      expect(cfg.controlPlane.key).toBeUndefined()
    })

    it('never overrides a URL the config or a flag already stated', () => {
      const root = tmpRoot({ version: 1, controlPlane: { enabled: true, url: 'wss://configured.example.test/x' } })
      const cfg = withEnv('wss://api.example.test/daemon/ws', () => loadConfig({ root }))
      expect(cfg.controlPlane.url).toBe('wss://configured.example.test/x')
    })

    it('still yields to --no-cp', () => {
      const cfg = withEnv('wss://api.example.test/daemon/ws', () =>
        loadConfig({ root: tmpRoot({ version: 1 }), overrides: { noCp: true } })
      )
      expect(cfg.controlPlane.enabled).toBe(false)
    })

    it('is ignored when blank, rather than configuring an empty endpoint', () => {
      const cfg = withEnv('   ', () => loadConfig({ root: tmpRoot({ version: 1 }) }))
      expect(cfg.controlPlane.url).toBeUndefined()
      expect(cfg.controlPlane.enabled).toBe(false)
    })
  })

  // A pool member's state root is an emptyDir, so its config.json is regenerated from defaults each start.
  describe(`${DUTY_ENFORCEMENT_ENV} (the pool member's rollout switch)`, () => {
    const withEnv = <T>(value: string | undefined, run: () => T): T => {
      const previous = process.env[DUTY_ENFORCEMENT_ENV]
      if (value === undefined) delete process.env[DUTY_ENFORCEMENT_ENV]
      else process.env[DUTY_ENFORCEMENT_ENV] = value
      try {
        return run()
      } finally {
        if (previous === undefined) delete process.env[DUTY_ENFORCEMENT_ENV]
        else process.env[DUTY_ENFORCEMENT_ENV] = previous
      }
    }

    it('is off when the variable is absent, keeping the shipped default', () => {
      const cfg = withEnv(undefined, () => loadConfig({ root: tmpRoot({ version: 1 }) }))
      expect(cfg.features.dutyEnforcement).toBe(false)
    })

    it('turns enforcement on for every accepted spelling of on', () => {
      for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
        const cfg = withEnv(value, () => loadConfig({ root: tmpRoot({ version: 1 }) }))
        expect(cfg.features.dutyEnforcement, value).toBe(true)
      }
    })

    it('turns enforcement off for every accepted spelling of off', () => {
      for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
        const cfg = withEnv(value, () => loadConfig({ root: tmpRoot({ version: 1 }) }))
        expect(cfg.features.dutyEnforcement, value).toBe(false)
      }
    })

    it('refuses an unparseable value rather than silently staying off', () => {
      expect(() => withEnv('maybe', () => loadConfig({ root: tmpRoot({ version: 1 }) }))).toThrow(
        new RegExp(DUTY_ENFORCEMENT_ENV)
      )
      expect(() => withEnv('2', () => loadConfig({ root: tmpRoot({ version: 1 }) }))).toThrow(/must be one of/)
    })

    it('is ignored when blank, so a chart templating an empty value decides nothing', () => {
      const root = tmpRoot({ version: 1, features: { dutyEnforcement: true } })
      expect(withEnv('   ', () => loadConfig({ root })).features.dutyEnforcement).toBe(true)
    })

    it('outranks a config file that says the opposite, in both directions', () => {
      const off = tmpRoot({ version: 1, features: { dutyEnforcement: false } })
      expect(withEnv('true', () => loadConfig({ root: off })).features.dutyEnforcement).toBe(true)
      const on = tmpRoot({ version: 1, features: { dutyEnforcement: true } })
      expect(withEnv('false', () => loadConfig({ root: on })).features.dutyEnforcement).toBe(false)
    })

    it('survives the auto-create path, so a fresh ephemeral root still comes up enforcing', () => {
      const root = mkdtempSync(join(tmpdir(), 'ac-cfg-')) // no config.json written
      const cfg = withEnv('1', () => loadConfig({ root, autoCreate: true }))
      expect(cfg.features.dutyEnforcement).toBe(true)
      // The generated file stays default-shaped — the env, not the disposable file, is the source.
      expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toEqual({ version: 1 })
    })

    it('applies on the optional (no file) path too', () => {
      const root = mkdtempSync(join(tmpdir(), 'ac-cfg-'))
      expect(withEnv('on', () => loadConfig({ root, optional: true })).features.dutyEnforcement).toBe(true)
    })
  })

  it("session retention accepts 'never' or any '<n>d' and maps to sweep windows", () => {
    expect(loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: 'never' } }) }).sessions.retention).toBe(
      'never'
    )
    // Any positive integer day count is a valid window.
    expect(loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '3d' } }) }).sessions.retention).toBe('3d')
    expect(loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '90d' } }) }).sessions.retention).toBe('90d')
    // Legacy keywords from existing local config files normalize to day counts.
    expect(loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '2weeks' } }) }).sessions.retention).toBe(
      '14d'
    )
    expect(loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '1month' } }) }).sessions.retention).toBe(
      '30d'
    )
    // Zero / non-day shapes are rejected.
    expect(() => loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '0d' } }) })).toThrow()
    expect(() => loadConfig({ root: tmpRoot({ version: 1, sessions: { retention: '7' } }) })).toThrow()
    expect(sessionRetentionMs('never')).toBeNull()
    expect(sessionRetentionMs('7d')).toBe(7 * 24 * 3_600_000)
    expect(sessionRetentionMs('3d')).toBe(3 * 24 * 3_600_000)
    expect(sessionRetentionMs('30d')).toBe(30 * 24 * 3_600_000)
    expect(sessionRetentionMs('90d')).toBe(90 * 24 * 3_600_000)
  })

  it.skipIf(process.platform === 'win32')('repairs an existing config file to owner-only permissions', () => {
    const root = tmpRoot({ version: 1 })
    const file = join(root, 'config.json')
    chmodSync(file, 0o644)

    loadConfig({ root })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rejects an invalid config (bad version)', () => {
    const root = tmpRoot({ version: 2, runtimes: {} })
    expect(() => loadConfig({ root })).toThrow()
  })

  it('throws a clear error when the config file is missing and not optional', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-cfg-')) // no config.json written
    expect(() => loadConfig({ root })).toThrow(/config not found/)
  })

  it('optional: returns schema defaults (CP disabled, no runtimes) when config is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-cfg-')) // no config.json written
    const cfg = loadConfig({ root, optional: true })
    expect(cfg.version).toBe(1)
    expect(cfg.runtimes).toBeUndefined() // none from file → resolveRuntimes fills from registry
    expect(cfg.limits.maxAgents).toBe(32)
    expect(cfg.agentsDir).toContain('agents')
  })

  it('autoCreate: writes an empty config (CP disabled) when absent and runs local', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-cfg-')) // no config.json written
    const file = join(root, 'config.json')
    expect(existsSync(file)).toBe(false)
    const cfg = loadConfig({ root, autoCreate: true })
    expect(existsSync(file)).toBe(true) // file was generated
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(cfg.controlPlane?.enabled).toBe(false) // fully local, no CP
    expect(cfg.limits.maxAgents).toBe(32)
  })

  it('applies CLI/env overrides over file values', () => {
    const root = tmpRoot({
      version: 1,
      controlPlane: { enabled: true, url: 'wss://file.example/daemon' },
      runtimes: { claude: { command: 'npx', args: [] } }
    })
    const cfg = loadConfig({
      root,
      overrides: { apiUrl: 'wss://override.example/daemon', logLevel: 'debug', requireSandbox: true }
    })
    expect(cfg.controlPlane?.url).toBe('wss://override.example/daemon')
    expect(cfg.logging.level).toBe('debug')
    expect(cfg.security.requireSandbox).toBe(true)
  })

  it('allows the daemon to opt out of account-app isolation explicitly', () => {
    const root = tmpRoot({ version: 1, security: { isolateAccountApps: false } })
    expect(loadConfig({ root }).security.isolateAccountApps).toBe(false)
  })

  it('enables turn-final context refresh only through the explicit rollout flag', () => {
    const root = tmpRoot({ version: 1, features: { turnFinalContextRefresh: true } })
    expect(loadConfig({ root }).features.turnFinalContextRefresh).toBe(true)
  })

  it('normalizes an operator-owned workspace Git origin allowlist', () => {
    const root = tmpRoot({
      version: 1,
      security: {
        workspaceGitAllowedOrigins: ['HTTPS://Git.Example.:443/', 'ssh://git.example:2222']
      }
    })
    expect(loadConfig({ root }).security.workspaceGitAllowedOrigins).toEqual([
      'https://git.example',
      'ssh://git.example:2222'
    ])
  })

  it('allows remote Git to be disabled and rejects path-scoped origin rules', () => {
    expect(
      loadConfig({ root: tmpRoot({ version: 1, security: { workspaceGitAllowedOrigins: [] } }) }).security
    ).toMatchObject({ workspaceGitAllowedOrigins: [] })
    const root = tmpRoot({
      version: 1,
      security: { workspaceGitAllowedOrigins: ['https://git.example/acme'] }
    })
    expect(() => loadConfig({ root })).toThrow(/workspace Git origins/)
  })

  it('passing --api-url/--api-key enables the control plane (defaults off)', () => {
    const root = tmpRoot({ version: 1 }) // no controlPlane block → enabled defaults false
    const cfg = loadConfig({ root, overrides: { apiUrl: 'ws://cp/daemon/ws', apiKey: 'tok' } })
    expect(cfg.controlPlane.enabled).toBe(true)
    expect(cfg.controlPlane.url).toBe('ws://cp/daemon/ws')
    expect(cfg.controlPlane.key).toBe('tok')
  })

  it('--no-cp wins even when --api-url is also passed', () => {
    const root = tmpRoot({ version: 1 })
    const cfg = loadConfig({ root, overrides: { apiUrl: 'ws://cp/daemon/ws', noCp: true } })
    expect(cfg.controlPlane.enabled).toBe(false)
  })

  it('loads configured MCP servers (defaults applied)', () => {
    const root = tmpRoot({
      version: 1,
      mcpServers: {
        files: { command: 'mcp-files' },
        search: { transport: 'http', url: 'http://localhost:9000/mcp' }
      }
    })
    const cfg = loadConfig({ root })
    expect(cfg.mcpServers?.files).toEqual({ transport: 'stdio', command: 'mcp-files', args: [], env: [], headers: [] })
    expect(cfg.mcpServers?.search?.url).toBe('http://localhost:9000/mcp')
  })

  it('accepts operator-owned runtime and stdio MCP read roots', () => {
    expect(RuntimeDefSchema.parse({ command: 'runtime', readRoots: ['/opt/runtime'] }).readRoots).toEqual([
      '/opt/runtime'
    ])
    expect(McpServerDefSchema.parse({ command: 'mcp', readRoots: ['/opt/mcp'] }).readRoots).toEqual(['/opt/mcp'])
  })

  it('loads an operator-owned stdio memory-plugin allowlist', () => {
    const root = tmpRoot({
      version: 1,
      memoryPlugins: {
        'mem0-oss': {
          command: '/opt/agentconnect/mem0-wrapper',
          args: ['--stdio'],
          env: [{ name: 'MEM0_DIALECT', value: 'oss' }],
          secretEnv: { apiKey: 'MEM0_API_KEY' }
        }
      }
    })
    expect(loadConfig({ root }).memoryPlugins?.['mem0-oss']).toEqual({
      command: '/opt/agentconnect/mem0-wrapper',
      args: ['--stdio'],
      env: [{ name: 'MEM0_DIALECT', value: 'oss' }],
      secretEnv: { apiKey: 'MEM0_API_KEY' }
    })
  })

  it('rejects path-like command references and colliding static/secret env targets', () => {
    expect(() =>
      loadConfig({
        root: tmpRoot({ version: 1, memoryPlugins: { '../../tenant-command': { command: 'wrapper' } } })
      })
    ).toThrow(/commandRef/)
    expect(() =>
      loadConfig({
        root: tmpRoot({
          version: 1,
          memoryPlugins: {
            local: {
              command: 'wrapper',
              env: [{ name: 'MEM0_API_KEY', value: 'static' }],
              secretEnv: { apiKey: 'MEM0_API_KEY' }
            }
          }
        })
      })
    ).toThrow(/secret env/)
  })
})

describe('McpServerDefSchema', () => {
  it('defaults to stdio and fills args/env/headers', () => {
    const def = McpServerDefSchema.parse({ command: 'mcp-files' })
    expect(def).toEqual({ transport: 'stdio', command: 'mcp-files', args: [], env: [], headers: [] })
  })

  it('accepts http/sse defs with a url', () => {
    expect(McpServerDefSchema.parse({ transport: 'http', url: 'http://h/mcp' }).transport).toBe('http')
    expect(McpServerDefSchema.parse({ transport: 'sse', url: 'http://h/sse' }).transport).toBe('sse')
  })

  it('rejects a stdio def without a command', () => {
    expect(() => McpServerDefSchema.parse({})).toThrow(/command/)
    expect(() => McpServerDefSchema.parse({ transport: 'stdio', url: 'http://h' })).toThrow(/command/)
  })

  it('rejects an http/sse def without a url', () => {
    expect(() => McpServerDefSchema.parse({ transport: 'http', command: 'x' })).toThrow(/url/)
    expect(() => McpServerDefSchema.parse({ transport: 'sse' })).toThrow(/url/)
  })
})
