import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareMicrosandboxLaunch, type PrepareMicrosandboxLaunchOptions } from '../src/microsandbox/launch.js'
import { microsandboxSupportMounts } from '../src/microsandbox/support.js'
import { gitcredShimPath } from '../src/cp/gitcred-server.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { prepareRuntimeLaunch } from '../src/launch/prepare.js'
import { composeRuntimeLaunch } from '../src/launch/compose.js'
import { nativeRuntimeMemorySpecFor } from '../src/memory/runtime/capabilities.js'
import { nativeMemoryRead, nativeMemoryWrite } from '../src/memory/runtime/native.js'
import * as credentials from '../src/runtimes/runtime-credentials.js'
import {
  CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV,
  type CodexPermissionProfileConfig
} from '../src/acp/codex-permission-profiles.js'

const roots: string[] = []
function fixture(): PrepareMicrosandboxLaunchOptions & { root: string; hostHome: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-msb-')))
  roots.push(root)
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  const hostHome = join(root, 'host')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(hostHome)
  return {
    root,
    hostHome,
    runtimeId: 'test',
    scopeDir,
    cwd,
    mounts: [],
    stateSourceEnv: { HOME: hostHome }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('prepareMicrosandboxLaunch', () => {
  function openCodeFixture(auth: Record<string, unknown>) {
    const opts = { ...fixture(), runtimeId: 'opencode' }
    const source = join(opts.hostHome, '.local', 'share', 'opencode', 'auth.json')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, JSON.stringify(auth))
    return { opts, source }
  }

  it.skipIf(process.platform !== 'linux')(
    'projects OpenCode API keys and preserves OAuth records across refresh and key rotation',
    () => {
      const oauth = {
        type: 'oauth',
        access: 'fixture-oauth-access',
        refresh: 'fixture-refresh',
        expires: 1,
        accountId: 'fixture-account'
      }
      const auth = {
        opencode: { type: 'api', key: 'fixture-zen-key', metadata: { duplicate: 'fixture-zen-key' } },
        deepseek: { type: 'api', key: 'fixture-deepseek-key' },
        openai: oauth
      }
      const { opts, source } = openCodeFixture(auth)
      const launch = prepareMicrosandboxLaunch(opts)
      const path = join(launch.runtimeHome!, '.local', 'share', 'opencode', 'auth.json')
      const privateAuth = JSON.parse(readFileSync(path, 'utf8'))
      expect(privateAuth.openai).toEqual(oauth)
      expect(privateAuth.opencode.key).toMatch(/^msb-secret-OPENCODE_API_/)
      expect(privateAuth.deepseek.key).not.toBe(privateAuth.opencode.key)
      expect(launch.microsandbox.secrets!.map(({ host }) => host)).toEqual([['api.deepseek.com'], ['opencode.ai']])
      for (const key of [auth.opencode.key, auth.deepseek.key]) {
        expect(readFileSync(path, 'utf8')).not.toContain(key)
        expect(JSON.stringify(launch)).not.toContain(key)
      }
      expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(auth)
      privateAuth.openai.access = 'fixture-refreshed-access'
      writeFileSync(path, JSON.stringify(privateAuth))
      writeFileSync(source, JSON.stringify({ ...auth, opencode: { type: 'api', key: 'fixture-rotated-key' } }))
      const resumed = prepareMicrosandboxLaunch(opts)
      expect(resumed.microsandbox.secrets!.find(({ host }) => host.includes('opencode.ai'))!.readValue()).toBe(
        'fixture-rotated-key'
      )
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(privateAuth)
    }
  )

  it('keeps OAuth-only OpenCode launches on the existing unprotected credential path', () => {
    const oauth = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1 }
    const { opts, source } = openCodeFixture({ openai: oauth })
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toBeUndefined()
    expect(launch.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(readFileSync(join(launch.runtimeHome!, '.local', 'share', 'opencode', 'auth.json'), 'utf8')).toBe(
      readFileSync(source, 'utf8')
    )
  })

  it.skipIf(process.platform !== 'linux')('preserves every authorized host when OpenCode providers share a key', () => {
    const key = 'fixture-shared-"key\\value'
    const { opts } = openCodeFixture({ east: { type: 'api', key }, west: { type: 'api', key } })
    const config = {
      provider: {
        east: { options: { baseURL: 'https://east.example.test/v1', apiKey: key } },
        west: { options: { baseURL: 'https://west.example.test/v1', apiKey: key } }
      }
    }
    const source = join(opts.hostHome, '.config', 'opencode', 'opencode.json')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, JSON.stringify(config))
    const launch = prepareMicrosandboxLaunch({
      ...opts,
      explicitEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), MODEL_TOKEN: key }
    })
    expect(launch.microsandbox.secrets).toHaveLength(1)
    const secret = launch.microsandbox.secrets![0]!
    expect(secret.host).toEqual(['east.example.test', 'west.example.test'])
    const auth = JSON.parse(readFileSync(join(launch.runtimeHome!, '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
    const privateConfig = JSON.parse(
      readFileSync(join(launch.runtimeHome!, '.config', 'opencode', 'opencode.json'), 'utf8')
    )
    const envConfig = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)
    for (const provider of ['east', 'west']) {
      expect(auth[provider].key).toBe(secret.placeholder)
      expect(privateConfig.provider[provider].options.apiKey).toBe(secret.placeholder)
      expect(envConfig.provider[provider].options.apiKey).toBe(secret.placeholder)
    }
    expect(launch.env.MODEL_TOKEN).toBe(secret.placeholder)
    expect(secret.readValue()).toBe(key)
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(config)
  })

  it.skipIf(process.platform !== 'linux')(
    'uses trusted OpenCode JSONC routing and projects duplicate keys in config',
    () => {
      const key = 'fixture-custom-provider-key'
      const { opts, source } = openCodeFixture({ custom: { type: 'api', key } })
      const config = join(opts.hostHome, '.config', 'opencode', 'opencode.jsonc')
      mkdirSync(dirname(config), { recursive: true })
      writeFileSync(
        config,
        `// host config\n${JSON.stringify({ provider: { custom: { options: { baseURL: 'https://gateway.example.test/v1', apiKey: key } } } })}`
      )
      const launch = prepareMicrosandboxLaunch(opts)
      expect(launch.microsandbox.secrets![0]!.host).toEqual(['gateway.example.test'])
      const guestConfig = readFileSync(join(launch.runtimeHome!, '.config', 'opencode', 'opencode.jsonc'), 'utf8')
      expect(guestConfig).not.toContain(key)
      expect(guestConfig).toContain(launch.microsandbox.secrets![0]!.placeholder)
      for (const file of [source, config]) {
        expect(() =>
          prepareMicrosandboxLaunch({ ...opts, mounts: [{ source: file, target: '/config-copy', mode: 'readonly' }] })
        ).toThrow(/protected host (path|credential source)/)
      }
      expect(readFileSync(config, 'utf8')).toContain(key)
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'uses the OpenCode catalog for additional providers and preserves SRT seeding',
    () => {
      const key = 'fixture-catalog-provider-key'
      const { opts } = openCodeFixture({ catalog: { type: 'api', key } })
      const catalog = join(opts.hostHome, '.cache', 'opencode', 'models.json')
      mkdirSync(dirname(catalog), { recursive: true })
      writeFileSync(
        catalog,
        JSON.stringify({
          catalog: {
            api: 'https://api.example.test/v1',
            models: { alternate: { provider: { api: 'https://alternate.example.test/v1' } } }
          }
        })
      )
      const launch = prepareMicrosandboxLaunch(opts)
      expect(launch.microsandbox.secrets![0]!.host).toEqual(['alternate.example.test', 'api.example.test'])
      const srtScope = join(opts.root, 'srt')
      const srtCwd = join(srtScope, 'workspace')
      mkdirSync(srtCwd, { recursive: true })
      const srt = prepareRuntimeLaunch({
        ...opts,
        scopeDir: srtScope,
        cwd: srtCwd,
        runInSandbox: true,
        daemonRoot: opts.root,
        sandboxMechanism: 'bwrap'
      })
      expect(readFileSync(join(srt.runtimeHome!, '.local', 'share', 'opencode', 'auth.json'), 'utf8')).toContain(key)
    }
  )

  it('refuses unresolved or non-HTTPS OpenCode endpoints without including API keys in errors', () => {
    const { opts } = openCodeFixture({ custom: { type: 'api', key: 'fixture-secret-not-in-error' } })
    for (const baseURL of [undefined, 'http://gateway.example.test/v1']) {
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          explicitEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { custom: { options: { baseURL } } } }) }
        })
      ).toThrow('OpenCode launch refused')
    }
  })

  it.skipIf(process.platform !== 'linux').each(['legacy', 'versioned', 'dotenv'])(
    'protects %s DeepSeek keys while preserving other private provider credentials',
    (format) => {
      const opts = fixture()
      const hostDsh = join(opts.hostHome, '.dsh')
      const guestDsh = join(opts.scopeDir, 'home', '.dsh')
      mkdirSync(hostDsh)
      mkdirSync(guestDsh, { recursive: true })
      const key = 'fixture-deepseek-host-key'
      const file = format === 'dotenv' ? '.env' : '.credentials.yaml'
      const content =
        format === 'dotenv'
          ? `DEEPSEEK_API_KEY=${key}\nOPENROUTER_API_KEY=fixture-other-provider\n`
          : format === 'versioned'
            ? `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n  OPENROUTER_API_KEY: fixture-other-provider\nrecords:\n  login:\n    token: fixture-oauth-grant\n`
            : `DEEPSEEK_API_KEY: ${key}\nOPENROUTER_API_KEY: fixture-other-provider\n`
      writeFileSync(join(hostDsh, file), content)
      writeFileSync(join(guestDsh, file), content.replace('fixture-other-provider', 'fixture-private-login'))
      const launch = prepareMicrosandboxLaunch({ ...opts, runtimeId: 'dsh-acp' })
      const secret = launch.microsandbox.secrets![0]!
      expect(secret.readValue()).toBe(key)
      expect(launch.env.DEEPSEEK_API_KEY).toBe(secret.placeholder)
      expect(launch.env.NODE_EXTRA_CA_CERTS).toBe('/.msb/tls/ca.pem')
      expect(JSON.stringify(launch)).not.toContain(key)
      expect(secret.host).toBe('api.deepseek.com')
      const projected = readFileSync(join(guestDsh, file), 'utf8')
      expect(projected).not.toContain(key)
      expect(projected).toContain('fixture-private-login')
      expect(projected).toContain(secret.placeholder)
      if (format === 'versioned') expect(projected).toContain('fixture-oauth-grant')
      expect(readFileSync(join(hostDsh, file), 'utf8')).toBe(content)
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'rejects host credential mounts and symlinked private copies instead of modifying the host',
    () => {
      const opts = fixture()
      const hostDsh = join(opts.hostHome, '.dsh')
      mkdirSync(hostDsh)
      const source = join(hostDsh, '.credentials.yaml')
      const content = 'DEEPSEEK_API_KEY: fixture-host-key\n'
      writeFileSync(source, content)
      const deepseek = { ...opts, runtimeId: 'dsh-acp' }
      expect(() =>
        prepareMicrosandboxLaunch({ ...deepseek, mounts: [{ source: hostDsh, target: '/config', mode: 'readonly' }] })
      ).toThrow('protected host path')
      rmSync(source)
      expect(() =>
        prepareMicrosandboxLaunch({ ...deepseek, mounts: [{ source: hostDsh, target: '/config', mode: 'readonly' }] })
      ).toThrow('protected host path')
      writeFileSync(source, content)
      rmSync(join(opts.scopeDir, 'home', '.dsh', '.credentials.yaml'), { force: true })
      symlinkSync(source, join(opts.scopeDir, 'home', '.dsh', '.credentials.yaml'))
      expect(() => prepareMicrosandboxLaunch(deepseek)).toThrow('symlink')
      expect(readFileSync(source, 'utf8')).toBe(content)
    }
  )

  it('retains DSH file and guest login state when only another provider is configured', () => {
    const opts = fixture()
    const hostDsh = join(opts.hostHome, '.dsh')
    mkdirSync(hostDsh)
    writeFileSync(join(hostDsh, '.credentials.yaml'), 'OPENAI_API_KEY: fixture-openai-key\n')
    const launch = prepareMicrosandboxLaunch({ ...opts, runtimeId: 'dsh-acp' })
    expect(launch.microsandbox.secrets).toBeUndefined()
    const path = join(launch.runtimeHome!, '.dsh', '.credentials.yaml')
    expect(readFileSync(path, 'utf8')).toContain('fixture-openai-key')
    writeFileSync(path, 'OPENAI_API_KEY: fixture-guest-login\n')
    prepareMicrosandboxLaunch({ ...opts, runtimeId: 'dsh-acp' })
    expect(readFileSync(path, 'utf8')).toContain('fixture-guest-login')
  })

  it.skipIf(process.platform !== 'linux')(
    'uses an explicit key despite malformed host YAML and rejects an unsupported dotenv endpoint',
    () => {
      const opts = fixture()
      const hostDsh = join(opts.hostHome, '.dsh')
      mkdirSync(hostDsh)
      writeFileSync(join(hostDsh, '.credentials.yaml'), 'DEEPSEEK_API_KEY: first\nDEEPSEEK_API_KEY: second\n')
      const options = { ...opts, runtimeId: 'dsh-acp', explicitEnv: { DEEPSEEK_API_KEY: 'fixture-explicit-key' } }
      const launch = prepareMicrosandboxLaunch(options)
      expect(launch.microsandbox.secrets![0]!.readValue()).toBe('fixture-explicit-key')
      expect(existsSync(join(launch.runtimeHome!, '.dsh', '.credentials.yaml'))).toBe(false)
      writeFileSync(join(hostDsh, '.env'), 'DEEPSEEK_BASE_URL=https://gateway.example.test\n')
      expect(() => prepareMicrosandboxLaunch(options)).toThrow('launch refused')
    }
  )

  it('refuses custom TLS trust instead of silently dropping the operator bundle', () => {
    const opts = fixture()
    for (const name of [
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'GIT_SSL_CAINFO',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE'
    ]) {
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          runtimeId: 'dsh-acp',
          explicitEnv: { DEEPSEEK_API_KEY: 'fixture-key', [name]: '/operator/ca.pem' }
        })
      ).toThrow('custom TLS trust bundles')
    }
  })

  it('uses the same protected host roots as SRT for configured mounts', () => {
    const opts = fixture()
    for (const name of ['.codex', '.claude', '.dsh']) {
      const source = join(opts.hostHome, name)
      mkdirSync(source)
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          mounts: [{ source, target: '/config', mode: 'readonly' }]
        })
      ).toThrow('protected host path')
    }
  })

  it.skipIf(process.platform !== 'linux')(
    'keeps SRT credential seeding and masks explicit DeepSeek keys only for microsandbox',
    () => {
      const opts = fixture()
      mkdirSync(join(opts.hostHome, '.dsh'))
      const key = 'fixture-file-key'
      writeFileSync(join(opts.hostHome, '.dsh', '.credentials.yaml'), `DEEPSEEK_API_KEY: ${key}\n`)
      const srt = prepareRuntimeLaunch({
        ...opts,
        runtimeId: 'dsh-acp',
        runInSandbox: true,
        daemonRoot: opts.root,
        sandboxMechanism: 'bwrap'
      })
      expect(readFileSync(join(srt.runtimeHome!, '.dsh', '.credentials.yaml'), 'utf8')).toContain(key)
      const launch = prepareMicrosandboxLaunch({
        ...opts,
        runtimeId: 'dsh-acp',
        explicitEnv: { DEEPSEEK_API_KEY: 'fixture-explicit-key' }
      })
      expect(launch.microsandbox.secrets![0]!.readValue()).toBe('fixture-explicit-key')
      expect(JSON.stringify(launch)).not.toContain('fixture-explicit-key')
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          runtimeId: 'dsh-acp',
          explicitEnv: { DEEPSEEK_BASE_URL: 'https://proxy.example.test' }
        })
      ).toThrow('requires https://api.deepseek.com')
    }
  )

  it.each([
    ['claude-acp', false],
    ['claude-acp', true],
    ['codex-acp', false],
    ['codex-acp', true]
  ] as const)('matches SRT native policy for %s with session isolation=%s', (runtimeId, isolated) => {
    const opts = fixture()
    const hostKey = isolated ? sessionHostKey('test-agent', 'test-session') : undefined
    const sessionDir = hostKey ? join(opts.scopeDir, 'sessions', hostKeyDirName(hostKey)) : undefined
    const cwd = sessionDir ? join(sessionDir, 'workspace') : opts.cwd
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const original = credentials.prepareSharedRuntimeCredentials
    vi.spyOn(credentials, 'prepareSharedRuntimeCredentials').mockImplementation((options) =>
      original({ ...options, platform: 'linux' })
    )
    const runtime = { command: runtimeId === 'claude-acp' ? 'claude-agent-acp' : 'codex-acp', args: [], env: [] }
    const shared = { ...opts, cwd, hostKey, runtimeId, runtime, allowModelToolUnixSockets: true }
    const srt = prepareRuntimeLaunch({
      ...shared,
      runInSandbox: true,
      daemonRoot: opts.root,
      hostEnv: opts.stateSourceEnv,
      sandboxMechanism: 'bwrap'
    })
    const vm = prepareMicrosandboxLaunch({ ...shared, trustedSessionDir: sessionDir })
    expect(vm.toolSandbox).toEqual(srt.toolSandbox)
    expect(vm.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]).toEqual(srt.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV])
  })

  it('exposes only launch surfaces and preserves configured guest targets and an explicit guest PATH', () => {
    const opts = fixture()
    const tool = join(opts.root, 'tool.js')
    const missing = join(opts.root, 'missing.js')
    writeFileSync(tool, 'tool')
    const launch = prepareMicrosandboxLaunch({
      ...opts,
      stateSourceEnv: {
        HOME: opts.hostHome,
        PATH: '/host/bin',
        SSH_AUTH_SOCK: '/host/agent.sock',
        DBUS_SESSION_BUS_ADDRESS: 'unix:/host/bus',
        DOCKER_HOST: 'tcp://host-docker.example.test:2376',
        DOCKER_CONTEXT: 'host-desktop',
        DOCKER_CONFIG: '/host/docker',
        DOCKER_CERT_PATH: '/host/docker/certs',
        DOCKER_TLS: '1',
        DOCKER_TLS_VERIFY: '1',
        TESTCONTAINERS_HOST_OVERRIDE: 'host-docker.example.test'
      },
      trustedRuntimeReadRoots: [tool, missing],
      mounts: [{ source: tool, target: '/tools/tool.js', mode: 'readonly' }]
    })
    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.sandbox).toBeUndefined()
    expect(launch.microsandbox.workspaceRoot).toBe(opts.scopeDir)
    expect(launch.microsandbox.mounts).toEqual(
      expect.arrayContaining([
        { source: opts.cwd, target: opts.cwd, mode: 'writable' },
        { source: join(opts.scopeDir, 'home'), target: join(opts.scopeDir, 'home'), mode: 'writable' },
        { source: tool, target: tool, mode: 'readonly' },
        { source: tool, target: '/tools/tool.js', mode: 'readonly' }
      ])
    )
    expect(launch.microsandbox.mounts.some((mount) => mount.source === opts.scopeDir)).toBe(false)
    expect(existsSync(missing)).toBe(false)
    expect(launch.env.PATH).toBe(
      '/opt/agentconnect/pathbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    )
    expect(launch.env.SSH_AUTH_SOCK).toBeUndefined()
    expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    for (const name of [
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_CERT_PATH',
      'DOCKER_TLS',
      'DOCKER_TLS_VERIFY',
      'TESTCONTAINERS_HOST_OVERRIDE'
    ]) {
      expect(launch.env[name]).toBeUndefined()
    }
    expect(launch.env.TMPDIR).toBe('/tmp')
    expect(launch.env.AC_GITCRED_SOCKET).toBe('/tmp/agentconnect/gitcred.sock')
    const dockerConfig = join(opts.scopeDir, 'run', 'config-files', 'docker')
    const explicit = prepareMicrosandboxLaunch({
      ...opts,
      explicitEnv: { PATH: '/guest/tools:/usr/bin', DOCKER_CONFIG: dockerConfig }
    })
    expect(explicit.env.PATH).toBe('/guest/tools:/usr/bin')
    expect(explicit.env.DOCKER_CONFIG).toBe(dockerConfig)
    expect(explicit.microsandbox.mounts).toContainEqual({
      source: join(opts.scopeDir, 'run', 'config-files'),
      target: join(opts.scopeDir, 'run', 'config-files'),
      mode: 'readonly'
    })
  })

  it.each([
    ['claude-acp', 'CLAUDE_CODE_EXECUTABLE'],
    ['codex-acp', 'CODEX_PATH']
  ])('resolves %s executable hints in the guest unless explicitly configured', (command, envVar) => {
    const opts = fixture()
    const launchOpts = {
      ...opts,
      runtime: { command, args: [], env: [] },
      stateSourceEnv: { ...opts.stateSourceEnv, [envVar]: '/host/runtime' }
    }
    expect(prepareMicrosandboxLaunch(launchOpts).env[envVar]).toBeUndefined()
    expect(prepareMicrosandboxLaunch({ ...launchOpts, explicitEnv: { [envVar]: '/guest/runtime' } }).env[envVar]).toBe(
      '/guest/runtime'
    )
  })

  it('mounts one complete session for changing Git directories without exposing other sessions', () => {
    const opts = fixture()
    const sessionDir = join(opts.scopeDir, 'sessions', 'session-a')
    const cwd = join(sessionDir, 'workspace')
    const other = join(opts.scopeDir, 'sessions', 'session-b')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(other)
    const launch = prepareMicrosandboxLaunch({ ...opts, cwd, trustedSessionDir: sessionDir })
    expect(launch.runtimeHome).toBe(join(sessionDir, 'home'))
    expect(launch.microsandbox.mounts).toContainEqual({ source: sessionDir, target: sessionDir, mode: 'writable' })
    expect(
      launch.microsandbox.mounts.some((mount) => other === mount.target || other.startsWith(mount.target + '/'))
    ).toBe(false)
    expect(() => prepareMicrosandboxLaunch({ ...opts, trustedSessionDir: sessionDir })).toThrow(
      'cwd is outside its session'
    )
    expect(() => prepareMicrosandboxLaunch({ ...opts, trustedSessionDir: dirname(sessionDir) })).toThrow(
      'scopeDir/sessions/<leaf>'
    )
    expect(() => prepareMicrosandboxLaunch({ ...opts, trustedWorkspaceWriteRoots: [opts.scopeDir] })).toThrow(
      'not inside the agent dir'
    )
  })

  it('allows a one-off host to keep its private HOME separate from its input directory', () => {
    const opts = fixture()
    const hostKey = sessionHostKey('agent', 'internal-extraction')
    const cwd = join(opts.scopeDir, 'memory', 'extraction', 'input')
    mkdirSync(cwd, { recursive: true })
    const launch = prepareMicrosandboxLaunch({ ...opts, cwd, hostKey })
    const home = join(opts.scopeDir, 'runtime-homes', hostKeyDirName(hostKey), 'home')
    expect(launch.runtimeHome).toBe(home)
    expect(launch.microsandbox.mounts).toContainEqual({ source: home, target: home, mode: 'writable' })
    expect(launch.microsandbox.mounts.some((mount) => mount.source === dirname(home))).toBe(false)
    expect(existsSync(join(opts.scopeDir, 'sessions'))).toBe(false)
  })

  it('gives shared-workspace sessions separate homes without creating isolated workspace directories', () => {
    const opts = fixture()
    const first = prepareMicrosandboxLaunch({ ...opts, hostKey: sessionHostKey('agent', 'first') })
    const second = prepareMicrosandboxLaunch({ ...opts, hostKey: sessionHostKey('agent', 'second') })
    expect(first.runtimeHome).not.toBe(second.runtimeHome)
    for (const launch of [first, second]) {
      expect(launch.microsandbox.mounts).toContainEqual({ source: opts.cwd, target: opts.cwd, mode: 'writable' })
    }
    expect(first.microsandbox.mounts.some(({ target }) => target === second.runtimeHome)).toBe(false)
    expect(existsSync(join(opts.scopeDir, 'sessions'))).toBe(false)
  })

  it.each(['claude-acp', 'codex-acp'])(
    'keeps %s native memory on the Console store across shared-workspace VMs',
    async (runtimeId) => {
      const opts = fixture()
      const runtime = { command: runtimeId, args: [], env: [] }
      const agentHome = join(opts.scopeDir, 'home')
      const memory = nativeRuntimeMemorySpecFor(runtime, runtimeId)!
      const source = memory.readRoot(agentHome)
      for (const session of ['first', 'second']) {
        const { launch } = composeRuntimeLaunch({
          ...opts,
          runtimeId,
          runtime,
          provider: 'native',
          hostKey: sessionHostKey('agent', session),
          runInSandbox: true,
          microsandbox: { mounts: [] }
        })
        const mounts = launch.microsandbox!.mounts
        expect(mounts).toContainEqual({ source, target: memory.readRoot(launch.runtimeHome!), mode: 'writable' })
        expect(mounts.some((mount) => mount.source === agentHome)).toBe(false)
        expect(mounts.some((mount) => mount.source === join(agentHome, '.codex'))).toBe(false)
        writeFileSync(join(source, 'MEMORY.md'), session)
        expect((await nativeMemoryRead(agentHome, runtime, 'MEMORY.md')).content).toBe(session)
        await nativeMemoryWrite(agentHome, runtime, 'MEMORY.md', 'console edit')
        expect(readFileSync(join(source, 'MEMORY.md'), 'utf8')).toBe('console edit')
      }
    }
  )

  it('preserves the host Git helper and protects its guest alias and nested Git config as read-only mounts', () => {
    const opts = fixture()
    const helper = gitcredShimPath(opts.root)
    const gitConfig = join(opts.cwd, 'session.gitconfig')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, 'original host helper')
    writeFileSync(gitConfig, '[core]\n hooksPath = /dev/null\n')
    const trustedMounts = microsandboxSupportMounts(opts.root, gitConfig)
    const replacement = join(opts.root, 'replacement')
    mkdirSync(replacement)
    expect(readFileSync(helper, 'utf8')).toBe('original host helper')
    expect(readFileSync(trustedMounts[0]!.source, 'utf8')).toBe(
      '#!/bin/sh\nexec /opt/agentconnect/bin/git-credential "$@"\n'
    )
    if (process.platform !== 'win32') expect(statSync(trustedMounts[0]!.source).mode & 0o777).toBe(0o755)
    expect(microsandboxSupportMounts(opts.root, join(opts.root, 'missing.gitconfig'))).toEqual([trustedMounts[0]])
    const launch = prepareMicrosandboxLaunch({ ...opts, trustedMounts })
    expect(launch.microsandbox.mounts).toEqual(
      expect.arrayContaining([
        { source: opts.cwd, target: opts.cwd, mode: 'writable' },
        { source: gitConfig, target: gitConfig, mode: 'readonly' },
        { source: trustedMounts[0]!.source, target: helper, mode: 'readonly' }
      ])
    )
    for (const target of [helper, dirname(helper), gitConfig]) {
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          trustedMounts,
          mounts: [{ source: replacement, target, mode: 'writable' }]
        })
      ).toThrow('overlaps an automatic')
    }
  })

  it('rejects operator mounts shadowing private data or socket bridges', () => {
    const opts = fixture()
    const source = join(opts.root, 'replacement')
    mkdirSync(source)
    for (const target of [
      opts.scopeDir,
      join(opts.scopeDir, 'home'),
      join(opts.scopeDir, 'home', '.run', 'replacement'),
      '/run',
      '/var/run',
      '/run/docker',
      '/var/lib/docker',
      '/var/lib/docker/containerd',
      '/tmp/agentconnect',
      '/tmp'
    ]) {
      expect(() => prepareMicrosandboxLaunch({ ...opts, mounts: [{ source, target, mode: 'writable' }] })).toThrow(
        'overlaps an automatic'
      )
    }
    expect(() => prepareMicrosandboxLaunch({ ...opts, trustedRuntimeReadRoots: [opts.scopeDir] })).toThrow(
      'entire agent or host HOME'
    )
    expect(() =>
      prepareMicrosandboxLaunch({
        ...opts,
        runtime: { command: 'external', args: [], env: [], externalExecution: true }
      })
    ).toThrow('outside the microsandbox VM')
  })

  it('mounts a shared base inside each session HOME with private writes and protected runtime state', () => {
    const opts = fixture()
    opts.runtimeId = 'codex-acp'
    const source = join(opts.root, 'shared-store')
    mkdirSync(source)
    for (const leaf of ['session-one', 'session-two']) {
      const session = join(opts.scopeDir, 'sessions', leaf)
      const cwd = join(session, 'workspace')
      mkdirSync(cwd, { recursive: true })
      const launch = prepareMicrosandboxLaunch({
        ...opts,
        cwd,
        trustedSessionDir: session,
        mounts: [{ source, target: '~/.local/share/pnpm/store', mode: 'overlay' }]
      })
      const target = join(session, 'home', '.local/share/pnpm/store')
      expect(launch.microsandbox.mounts).toContainEqual({ source, target, mode: 'overlay' })
      expect(launch.toolSandbox?.sharedWriteRoots).toContain(target)
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          cwd,
          trustedSessionDir: session,
          mounts: [{ source, target: '~/.codex', mode: 'overlay' }]
        })
      ).toThrow('protected runtime state')
    }
  })

  it('reuses the native Codex auth-file link and exposes only the shared credential file', () => {
    const opts = fixture()
    const hostCodex = join(opts.hostHome, '.codex')
    const auth = join(hostCodex, 'auth.json')
    mkdirSync(hostCodex)
    writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-key' }))
    const original = credentials.prepareSharedRuntimeCredentials
    vi.spyOn(credentials, 'prepareSharedRuntimeCredentials').mockImplementation((options) =>
      original({ ...options, platform: 'linux' })
    )
    const launch = prepareMicrosandboxLaunch({ ...opts, runtimeId: 'codex-acp' })
    expect(readlinkSync(join(launch.runtimeHome!, '.codex', 'auth.json'))).toBe(auth)
    expect(launch.microsandbox.mounts).toContainEqual({ source: auth, target: auth, mode: 'writable' })
    expect(
      launch.microsandbox.mounts.some((mount) => mount.source === hostCodex || mount.source === opts.hostHome)
    ).toBe(false)
    const policy: CodexPermissionProfileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!)
    for (const profile of Object.values(policy.modeProfiles)) {
      const filesystem = policy.configOverrides.find((line) => line.startsWith(`permissions.${profile}.filesystem=`))!
      expect(filesystem).toContain(`${JSON.stringify(auth)} = "deny"`)
      expect(filesystem).toContain(`${JSON.stringify(join(launch.runtimeHome!, '.codex'))} = "deny"`)
    }
  })

  it('protects remapped credential aliases while keeping session HOME, clone Git, and guest caches writable', () => {
    const opts = fixture()
    const hostCodex = join(opts.hostHome, '.codex')
    const auth = join(hostCodex, 'auth.json')
    const sessionDir = join(opts.scopeDir, 'sessions', 'session-a')
    const cwd = join(sessionDir, 'workspace')
    const cache = join(opts.root, 'package-cache')
    mkdirSync(hostCodex)
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(cache)
    writeFileSync(auth, '{}')
    const original = credentials.prepareSharedRuntimeCredentials
    vi.spyOn(credentials, 'prepareSharedRuntimeCredentials').mockImplementation((options) =>
      original({ ...options, platform: 'linux' })
    )
    const launch = prepareMicrosandboxLaunch({
      ...opts,
      runtimeId: 'codex-acp',
      cwd,
      trustedSessionDir: sessionDir,
      allowModelToolUnixSockets: true,
      explicitEnv: { CODEX_CONFIG: JSON.stringify({ 'permissions.untrusted': {}, model: 'test-model' }) },
      mounts: [
        { source: cache, target: '/shared/cache', mode: 'writable' },
        { source: auth, target: '/credential-file', mode: 'readonly' },
        { source: auth, target: '/credential-dir/auth.json', mode: 'writable' }
      ]
    })
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({ model: 'test-model' })
    const policy: CodexPermissionProfileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!)
    for (const profile of Object.values(policy.modeProfiles)) {
      const filesystem = policy.configOverrides.find((line) => line.startsWith(`permissions.${profile}.filesystem=`))!
      for (const path of ['/credential-file', '/credential-dir/auth.json']) {
        expect(filesystem).toContain(`${JSON.stringify(path)} = "deny"`)
      }
    }
    const workspace = policy.configOverrides.find((line) =>
      line.startsWith(`permissions.${policy.modeProfiles.agent}.filesystem=`)
    )!
    for (const path of [launch.runtimeHome!, join(cwd, '.git'), '/shared/cache']) {
      expect(workspace).toContain(`${JSON.stringify(path)} = "write"`)
    }
    for (const part of ['config', 'hooks'])
      expect(workspace).toContain(`${JSON.stringify(join(cwd, '.git', part))} = "read"`)
    expect(workspace).not.toContain(JSON.stringify(cache))
    expect(policy.configOverrides).toContain(`permissions.${policy.modeProfiles.agent}.network.enabled=true`)
  })

  it('prepares Claude parent profile settings and native denies without an outer SRT wrapper', () => {
    const opts = fixture()
    const config = join(opts.hostHome, '.claude')
    mkdirSync(config)
    writeFileSync(join(config, '.credentials.json'), '{}')
    writeFileSync(join(config, 'settings.json'), '{}')
    const original = credentials.prepareSharedRuntimeCredentials
    vi.spyOn(credentials, 'prepareSharedRuntimeCredentials').mockImplementation((options) =>
      original({ ...options, platform: 'linux' })
    )
    const launch = prepareMicrosandboxLaunch({
      ...opts,
      runtimeId: 'claude-acp',
      runtime: { command: 'claude-agent-acp', args: [], env: [] },
      explicitEnv: { ANTHROPIC_CONFIG_DIR: '/untrusted-profile', ANTHROPIC_PROFILE: 'untrusted' },
      mounts: [{ source: join(config, '.credentials.json'), target: '/credential-copy', mode: 'writable' }]
    })
    expect(launch.sandbox).toBeUndefined()
    const profileRoot = join(opts.scopeDir, '.agentconnect', 'runtime-policy', 'claude-profile-disabled')
    expect(launch.env.ANTHROPIC_CONFIG_DIR).toBe(profileRoot)
    expect(launch.env.ANTHROPIC_PROFILE).toBeUndefined()
    expect(launch.toolSandbox?.claudeProtectedSettings?.env).toEqual({
      ANTHROPIC_CONFIG_DIR: profileRoot,
      ANTHROPIC_PROFILE: 'agentconnect-disabled'
    })
    expect(launch.toolSandbox?.protectedCredentialRoots).toEqual(
      expect.arrayContaining([config, join(launch.runtimeHome!, '.claude'), '/credential-copy'])
    )
    expect(launch.toolSandbox?.sharedWriteRoots).toBeUndefined()
    expect(launch.microsandbox.mounts).toContainEqual({ source: config, target: config, mode: 'writable' })
    expect(launch.microsandbox.mounts).toContainEqual({
      source: join(opts.scopeDir, '.agentconnect', 'runtime-policy'),
      target: join(opts.scopeDir, '.agentconnect', 'runtime-policy'),
      mode: 'readonly'
    })
  })

  it.skipIf(process.platform === 'win32')('filters host Unix sockets from file mounts', async () => {
    const opts = fixture()
    const socket = join(opts.root, 'ipc')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    try {
      const launch = prepareMicrosandboxLaunch({ ...opts, trustedRuntimeReadRoots: [socket] })
      expect(launch.microsandbox.mounts.some((mount) => mount.source === socket)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
