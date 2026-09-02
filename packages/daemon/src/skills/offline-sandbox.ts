import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getApplySeccompBinaryPath } from '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js'
import { sandboxWrap, writeSandboxSettings, type SandboxMechanism } from '../acp/sandbox.js'

export class OfflineSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineSandboxUnavailableError'
  }
}

export interface OfflineSandboxProbe {
  available: boolean
  reason?: string
}

let cachedProbe: OfflineSandboxProbe | undefined

/** Live, platform-neutral probe of the exact offline provider used for skills. */
export function probeOfflineSandboxHost(): OfflineSandboxProbe {
  if (cachedProbe) return cachedProbe
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-offline-sandbox-probe-'))
  try {
    const cwd = join(root, 'workspace')
    const home = join(root, 'home')
    mkdirSync(cwd)
    mkdirSync(home)
    const launch = offlineSandboxLaunch({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      scopeRoot: root,
      cwd,
      home,
      readRoots: [process.execPath],
      writeRoots: [root]
    })
    const result = spawnSync(launch.cmd, launch.args, {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, TMP: home, TEMP: home },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })
    cachedProbe =
      result.status === 0
        ? { available: true }
        : {
            available: false,
            reason: (result.stderr || result.error?.message || `provider exited with status ${result.status}`).trim()
          }
  } catch (error) {
    cachedProbe = { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return cachedProbe
}

function mechanism(): SandboxMechanism {
  if (process.platform === 'linux') return 'bwrap'
  if (process.platform === 'darwin') return 'seatbelt'
  throw new OfflineSandboxUnavailableError('offline skills sandbox requires Linux or macOS')
}

function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path)).map((path) => realpathSync(path))
}

/**
 * Wrap a short-lived, daemon-authored helper in SRT's kernel sandbox.
 *
 * Reads are default-denied from `/` and carved back only for OS/runtime files,
 * the audited executable, the immutable source snapshot, and the private cell.
 * Writes are confined to explicit private/workspace roots. Network and Unix
 * sockets are both denied. The caller still validates every output receipt.
 */
export function offlineSandboxLaunch(opts: {
  command: string
  args: string[]
  scopeRoot: string
  cwd: string
  home: string
  readRoots: string[]
  writeRoots: string[]
  startGated?: boolean
}): { cmd: string; args: string[]; settingsPath: string } {
  const scopeRoot = realpathSync(opts.scopeRoot)
  const cwd = realpathSync(opts.cwd)
  const home = realpathSync(opts.home)
  const command = realpathSync(opts.command)
  const systemReadRoots = existing([
    '/bin',
    '/usr/bin',
    '/usr/lib',
    '/usr/libexec',
    '/usr/share/zoneinfo',
    '/lib',
    '/lib64',
    '/System',
    '/dev/null',
    '/dev/urandom',
    '/dev/random',
    '/proc',
    '/etc/ssl',
    '/private/etc/ssl',
    '/private/etc/localtime',
    '/etc/localtime'
  ])
  const writable = [...new Set([cwd, home, ...opts.writeRoots.map((path) => realpathSync(resolve(path)))])]
  // SRT applies its Unix-socket seccomp filter by executing the bundled
  // apply-seccomp helper INSIDE the sandbox. With denyRead:['/'] the helper must
  // be explicitly readable/executable, or seccomp silently degrades. Resolve it
  // with SRT's own lookup (same path SRT will exec) and carve it back in. Linux
  // only — macOS uses Seatbelt and never runs the helper.
  const seccompHelper = (() => {
    if (process.platform !== 'linux') return [] as string[]
    const helper = getApplySeccompBinaryPath()
    if (!helper || !existsSync(helper)) return [] as string[]
    const real = realpathSync(helper)
    return [real, dirname(real)]
  })()
  const allowRead = [
    scopeRoot,
    command,
    dirname(command),
    ...seccompHelper,
    ...systemReadRoots,
    ...opts.readRoots.map((path) => realpathSync(resolve(path)))
  ]
  const settingsPath = writeSandboxSettings(scopeRoot, 'skills', {
    writable,
    denyRead: ['/'],
    allowRead,
    gitSafeDirectories: [cwd],
    offline: true
  })
  const launch = sandboxWrap(command, opts.args, {
    mechanism: mechanism(),
    writable,
    settingsPath,
    cwd,
    offline: true,
    startGated: opts.startGated
  })
  return { ...launch, settingsPath }
}
