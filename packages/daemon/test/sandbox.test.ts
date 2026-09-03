import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  removeHostSandboxState,
  writeSandboxSettings
} from '../src/acp/sandbox.js'
import {
  AF_UNIX_PATH_MAX,
  prepareSandboxTempDir,
  reclaimStaleHostTempDirs,
  sandboxTempDirFor
} from '../src/acp/sandbox-temp.js'
import { agentHostKey, hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
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
      CLAUDE_TMPDIR: privateTmp,
      NODE_USE_ENV_PROXY: '1'
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
      // SRT must not strip the switch that makes Node's fetch/http honour its proxy variables.
      expect(output).toContain('NODE_USE_ENV_PROXY=1')

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

// #1763 made a confined session's runtime HOME a per-session directory, which pushed SRT's
// multiplexer socket past the AF_UNIX cap and left every confined session-isolated agent unable
// to start ("listen EINVAL"). A host's temp dir is a short leaf of the agent dir now, and a launch
// whose socket would still not fit is refused where the path is visible.
describe('sandbox temp directories', () => {
  // SRT confines a host on Linux alone, so its 107 usable sun_path bytes are the budget. The socket
  // name SRT composes is `srt-mux-<pid>-<n>.sock`, so a pid at the 22-bit ceiling is the widest one.
  const SOCKET_NAME = 'srt-mux-4194304-0.sock'

  const typicalAgentDir = '/home/ubuntu/.agentconnect/agents/review-bot'
  const hostKey = sessionHostKey('review-bot', 'slack:C0123456789:1730000000.123456')

  it("keeps a typical install's SRT socket inside the AF_UNIX limit, where the shape it replaced overflowed", () => {
    const socket = join(sandboxTempDirFor(typicalAgentDir, hostKey), SOCKET_NAME)
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(AF_UNIX_PATH_MAX)
    // The shape this replaced, on the SAME input: a temp dir under the session's own HOME overflows.
    const underSessionHome = join(typicalAgentDir, 'sessions', hostKeyDirName(hostKey), 'home', '.tmp', SOCKET_NAME)
    expect(Buffer.byteLength(underSessionHome)).toBeGreaterThan(AF_UNIX_PATH_MAX)
  })

  it('gives the agent host and each session host of one agent their own directory', () => {
    const shared = sandboxTempDirFor(typicalAgentDir, agentHostKey('review-bot'))
    const first = sandboxTempDirFor(typicalAgentDir, sessionHostKey('review-bot', 'session-a'))
    const second = sandboxTempDirFor(typicalAgentDir, sessionHostKey('review-bot', 'session-b'))
    expect(new Set([shared, first, second]).size).toBe(3)
    // Each is a two-segment leaf of the agent's own dir, so the agent-dir rule covers it with no exemption.
    for (const dir of [shared, first, second]) {
      expect(relative(resolve(typicalAgentDir), dir).split(sep)).toEqual(['t', expect.stringMatching(/^[0-9a-f]{8}$/)])
    }
  })

  it('creates the directory 0700 under the agent dir and reuses it', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ac-temp-ok-'))
    try {
      const created = prepareSandboxTempDir(agentDir, hostKey)
      expect(created).toBe(realpathSync(sandboxTempDirFor(agentDir, hostKey)))
      expect(existsSync(created)).toBe(true)
      expect(prepareSandboxTempDir(agentDir, hostKey)).toBe(created)
      if (process.platform !== 'win32') {
        expect(statSync(created).mode & 0o7777).toBe(0o700)
        expect(statSync(join(realpathSync(agentDir), 't')).mode & 0o7777).toBe(0o700)
      }
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  // The honest cost of living in the agent dir: this is short, not bounded. A deep enough daemon
  // root plus a long agent name still overflows, and the launch has to say so — the alternative is
  // the opaque `listen EINVAL` three ACP start attempts deep that #1763 shipped.
  it('refuses a launch whose SRT socket would not fit, naming the limit and the path', () => {
    // The system temp dir is deep on macOS; this case needs room for a FITTING path beside the overflowing one.
    const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ac-t-')))
    const budget = AF_UNIX_PATH_MAX - Buffer.byteLength(join(sandboxTempDirFor(root, hostKey), SOCKET_NAME))
    try {
      const tooDeep = join(root, 'a'.repeat(budget))
      mkdirSync(tooDeep, { recursive: true })
      expect(() => prepareSandboxTempDir(tooDeep, hostKey, 'linux')).toThrow(
        new RegExp(`${SOCKET_NAME}" is \\d+ bytes and the limit is ${AF_UNIX_PATH_MAX}`)
      )
      // Refused before the leaf exists, so a retry on a shorter root is not left a stale directory.
      expect(existsSync(sandboxTempDirFor(tooDeep, hostKey))).toBe(false)
      // One byte shorter fits, so what the refusal measures is the budget and not the fixture.
      const fits = join(root, 'a'.repeat(budget - 1))
      mkdirSync(fits, { recursive: true })
      expect(existsSync(prepareSandboxTempDir(fits, hostKey, 'linux'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink standing in for the temp parent', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ac-temp-link-'))
    try {
      const elsewhere = join(agentDir, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, join(agentDir, 't'))
      expect(() => prepareSandboxTempDir(agentDir, hostKey)).toThrow(/not a real directory inside the agent dir/)
      // And nothing was written through the link.
      expect(existsSync(join(elsewhere, basename(sandboxTempDirFor(agentDir, hostKey))))).toBe(false)
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  // `t` is a short name, not a reserved one: an agent's `workspace.path` resolves under the agent dir
  // too, so an operator may already have data — a whole workspace — at exactly that path. Ownership is
  // proven by the marker this daemon writes when it creates the parent, never assumed from the name.
  it('refuses a temp root this daemon did not create, and never reclaims anything under it', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ac-temp-own-'))
    try {
      // A workspace that happens to live at `<agentDir>/t`, holding a name that looks like a leaf.
      const workspace = join(agentDir, 't')
      const precious = join(workspace, 'deadbeef')
      mkdirSync(precious, { recursive: true })
      writeFileSync(join(workspace, 'README.md'), 'operator data')

      expect(() => prepareSandboxTempDir(agentDir, hostKey)).toThrow(/this daemon did not create it/)
      expect(reclaimStaleHostTempDirs(agentDir)).toEqual([])
      expect(existsSync(precious)).toBe(true)
      expect(existsSync(join(workspace, 'README.md'))).toBe(true)
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it('reclaims only the leaves of a temp root it owns', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ac-temp-sweep-'))
    try {
      const live = prepareSandboxTempDir(agentDir, hostKey)
      const parent = join(realpathSync(agentDir), 't')
      const stranger = join(parent, 'not-a-leaf')
      mkdirSync(stranger)

      expect(reclaimStaleHostTempDirs(agentDir)).toEqual([basename(live)])

      expect(existsSync(live)).toBe(false)
      // The parent, its ownership marker and anything that is not a leaf survive.
      expect(existsSync(parent)).toBe(true)
      expect(existsSync(stranger)).toBe(true)
      expect(readdirSync(parent).sort()).toEqual(['.agentconnect-runtime-temp', 'not-a-leaf'])
      // Idempotent: a second boot finds nothing left to reclaim.
      expect(reclaimStaleHostTempDirs(agentDir)).toEqual([])
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it("retires a stopped host's policy directory and its temp directory together", () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ac-agent-teardown-'))
    const stoppedHost = sessionHostKey('agent-1', 'session-a')
    try {
      const settingsPath = writeSandboxSettings(agentDir, hostKeyDirName(stoppedHost), {
        writable: [join(agentDir, 'workspace')],
        denyRead: [agentDir],
        allowRead: [join(agentDir, 'workspace')]
      })
      const tempDir = prepareSandboxTempDir(agentDir, stoppedHost)
      removeHostSandboxState(agentDir, stoppedHost)
      expect(existsSync(settingsPath)).toBe(false)
      expect(existsSync(tempDir)).toBe(false)
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })
})
