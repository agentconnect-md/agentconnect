import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
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
import {
  sandboxWrap,
  sandboxBoundary,
  SandboxError,
  detectSandbox,
  probeSandboxHost,
  writeSandboxSettings
} from '../src/acp/sandbox.js'
import { claudeInnerSandboxSettings } from '../src/runtime-defs/claude-runtime.js'
import { clearConfigFiles, configFilesDir, materializeConfigFiles } from '../src/shim/config-file-env.js'

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

  // Asserts the policy file lands 0600, and Windows carries no POSIX mode bits.
  it.skipIf(process.platform === 'win32')(
    'writes the Linux compatibility policy atomically outside writable roots',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ac-srt-settings-'))
      const agentDir = join(root, 'agent')
      const workspace = join(agentDir, 'workspace')
      const home = join(agentDir, 'home')
      const memory = join(agentDir, 'memory')
      mkdirSync(workspace, { recursive: true })
      mkdirSync(home)
      mkdirSync(memory)
      const settingsPath = writeSandboxSettings(agentDir, 'agent', {
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
    }
  )
})

// #956: a host missing SRT's own dependencies confines nothing and installs no
// managed skills. The probe already knew; the reason has to survive it so the
// daemon's startup preflight can name what is missing.
describe('probeSandboxHost', () => {
  it.skipIf(process.platform === 'linux')('names the unsupported platform', () => {
    expect(probeSandboxHost()).toEqual({ mechanism: undefined, reason: `unsupported platform ${process.platform}` })
  })

  it.runIf(process.platform === 'linux')('keeps the provider failure as one bounded line', () => {
    // An empty PATH is how the reported host looked to the daemon: SRT's rg/socat lookup fails.
    const probe = probeSandboxHost({ ...process.env, PATH: '/nonexistent' })
    expect(probe.mechanism).toBeUndefined()
    expect(probe.reason).toBeTruthy()
    expect(probe.reason).not.toContain('\n')
    expect(probe.reason!.length).toBeLessThanOrEqual(300)
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
    const settingsPath = writeSandboxSettings(agentDir, 'agent', {
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

// A warm bwrap process binds the config-files directory once. Idle cleanup must
// retain that inode so files written for the next turn appear through the live
// mount rather than at a new host path the sandbox cannot see.
describe('bwrap config-file rematerialization', () => {
  const hasBwrap = detectSandbox() === 'bwrap'

  it.skipIf(!hasBwrap)('keeps a rematerialized kubeconfig visible inside the warm sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sbx-config-'))
    const agentDir = join(root, 'agent')
    const workspace = join(agentDir, 'workspace')
    const home = join(agentDir, 'home')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(home)
    materializeConfigFiles(agentDir, { KUBECONFIG_DATA: 'first' })
    const kubeconfig = join(configFilesDir(agentDir), 'kubeconfig')
    const configRootInode = statSync(configFilesDir(agentDir)).ino
    const settingsPath = writeSandboxSettings(
      agentDir,
      'agent',
      sandboxBoundary({ agentDir, cwd: workspace, runtimeHome: home })
    )
    const { cmd, args } = sandboxWrap(
      'sh',
      [
        '-c',
        'printf "before:"; cat "$KUBECONFIG"; printf "\\n"; read _; printf "after:"; cat "$KUBECONFIG"; printf "\\n"'
      ],
      { mechanism: 'bwrap', writable: [workspace, home], settingsPath, cwd: workspace }
    )
    const child = spawn(cmd, args, {
      cwd: workspace,
      env: { ...process.env, HOME: home, KUBECONFIG: kubeconfig },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)

    try {
      await expect.poll(() => stdout, { timeout: 5_000 }).toContain('before:first\n')
      expect(clearConfigFiles(agentDir)).toBeUndefined()
      expect(existsSync(kubeconfig)).toBe(false)
      expect(statSync(configFilesDir(agentDir)).ino).toBe(configRootInode)
      materializeConfigFiles(agentDir, { KUBECONFIG_DATA: 'second' })
      expect(statSync(configFilesDir(agentDir)).ino).toBe(configRootInode)
      child.stdin.end('continue\n')

      expect(await closed, stderr).toBe(0)
      expect(stdout).toBe('before:first\nafter:second\n')
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
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
    const privateHome = join(root, 'private-home')
    const privateTmp = join(privateHome, '.tmp')
    const privateClaudeConfig = join(privateHome, '.claude')
    const privateClaudeSettings = join(privateClaudeConfig, 'settings.json')
    const credentialSocket = join(root, 'run', 'gitcred.sock')
    let credentialRequest: Record<string, unknown> | undefined
    const credentialServer = createServer((socket) => {
      let input = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        input += chunk
        const newline = input.indexOf('\n')
        if (newline === -1) return
        credentialRequest = JSON.parse(input.slice(0, newline)) as Record<string, unknown>
        socket.end(
          `${JSON.stringify({
            ok: true,
            username: 'x-access-token',
            password: 'test-installation-token',
            repoFullName: 'owner/repo'
          })}\n`
        )
      })
    })
    const seededCredentialEnvironment = {
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'trusted-parent-container-token',
      AWS_WEB_IDENTITY_TOKEN_FILE: awsWebIdentityTokenFile
    }
    // Mirror sandbox-runtime-provider: SRT's shared /tmp/claude fallback may
    // not exist, while production always gives the child a private HOME temp.
    const sandboxEnvironment = {
      HOME: privateHome,
      TMPDIR: privateTmp,
      CLAUDE_CODE_TMPDIR: privateTmp,
      CLAUDE_TMPDIR: privateTmp
    }
    mkdirSync(workspace)
    mkdirSync(privateClaudeConfig, { recursive: true })
    mkdirSync(privateTmp)
    mkdirSync(join(root, 'run'))
    writeFileSync(identityTokenFile, identityToken, { mode: 0o600 })
    writeFileSync(awsWebIdentityTokenFile, awsWebIdentityToken, { mode: 0o600 })
    writeFileSync(
      privateClaudeSettings,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'trusted-parent-settings-token' } }),
      { mode: 0o600 }
    )
    const settings = claudeInnerSandboxSettings([identityTokenFile, awsWebIdentityTokenFile, privateClaudeConfig], true)
    const names = settings.credentials.envVars.map(({ name }) => name)
    const restoredNames = new Set([
      ...names,
      ...Object.keys(seededCredentialEnvironment),
      ...Object.keys(sandboxEnvironment)
    ])
    const previous = new Map([...restoredNames].map((name) => [name, process.env[name]]))

    for (const name of names) process.env[name] = `secret-for-${name}`
    Object.assign(process.env, seededCredentialEnvironment, sandboxEnvironment)

    try {
      await new Promise<void>((resolve, reject) => {
        credentialServer.once('error', reject)
        credentialServer.listen(credentialSocket, resolve)
      })
      const config = SandboxRuntimeConfigSchema.parse({
        network: { allowedDomains: [], deniedDomains: [], ...settings.network },
        filesystem: { ...settings.filesystem, allowWrite: [workspace, privateHome] },
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

      // GitHub App workspaces deliberately keep one model-side Unix channel:
      // exercise the real helper, not just a generic socket connect.
      const req = createRequire(import.meta.url)
      const daemonEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
      // Resolve workspace packages from source without tsx CLI's temp IPC server.
      const helperCommand = [
        process.execPath,
        '--conditions',
        'development',
        '--import',
        req.resolve('tsx'),
        daemonEntry,
        'git-credential',
        'agent-1',
        'get'
      ]
        .map((part) => JSON.stringify(part))
        .join(' ')
      const socketAttempt = await SandboxManager.wrapWithSandboxArgv(
        helperCommand,
        undefined,
        undefined,
        undefined,
        workspace
      )
      const socketResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(socketAttempt.argv[0]!, socketAttempt.argv.slice(1), {
            cwd: workspace,
            env: {
              ...socketAttempt.env,
              AGENTCONNECT_ROOT: root,
              AC_GITCRED_AGENT: 'agent-1',
              AC_GITCRED_CAPABILITY: 'test-capability'
            },
            stdio: ['pipe', 'pipe', 'pipe']
          })
          let stdout = ''
          let stderr = ''
          const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
          child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
          child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
          child.once('error', reject)
          child.once('close', (code) => {
            clearTimeout(timeout)
            resolve({ code, stdout, stderr })
          })
          child.stdin.end('protocol=https\nhost=github.com\npath=owner/repo.git\n\n')
        }
      )
      expect(socketResult.code, socketResult.stderr).toBe(0)
      expect(socketResult.stdout).toBe('username=x-access-token\npassword=test-installation-token\n')
      expect(credentialRequest).toMatchObject({
        op: 'get',
        agentId: 'agent-1',
        capability: 'test-capability',
        repoFullName: 'owner/repo'
      })
    } finally {
      if (credentialServer.listening) {
        await new Promise<void>((resolve) => credentialServer.close(() => resolve()))
      }
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
