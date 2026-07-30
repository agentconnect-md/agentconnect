import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { sandboxWrap, sandboxBoundary, SandboxError, detectSandbox } from '../src/acp/sandbox.js'

// The security-bearing invariant: whatever the mechanism, the whole fs is readable,
// writes are confined to the agent dir + tmp, and the real command still runs last.
describe('sandboxWrap', () => {
  const agentDir = tmpdir() // an existing dir so canonical() resolves it

  it('bwrap: ro-binds /, tmpfs tmp, binds the writable dir, runs cmd last', () => {
    const { cmd, args } = sandboxWrap('claude', ['acp'], { mechanism: 'bwrap', writable: [agentDir] })
    expect(cmd).toBe('bwrap')
    // PID namespace — without it /proc exposes the daemon and /proc/<pid>/root is an escape.
    expect(args).toContain('--unshare-pid')
    // root read-only
    const ro = args.indexOf('--ro-bind')
    expect([args[ro + 1], args[ro + 2]]).toEqual(['/', '/'])
    // agent dir writable via --bind
    const bind = args.indexOf('--bind')
    expect(bind).toBeGreaterThan(-1)
    // separator then the untouched command tail
    expect(args.slice(-3)).toEqual(['--', 'claude', 'acp'])
  })

  it('sandbox-exec: denies writes then re-allows the writable subpath, runs cmd last', () => {
    const { cmd, args } = sandboxWrap('codex', ['--acp'], {
      mechanism: 'sandbox-exec',
      writable: [agentDir],
      maskedReadRoots: []
    })
    expect(cmd).toBe('sandbox-exec')
    expect(args[0]).toBe('-p')
    const profile = args[1]!
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('allow file-write* (subpath')
    expect(args.slice(-2)).toEqual(['codex', '--acp'])
  })

  it('sandbox-exec: rejects non-empty masked roots instead of silently ignoring them', () => {
    expect(() =>
      sandboxWrap('codex', ['--acp'], {
        mechanism: 'sandbox-exec',
        writable: [agentDir],
        maskedReadRoots: [agentDir]
      })
    ).toThrow(SandboxError)
  })

  it('always makes tmp writable even when the caller omits it', () => {
    const { args } = sandboxWrap('x', [], { mechanism: 'bwrap', writable: [] })
    // --tmpfs entry present for the tmp dir
    expect(args).toContain('--tmpfs')
    expect(args).not.toContain('--bind')
  })

  it('bwrap: masks trusted read roots without binding their host contents back', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const canonicalMaskedRoot = realpathSync(maskedRoot)
    const { args } = sandboxWrap('x', [], {
      mechanism: 'bwrap',
      writable: [],
      maskedReadRoots: [maskedRoot]
    })

    const proc = args.indexOf('--proc')
    expect(args[proc + 1]).toBe('/proc')
    expect(args).toContain('--unshare-pid')

    const maskedRootIndex = args.indexOf(canonicalMaskedRoot)
    expect(maskedRootIndex).toBeGreaterThan(0)
    expect(args[maskedRootIndex - 1]).toBe('--tmpfs')
    expect(args).not.toContain('--bind')
  })
})

// The escalation the reviewer found (#799): the writable set must never be derived
// from the mutable workspace.path, and the agent-dir ROOT (holding agent.json) must
// stay read-only so a confined runtime can't rewrite the config that controls it.
describe('sandboxBoundary', () => {
  const agentDir = join(tmpdir(), 'ac-agent-x')
  const sock = join(tmpdir(), 'run', 'mcp.sock')

  it('confines writes to the cwd + runtime HOME + memory + socket dir — NOT the agent-dir root', () => {
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
    expect(writable).toContain(join(realpathSync(tmpdir()), 'run')) // socket dir (platform-tool bridge)
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
    const outerPid = process.pid // the "daemon" PID; must be invisible in the child's /proc
    const { cmd, args } = sandboxWrap('sh', ['-c', `[ -e /proc/${outerPid} ] && echo LEAK || echo OK`], {
      mechanism: 'bwrap',
      writable: [dir]
    })
    const out = execFileSync(cmd, args, { encoding: 'utf8' }).trim()
    expect(out).toBe('OK')
  })
})
