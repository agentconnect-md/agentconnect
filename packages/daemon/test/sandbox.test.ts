import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { sandboxWrap, sandboxBoundary, SandboxError, detectSandbox, writeSandboxSettings } from '../src/acp/sandbox.js'
import { claudeInnerSandboxSettings } from '../src/acp/claude-runtime.js'

// Ordinary ACP hosts launch through one SRT provider process with an immutable,
// daemon-written policy rather than assembling bwrap arguments themselves.
describe('sandboxWrap', () => {
  it.skipIf(process.platform === 'linux')('does not advertise SRT on unsupported hosts', () => {
    expect(detectSandbox()).toBeUndefined()
  })

  it('passes the trusted settings path and untouched command argv to the provider', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-srt-wrap-'))
    const settingsPath = join(root, 'settings.json')
    const { cmd, args } = sandboxWrap('claude', ['acp'], {
      mechanism: 'bwrap',
      writable: [root],
      settingsPath,
      cwd: root
    })
    expect(cmd).toBe(process.execPath)
    expect(args.slice(-7)).toEqual([
      '__sandbox-runtime',
      settingsPath,
      String(process.pid),
      root,
      '--',
      'claude',
      'acp'
    ])
  })

  it('requires an absolute trusted settings path', () => {
    expect(() => sandboxWrap('x', [], { mechanism: 'bwrap', writable: [] })).toThrow(SandboxError)
    expect(() => sandboxWrap('x', [], { mechanism: 'bwrap', writable: [], settingsPath: 'settings.json' })).toThrow(
      SandboxError
    )
    expect(() =>
      sandboxWrap('x', [], { mechanism: 'bwrap', writable: [], settingsPath: join(tmpdir(), 'settings.json') })
    ).toThrow(SandboxError)
  })

  it('writes the Linux compatibility policy atomically outside writable roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-srt-settings-'))
    const agentDir = join(root, 'agent')
    const workspace = join(agentDir, 'workspace')
    const home = join(agentDir, 'home')
    const memory = join(agentDir, 'memory')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(home)
    mkdirSync(memory)
    const settingsPath = writeSandboxSettings(agentDir, {
      writable: [workspace, home, memory],
      denyRead: [agentDir],
      allowRead: [workspace, home, memory],
      gitSafeDirectories: [workspace]
    })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.network).toEqual({ allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true })
    expect(settings.filesystem).toMatchObject({
      denyRead: expect.arrayContaining([realpathSync(agentDir)]),
      allowWrite: [realpathSync(workspace), realpathSync(home), realpathSync(memory)],
      allowGitConfig: false
    })
    expect(settings.filesystem.denyWrite.some((path: string) => basename(path) === 'claude')).toBe(true)
    expect(settings.git.safeDirectories).toEqual([realpathSync(workspace)])
    expect(settingsPath.startsWith(`${workspace}/`)).toBe(false)
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
  })
})

// The escalation the reviewer found (#799): the writable set must never be derived
// from the mutable workspace.path, and the agent-dir ROOT (holding agent.json) must
// stay read-only so a confined runtime can't rewrite the config that controls it.
describe('sandboxBoundary', () => {
  const agentDir = join(tmpdir(), 'ac-agent-x')
  const sock = join(tmpdir(), 'run', 'mcp.sock')

  it('confines writes to cwd + runtime HOME + memory, not the agent root or socket dir', () => {
    const canonicalAgentDir = join(realpathSync(tmpdir()), 'ac-agent-x')
    const { writable } = sandboxBoundary({
      agentDir,
      cwd: join(agentDir, 'workspace'),
      runtimeHome: join(agentDir, 'home'),
      mcpSocketPath: sock
    })
    expect(writable).toContain(join(canonicalAgentDir, 'workspace'))
    expect(writable).toContain(join(canonicalAgentDir, 'home'))
    expect(writable).toContain(join(canonicalAgentDir, 'memory'))
    expect(writable).not.toContain(join(realpathSync(tmpdir()), 'run'))
    // The agent-dir root itself is never writable ⇒ agent.json and local state stay read-only.
    expect(writable).not.toContain(canonicalAgentDir)
  })

  it('rejects a cwd that escapes the trusted agent dir (the workspace.path=/ attack)', () => {
    const runtimeHome = join(agentDir, 'home')
    expect(() => sandboxBoundary({ agentDir, cwd: '/', runtimeHome, mcpSocketPath: sock })).toThrow(SandboxError)
    expect(() => sandboxBoundary({ agentDir, cwd: '/etc', runtimeHome, mcpSocketPath: sock })).toThrow(SandboxError)
    // cwd === agentDir is also rejected — binding it rw would expose agent.json.
    expect(() => sandboxBoundary({ agentDir, cwd: agentDir, runtimeHome, mcpSocketPath: sock })).toThrow(SandboxError)
  })

  it('refuses / as an agent dir', () => {
    expect(() => sandboxBoundary({ agentDir: '/', cwd: '/', runtimeHome: '/home', mcpSocketPath: sock })).toThrow(
      SandboxError
    )
  })

  it('rejects a runtime HOME outside the trusted agent dir', () => {
    expect(() =>
      sandboxBoundary({
        agentDir,
        cwd: join(agentDir, 'workspace'),
        runtimeHome: '/home/user',
        mcpSocketPath: sock
      })
    ).toThrow(SandboxError)
  })

  it('rejects a workspace symlink that resolves outside the trusted agent dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sandbox-boundary-'))
    const trusted = join(root, 'agent')
    const outside = join(root, 'outside')
    mkdirSync(join(trusted, 'home'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(trusted, 'workspace'))
    expect(() =>
      sandboxBoundary({
        agentDir: trusted,
        cwd: join(trusted, 'workspace'),
        runtimeHome: join(trusted, 'home')
      })
    ).toThrow(SandboxError)
  })

  it('rejects a managed-memory symlink that resolves outside the trusted agent dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sandbox-memory-'))
    const trusted = join(root, 'agent')
    const outside = join(root, 'outside')
    mkdirSync(join(trusted, 'workspace'), { recursive: true })
    mkdirSync(join(trusted, 'home'))
    mkdirSync(outside)
    symlinkSync(outside, join(trusted, 'memory'))
    expect(() =>
      sandboxBoundary({
        agentDir: trusted,
        cwd: join(trusted, 'workspace'),
        runtimeHome: join(trusted, 'home')
      })
    ).toThrow(SandboxError)
  })
})

// Behavioral regression for the /proc escape (#799): with a PID namespace the daemon's
// own PID must NOT be visible inside the sandbox, so /proc/<daemon-pid>/root/... cannot
// be used to reach the daemon's writable mount namespace. Runs only where bwrap exists
// (Linux CI); skipped elsewhere.
describe('bwrap PID isolation', () => {
  const hasBwrap = detectSandbox() === 'bwrap'

  it.skipIf(!hasBwrap)("the parent daemon's PID is not visible inside the sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sbx-'))
    const agentDir = join(dir, 'agent')
    const workspace = join(agentDir, 'workspace')
    const home = join(agentDir, 'home')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(home)
    const settingsPath = writeSandboxSettings(agentDir, {
      writable: [workspace, home],
      denyRead: [],
      allowRead: [],
      gitSafeDirectories: [workspace]
    })
    const outerPid = process.pid // the "daemon" PID; must be invisible in the child's /proc
    const { cmd, args } = sandboxWrap('sh', ['-c', `[ -e /proc/${outerPid} ] && echo LEAK || echo OK`], {
      mechanism: 'bwrap',
      writable: [workspace, home],
      settingsPath,
      cwd: workspace
    })
    const out = execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, HOME: home } }).trim()
    expect(out).toBe('OK')
  })
})

// The trusted Claude parent needs provider credentials to reach the model, but
// model-authored Bash must not inherit any supported direct/cloud auth secret.
describe('Claude credential environment isolation', () => {
  const hasBwrap = detectSandbox() === 'bwrap'

  it.skipIf(!hasBwrap)('hides protected provider credential env and files from sandboxed commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-claude-credential-env-'))
    const workspace = join(root, 'workspace')
    const identityTokenFile = join(root, 'identity.jwt')
    const identityToken = 'trusted-parent-identity-token'
    const awsWebIdentityTokenFile = join(root, 'aws-web-identity.jwt')
    const awsWebIdentityToken = 'trusted-parent-aws-token'
    const privateClaudeConfig = join(root, 'private-home', '.claude')
    const privateClaudeSettings = join(privateClaudeConfig, 'settings.json')
    const seededCredentialEnvironment = {
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'trusted-parent-container-token',
      AWS_WEB_IDENTITY_TOKEN_FILE: awsWebIdentityTokenFile
    }
    mkdirSync(workspace)
    mkdirSync(privateClaudeConfig, { recursive: true })
    writeFileSync(identityTokenFile, identityToken, { mode: 0o600 })
    writeFileSync(awsWebIdentityTokenFile, awsWebIdentityToken, { mode: 0o600 })
    writeFileSync(
      privateClaudeSettings,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'trusted-parent-settings-token' } }),
      { mode: 0o600 }
    )
    const settings = claudeInnerSandboxSettings([identityTokenFile, awsWebIdentityTokenFile, privateClaudeConfig])
    const names = settings.credentials.envVars.map(({ name }) => name)
    const restoredNames = new Set([...names, ...Object.keys(seededCredentialEnvironment)])
    const previous = new Map([...restoredNames].map((name) => [name, process.env[name]]))

    for (const name of names) process.env[name] = `secret-for-${name}`
    Object.assign(process.env, seededCredentialEnvironment)

    try {
      const config = SandboxRuntimeConfigSchema.parse({
        network: { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true },
        filesystem: { ...settings.filesystem, allowWrite: [workspace] },
        credentials: settings.credentials
      })
      await SandboxManager.initialize(config, async () => false)
      expect(readFileSync(identityTokenFile, 'utf8')).toBe(identityToken)
      expect(readFileSync(awsWebIdentityTokenFile, 'utf8')).toBe(awsWebIdentityToken)
      expect(readFileSync(privateClaudeSettings, 'utf8')).toContain('trusted-parent-settings-token')
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        '/usr/bin/env',
        undefined,
        undefined,
        undefined,
        workspace
      )
      const output = execFileSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: 'utf8'
      })
      const visible = new Set(
        output
          .split('\n')
          .map((line) => line.split('=', 1)[0])
          .filter(Boolean)
      )
      for (const name of names) expect(visible).not.toContain(name)
      for (const value of Object.values(seededCredentialEnvironment)) expect(output).not.toContain(value)

      for (const credentialFile of [identityTokenFile, awsWebIdentityTokenFile, privateClaudeSettings]) {
        const fileRead = await SandboxManager.wrapWithSandboxArgv(
          `/usr/bin/cat ${credentialFile}`,
          undefined,
          undefined,
          undefined,
          workspace
        )
        expect(() =>
          execFileSync(fileRead.argv[0]!, fileRead.argv.slice(1), {
            cwd: workspace,
            env: fileRead.env,
            stdio: ['ignore', 'pipe', 'pipe']
          })
        ).toThrow()
      }
    } finally {
      SandboxManager.cleanupAfterCommand()
      await SandboxManager.reset()
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
