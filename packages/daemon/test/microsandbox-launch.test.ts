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
      mounts: [{ source: tool, target: '/tools/tool.js', readOnly: true }]
    })
    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.sandbox).toBeUndefined()
    expect(launch.microsandbox.workspaceRoot).toBe(opts.scopeDir)
    expect(launch.microsandbox.mounts).toEqual(
      expect.arrayContaining([
        { source: opts.cwd, target: opts.cwd, readOnly: false },
        { source: join(opts.scopeDir, 'home'), target: join(opts.scopeDir, 'home'), readOnly: false },
        { source: tool, target: tool, readOnly: true },
        { source: tool, target: '/tools/tool.js', readOnly: true }
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
      readOnly: true
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
    expect(launch.microsandbox.mounts).toContainEqual({ source: sessionDir, target: sessionDir, readOnly: false })
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
    const home = join(opts.scopeDir, 'sessions', hostKeyDirName(hostKey), 'home')
    expect(launch.runtimeHome).toBe(home)
    expect(launch.microsandbox.mounts).toContainEqual({ source: home, target: home, readOnly: false })
    expect(launch.microsandbox.mounts.some((mount) => mount.source === dirname(home))).toBe(false)
  })

  it('preserves the host Git helper and protects its guest alias and nested Git config as read-only mounts', () => {
    const opts = fixture()
    const helper = gitcredShimPath(opts.root)
    const gitConfig = join(opts.cwd, 'session.gitconfig')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, 'original host helper')
    writeFileSync(gitConfig, '[core]\n hooksPath = /dev/null\n')
    const trustedMounts = microsandboxSupportMounts(opts.root, gitConfig)
    expect(readFileSync(helper, 'utf8')).toBe('original host helper')
    expect(readFileSync(trustedMounts[0]!.source, 'utf8')).toBe(
      '#!/bin/sh\nexec /opt/agentconnect/bin/git-credential "$@"\n'
    )
    if (process.platform !== 'win32') expect(statSync(trustedMounts[0]!.source).mode & 0o777).toBe(0o755)
    expect(microsandboxSupportMounts(opts.root, join(opts.root, 'missing.gitconfig'))).toEqual([trustedMounts[0]])
    const launch = prepareMicrosandboxLaunch({ ...opts, trustedMounts })
    expect(launch.microsandbox.mounts).toEqual(
      expect.arrayContaining([
        { source: opts.cwd, target: opts.cwd, readOnly: false },
        { source: gitConfig, target: gitConfig, readOnly: true },
        { source: trustedMounts[0]!.source, target: helper, readOnly: true }
      ])
    )
    for (const target of [helper, dirname(helper), gitConfig]) {
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          trustedMounts,
          mounts: [{ source: opts.hostHome, target, readOnly: false }]
        })
      ).toThrow('overlaps an automatic')
    }
  })

  it('rejects operator mounts shadowing private data or socket bridges', () => {
    const opts = fixture()
    for (const target of [
      opts.scopeDir,
      join(opts.scopeDir, 'home', 'replacement'),
      '/run',
      '/var/run',
      '/run/docker',
      '/var/lib/docker',
      '/var/lib/docker/containerd',
      '/tmp/agentconnect',
      '/tmp'
    ]) {
      expect(() =>
        prepareMicrosandboxLaunch({ ...opts, mounts: [{ source: opts.hostHome, target, readOnly: false }] })
      ).toThrow('overlaps an automatic')
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
    expect(launch.microsandbox.mounts).toContainEqual({ source: auth, target: auth, readOnly: false })
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
        { source: cache, target: '/shared/cache', readOnly: false },
        { source: opts.hostHome, target: '/credential-copy', readOnly: false },
        { source: auth, target: '/credential-file', readOnly: true },
        { source: hostCodex, target: '/credential-dir', readOnly: false },
        { source: auth, target: '/credential-dir/auth.json', readOnly: false }
      ]
    })
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({ model: 'test-model' })
    const policy: CodexPermissionProfileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!)
    for (const profile of Object.values(policy.modeProfiles)) {
      const filesystem = policy.configOverrides.find((line) => line.startsWith(`permissions.${profile}.filesystem=`))!
      for (const path of ['/credential-copy/.codex/auth.json', '/credential-file', '/credential-dir/auth.json']) {
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
      mounts: [{ source: config, target: '/credential-copy', readOnly: false }]
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
    expect(launch.microsandbox.mounts).toContainEqual({ source: config, target: config, readOnly: false })
    expect(launch.microsandbox.mounts).toContainEqual({
      source: join(opts.scopeDir, '.agentconnect', 'runtime-policy'),
      target: join(opts.scopeDir, '.agentconnect', 'runtime-policy'),
      readOnly: true
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
