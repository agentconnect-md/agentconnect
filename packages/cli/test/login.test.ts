import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { persistCredentials, runLogin, buildInstallOpts } from '../src/login.js'
import { resolveRoot } from '../src/paths.js'

function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ac-login-'))
}
function readConfig(root: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
}
const sink = () => {
  const lines: string[] = []
  const out = { write: (s: string) => (lines.push(s), true) } as unknown as NodeJS.WritableStream
  return { out, lines }
}
/** A readable that yields the given lines to readline, in order. */
const tty = (lines: string[]) => Readable.from(lines.map((l) => l + '\n')) as unknown as NodeJS.ReadableStream

describe('buildInstallOpts', () => {
  it('includeRootEnv is false for the default root', () => {
    const result = buildInstallOpts({ root: resolveRoot(undefined) })
    expect(result.includeRootEnv).toBe(false)
  })

  it('includeRootEnv is true for a non-default root', () => {
    const nonDefault = mkdtempSync(join(tmpdir(), 'ac-buildopts-'))
    const result = buildInstallOpts({ root: nonDefault })
    expect(result.includeRootEnv).toBe(true)
  })

  it('sets execPath to the current process executable', () => {
    const result = buildInstallOpts({})
    expect(result.execPath).toBe(process.execPath)
  })

  it('snapshots the invoking shell PATH as envPath', () => {
    const result = buildInstallOpts({})
    expect(result.envPath).toBe(process.env.PATH)
  })

  it('pins the CLI entry when supplied', () => {
    const result = buildInstallOpts({ cliEntry: '/cli/dist/index.js' })
    expect(result.cliEntry).toBe('/cli/dist/index.js')
    expect(buildInstallOpts({}).cliEntry).toBeUndefined()
  })
})

describe('persistCredentials', () => {
  it('writes controlPlane url/token and enables the control plane', () => {
    const root = emptyRoot()
    persistCredentials({ root, apiUrl: 'wss://cp.example/daemon/ws', apiKey: 'tok-123' })
    const raw = readConfig(root)
    expect(raw.controlPlane.url).toBe('wss://cp.example/daemon/ws')
    expect(raw.controlPlane.key).toBe('tok-123')
    expect(raw.controlPlane.enabled).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(root, 'config.json')).mode & 0o777).toBe(0o600)
  })

  it('persists daemonId only when explicitly provided', () => {
    const root = emptyRoot()
    persistCredentials({ root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' })
    expect(readConfig(root).daemonId).toBeUndefined()
    const root2 = emptyRoot()
    persistCredentials({ root: root2, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok', daemonId: 'fixed-id' })
    expect(readConfig(root2).daemonId).toBe('fixed-id')
  })

  it('preserves unrelated existing config keys', () => {
    const root = emptyRoot()
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, logging: { level: 'debug' }, runtimes: { claude: { command: 'npx', args: [] } } })
    )
    persistCredentials({ root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' })
    const raw = readConfig(root)
    expect(raw.logging.level).toBe('debug')
    expect(raw.runtimes.claude.command).toBe('npx')
    expect(raw.controlPlane.key).toBe('tok')
  })

  it.skipIf(process.platform === 'win32')('repairs an existing credential file to owner-only permissions', () => {
    const root = emptyRoot()
    const file = join(root, 'config.json')
    writeFileSync(file, JSON.stringify({ version: 1 }), { mode: 0o644 })
    chmodSync(file, 0o644)

    persistCredentials({ root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('runLogin — non-interactive (no TTY)', () => {
  it('throws a clear error when the api-url is missing', async () => {
    const { out } = sink()
    await expect(runLogin({ apiKey: 'tok' }, { isTTY: false, out })).rejects.toThrow(/--api-url/)
  })
  it('throws a clear error when the api-key is missing', async () => {
    const { out } = sink()
    await expect(runLogin({ apiUrl: 'wss://cp/daemon/ws' }, { isTTY: false, out })).rejects.toThrow(/--api-key/)
  })
  it('probes then persists on success', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const probe = vi.fn(async () => ({ ok: true, daemonId: 'd1' }))
    await runLogin({ root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' }, { isTTY: false, out, probe })
    expect(probe).toHaveBeenCalledOnce()
    expect(readConfig(root).controlPlane.key).toBe('tok')
  })
  it('does not persist when the probe fails', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const probe = vi.fn(async () => ({ ok: false, reason: 'bad token' }))
    await expect(
      runLogin({ root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'bad' }, { isTTY: false, out, probe })
    ).rejects.toThrow(/bad token/)
    expect(existsSync(join(root, 'config.json'))).toBe(false)
  })
})

describe('runLogin — interactive', () => {
  it('install=yes → installs+starts the service, no foreground handoff', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const installService = vi.fn(async () => {})
    const runForeground = vi.fn(async () => {})
    await runLogin(
      { root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' },
      {
        isTTY: true,
        out,
        input: tty(['y']),
        probe: async () => ({ ok: true, daemonId: 'd1' }),
        installService,
        runForeground
      }
    )
    expect(installService).toHaveBeenCalledOnce()
    expect(runForeground).not.toHaveBeenCalled()
    expect(readConfig(root).controlPlane.key).toBe('tok')
  })

  // `shellArg` quotes with POSIX single quotes, and a Windows path always needs quoting.
  it.skipIf(process.platform === 'win32')('repeats the instance selector in the manage-it hint', async () => {
    const root = emptyRoot()
    const { out, lines } = sink()
    await runLogin(
      { root, instance: 'dev', apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' },
      {
        isTTY: true,
        out,
        input: tty(['y']),
        probe: async () => ({ ok: true, daemonId: 'd1' }),
        installService: async () => {},
        runForeground: async () => {}
      }
    )
    // A bare `agentconnect status` after this would report the DEFAULT instance;
    // the custom root travels along because `--instance dev` alone means
    // ~/.agentconnect-dev.
    expect(lines.join('')).toContain(`\`agentconnect --instance dev --root ${root} up\``)
  })

  it('accepts an uppercase Y / YES at the install prompt', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const installService = vi.fn(async () => {})
    const runForeground = vi.fn(async () => {})
    await runLogin(
      { root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' },
      {
        isTTY: true,
        out,
        input: tty(['YES']),
        probe: async () => ({ ok: true, daemonId: 'd1' }),
        installService,
        runForeground
      }
    )
    expect(installService).toHaveBeenCalledOnce()
    expect(runForeground).not.toHaveBeenCalled()
  })

  it('rejects --config in interactive mode (handoff reads <root>/config.json)', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const probe = vi.fn(async () => ({ ok: true, daemonId: 'd1' }))
    const installService = vi.fn(async () => {})
    const runForeground = vi.fn(async () => {})
    await expect(
      runLogin(
        { root, configPath: join(root, 'custom.json'), apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' },
        { isTTY: true, out, input: tty(['y']), probe, installService, runForeground }
      )
    ).rejects.toThrow(/--config/)
    // Rejected before any probe / persist / handoff.
    expect(probe).not.toHaveBeenCalled()
    expect(installService).not.toHaveBeenCalled()
    expect(runForeground).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'custom.json'))).toBe(false)
  })

  it('install=no → runs in the foreground', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const installService = vi.fn(async () => {})
    const runForeground = vi.fn(async () => {})
    await runLogin(
      { root, apiUrl: 'wss://cp/daemon/ws', apiKey: 'tok' },
      {
        isTTY: true,
        out,
        input: tty(['n']),
        probe: async () => ({ ok: true, daemonId: 'd1' }),
        installService,
        runForeground
      }
    )
    expect(installService).not.toHaveBeenCalled()
    expect(runForeground).toHaveBeenCalledOnce()
  })

  it('prompts for url + token when not passed as flags', async () => {
    const root = emptyRoot()
    const { out, lines } = sink()
    const probe = vi.fn(async () => ({ ok: true, daemonId: 'd1' }))
    await runLogin(
      { root },
      {
        isTTY: true,
        out,
        input: tty(['wss://typed/daemon/ws', 'typed-tok', 'n']),
        probe,
        installService: async () => {},
        runForeground: async () => {}
      }
    )
    expect(probe).toHaveBeenCalledWith({ url: 'wss://typed/daemon/ws', token: 'typed-tok' })
    expect(readConfig(root).controlPlane.url).toBe('wss://typed/daemon/ws')
    expect(lines.join('')).toContain('AgentConnect API URL:')
    expect(lines.join('')).toContain('Daemon API key:')
  })

  it('retries once on bad token then succeeds', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'bad token' })
      .mockResolvedValueOnce({ ok: true, daemonId: 'd1' })
    await runLogin(
      { root, apiUrl: 'wss://cp/daemon/ws' },
      {
        isTTY: true,
        out,
        input: tty(['bad-tok', 'good-tok', 'n']),
        probe,
        installService: async () => {},
        runForeground: async () => {}
      }
    )
    expect(probe).toHaveBeenCalledTimes(2)
    expect(readConfig(root).controlPlane.key).toBe('good-tok')
  })

  it('rejects and persists nothing after two bad tokens', async () => {
    const root = emptyRoot()
    const { out } = sink()
    const probe = vi.fn(async () => ({ ok: false, reason: 'bad token' }))
    await expect(
      runLogin(
        { root, apiUrl: 'wss://cp/daemon/ws' },
        {
          isTTY: true,
          out,
          input: tty(['bad-1', 'bad-2', 'n']),
          probe,
          installService: async () => {},
          runForeground: async () => {}
        }
      )
    ).rejects.toThrow(/authentication failed/)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(existsSync(join(root, 'config.json'))).toBe(false)
  })
})
