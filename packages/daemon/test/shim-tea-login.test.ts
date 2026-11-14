import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { AcpRunner, type ResolveCommand } from '../src/shim/acp-runner.js'
import { seedTeaLogin } from '../src/shim/tea-login.js'
import { resolveCommandPath } from '../src/runtimes/probe.js'

const PLACEHOLDER = 'acph1_example.placeholder'
const INSTANCE_URL = 'https://gitea.example.test/forge/'
const dirs: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-tea-login-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A proxied session's env: the placeholder git holds, and tea's two variables. */
const sessionEnv = (homeDir: string, extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: homeDir,
  AC_CODEHOST_CREDENTIAL: PLACEHOLDER,
  GITEA_TOKEN: PLACEHOLDER,
  GITEA_INSTANCE_URL: INSTANCE_URL,
  ...extra
})

const configAt = (homeDir: string): string => join(homeDir, '.config', 'tea', 'config.yml')

describe("tea's login in a shim's HOME", () => {
  it('puts the placeholder first as the default login and keeps the agent’s own logins', () => {
    const dir = home()
    mkdirSync(join(dir, '.config', 'tea'), { recursive: true })
    writeFileSync(
      configAt(dir),
      'logins:\n  - name: own\n    url: https://other.example.test\n    token: own-token\n    default: true\n' +
        '  - name: agentconnect\n    url: https://stale.example.test/\n    token: stale\npreferences:\n  editor: true\n'
    )
    seedTeaLogin(sessionEnv(dir))
    const config = parse(readFileSync(configAt(dir), 'utf8')) as { logins: unknown[]; preferences: unknown }
    expect(config.preferences).toEqual({ editor: true })
    expect(config.logins).toEqual([
      { name: 'agentconnect', url: INSTANCE_URL, token: PLACEHOLDER, default: true },
      { name: 'own', url: 'https://other.example.test', token: 'own-token', default: true }
    ])
    // Windows has no POSIX mode bits to check.
    if (process.platform !== 'win32') expect(statSync(configAt(dir)).mode & 0o777).toBe(0o600)
  })

  it('writes under XDG_CONFIG_HOME when the session names one', () => {
    const dir = home()
    const xdg = join(dir, 'xdg')
    mkdirSync(xdg)
    seedTeaLogin(sessionEnv(dir, { XDG_CONFIG_HOME: xdg }))
    expect(readFileSync(join(xdg, 'tea', 'config.yml'), 'utf8')).toContain(`token: ${PLACEHOLDER}`)
    expect(existsSync(configAt(dir))).toBe(false)
  })

  it('never writes a GITEA_TOKEN that is not the session’s placeholder', () => {
    const dir = home()
    seedTeaLogin(sessionEnv(dir, { GITEA_TOKEN: 'agent-own-token' }))
    seedTeaLogin({ HOME: dir, GITEA_TOKEN: PLACEHOLDER, GITEA_INSTANCE_URL: INSTANCE_URL })
    expect(existsSync(join(dir, '.config', 'tea'))).toBe(false)
  })

  it('leaves a file that is not a tea config as it is', () => {
    const dir = home()
    mkdirSync(join(dir, '.config', 'tea'), { recursive: true })
    writeFileSync(configAt(dir), '- not\n- a config\n')
    const warned: string[] = []
    seedTeaLogin(sessionEnv(dir), { warn: (message) => warned.push(message) })
    expect(readFileSync(configAt(dir), 'utf8')).toBe('- not\n- a config\n')
    expect(warned).toHaveLength(1)
  })

  // POSIX only: the links are symlinks.
  it.skipIf(process.platform === 'win32')('replaces a link at the config and never follows a linked directory', () => {
    const dir = home()
    const outside = join(dir, 'outside.yml')
    writeFileSync(outside, 'kept\n')
    mkdirSync(join(dir, '.config', 'tea'), { recursive: true })
    symlinkSync(outside, configAt(dir))
    seedTeaLogin(sessionEnv(dir))
    expect(readFileSync(outside, 'utf8')).toBe('kept\n')
    expect(readFileSync(configAt(dir), 'utf8')).toContain(`token: ${PLACEHOLDER}`)

    const linked = home()
    const target = join(linked, 'elsewhere')
    mkdirSync(target)
    mkdirSync(join(linked, '.config'))
    symlinkSync(target, join(linked, '.config', 'tea'))
    seedTeaLogin(sessionEnv(linked), { warn: () => {} })
    expect(existsSync(join(target, 'config.yml'))).toBe(false)
  })

  it('is written before a pod runtime spawns', async () => {
    const dir = home()
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: { HOME: dir, PATH: '/usr/bin' },
      resolveCommand: ((command) => command) satisfies ResolveCommand,
      log: { info: () => {}, warn: () => {} }
    } as never)
    const open = (runner as unknown as { open(payload: unknown): Promise<void> }).open.bind(runner)
    const { HOME: _home, ...daemonEnv } = sessionEnv(dir)
    await open({ op: 'open', command: 'true', args: [], env: daemonEnv }).catch(() => {})
    expect(readFileSync(configAt(dir), 'utf8')).toContain(`token: ${PLACEHOLDER}`)
    await runner.close(1_000).catch(() => {})
  })

  // Only where this machine has tea: the real CLI reads the login with every token-named variable gone.
  it.skipIf(resolveCommandPath('tea', process.env) === undefined)('is the login tea uses without GITEA_TOKEN', () => {
    const dir = home()
    seedTeaLogin(sessionEnv(dir))
    const out = execFileSync('tea', ['login', 'default'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }
    })
    expect(out.toString().trim()).toBe('Default Login: agentconnect')
  })
})
