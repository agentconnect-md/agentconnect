import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { SANDBOX_TEMP_DIR_ENV } from './sandbox-temp.js'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isAncestorProcess(ownerPid: number): boolean {
  let pid = process.pid
  const visited = new Set<number>()

  while (pid > 0 && !visited.has(pid)) {
    if (pid === ownerPid) return true
    visited.add(pid)

    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/)
      const parentPid = Number(fields[1])
      if (!Number.isSafeInteger(parentPid) || parentPid < 0) return false
      pid = parentPid
    } catch {
      return false
    }
  }

  return false
}

/** The child's temp root: the daemon composes an ACP host's own `<agentDir>/t/<8 hex>` and passes it here, since SRT's multiplexer socket sits directly under TMPDIR and AF_UNIX truncates a path built from a per-session runtime HOME. It stays subject to the same guard the private HOME has — an explicit SRT write root. Without one (the audited offline helpers, and a launch in a sandbox pod) the private HOME keeps its own. */
function childTempDir(writeRoots: string[], privateHome: string): string {
  const requested = process.env[SANDBOX_TEMP_DIR_ENV]
  // Never travels on to the sandboxed child: it is the daemon's instruction to this process.
  delete process.env[SANDBOX_TEMP_DIR_ENV]
  if (requested === undefined) {
    const homeTmp = join(resolve(privateHome), '.tmp')
    if (existsSync(homeTmp)) {
      const stat = lstatSync(homeTmp)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('private SRT temp path must be a real directory')
      }
    }
    mkdirSync(homeTmp, { recursive: true, mode: 0o700 })
    chmodSync(homeTmp, 0o700)
    return homeTmp
  }
  if (!isAbsolute(requested)) throw new Error('the SRT temp root must be an absolute path')
  const tempDir = realpathSync(requested)
  if (!writeRoots.includes(resolve(tempDir))) {
    throw new Error('the SRT temp root must be an explicit SRT write root')
  }
  return tempDir
}

// SRT 0.0.75's cwd-anchored mandatory-deny names (`DANGEROUS_FILES` / `getDangerousDirectories()`, not exported): the files, and the directories it denies as a whole.
const SRT_PROTECTED_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json'
]
const SRT_PROTECTED_DIRS = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

// Until the scan moved to the private HOME, bwrap left each missing name behind in the checkout as a zero-byte mount-point FILE (a directory name included) that outlived any ungraceful exit.
const LEGACY_MOUNT_POINT_NAMES = [...SRT_PROTECTED_FILES, ...SRT_PROTECTED_DIRS]

/** Give SRT's scan real, empty entries to protect in the private HOME, so it binds each read-only in place instead of stubbing a missing one with `/dev/null`. That stub is unreadable inside the sandbox (bwrap binds carry `nodev`), and Debian's bash sources `~/.bashrc` from any `bash -c` whose stdin is a socket — every Node pipe — so the stub turned into a `Permission denied` on stderr at every launch. The HOME is the daemon's own, so an empty rc file there is nobody's untracked file. Idempotent; an entry that already exists, a symlink included, is left alone. */
export function seedProtectedHomeEntries(home: string): void {
  for (const name of SRT_PROTECTED_DIRS) {
    try {
      mkdirSync(join(home, name), { recursive: true, mode: 0o700 })
    } catch {
      // exists as something else, or not ours to create
    }
  }
  for (const name of SRT_PROTECTED_FILES) {
    try {
      writeFileSync(join(home, name), '', { flag: 'wx', mode: 0o600 })
    } catch {
      // already present in any form
    }
  }
}

/** The listed names Git tracks in `cwd` — the repository's own files, whatever their size. Empty when `cwd` is no checkout or git is unavailable. */
function trackedLegacyNames(cwd: string): Set<string> {
  try {
    const out = execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--', ...LEGACY_MOUNT_POINT_NAMES], {
      // Read-only and hook-free, but never the host's or the checkout's ambient config routing.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    })
    return new Set(out.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Remove the old scan's leftovers from the checkout root: only a zero-byte regular file of those exact names that Git does not track — never a directory (an empty `.claude` may be a prepared install target) and never the repository's own file. Best-effort. */
export function removeLegacyMountPoints(cwd: string): void {
  const tracked = trackedLegacyNames(cwd)
  for (const name of LEGACY_MOUNT_POINT_NAMES) {
    if (tracked.has(name)) continue
    try {
      const path = join(cwd, name)
      const stat = lstatSync(path)
      if (stat.isFile() && stat.size === 0) unlinkSync(path)
    } catch {
      // absent, or not ours to touch
    }
  }
}

/**
 * Run one command through an isolated Sandbox Runtime manager. This helper is
 * launched in its own process for every ACP host: SRT's manager is global to a
 * process, while AgentConnect needs a different filesystem/socket policy per
 * agent and may run many hosts concurrently.
 */
export async function runSandboxRuntimeProvider(argv: string[], opts: { offline?: boolean } = {}): Promise<number> {
  if (process.platform !== 'linux' && !(opts.offline && process.platform === 'darwin')) {
    console.error(
      `agentconnect sandbox-runtime: ${opts.offline ? 'offline helpers require Linux or macOS' : 'Linux is the only supported platform'}`
    )
    return 1
  }
  const separator = argv.indexOf('--')
  const startGated = argv[3] === '--start-gated'
  const ownerPid = Number(argv[1])
  const requestedCwd = argv[2]
  if (
    separator !== (startGated ? 4 : 3) ||
    argv.length < 5 ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    !requestedCwd ||
    !isAbsolute(requestedCwd)
  ) {
    console.error('agentconnect sandbox-runtime: expected <settings> <owner-pid> <cwd> -- <command> [args...]')
    return 2
  }

  try {
    if (startGated && !(await waitForStartGate())) {
      console.error('agentconnect sandbox-runtime: start gate closed before GO')
      return 1
    }
    const config = SandboxRuntimeConfigSchema.parse(JSON.parse(readFileSync(argv[0]!, 'utf8')))
    const sandboxCwd = realpathSync(requestedCwd)
    const writeRoots = config.filesystem.allowWrite.map((path) => resolve(path))
    const safeDirectories = config.git?.safeDirectories?.map((path) => resolve(path)) ?? []
    if (!writeRoots.includes(resolve(sandboxCwd)) || !safeDirectories.includes(resolve(sandboxCwd))) {
      throw new Error('sandbox cwd must be an explicit SRT write root and Git safe directory')
    }
    const requestedHome = process.env.HOME
    const privateHome = requestedHome && isAbsolute(requestedHome) ? realpathSync(requestedHome) : undefined
    if (!privateHome || !writeRoots.includes(resolve(privateHome))) {
      throw new Error('private HOME must be an explicit SRT write root')
    }
    removeLegacyMountPoints(sandboxCwd)
    seedProtectedHomeEntries(privateHome)
    // SRT's Linux mandatory-deny scan is anchored at its own process.cwd() (the cwd argument to
    // wrapWithSandboxArgv plays no part in it), and for a missing name it has bwrap create a zero-byte
    // mount point there. Its names are HOME's — shell rc files, `.gitconfig`, `.mcp.json` — so anchor
    // the scan at the private HOME, where they belong and where the entries above are real files of
    // ours, instead of the checkout. The checkouts' `.git/config` and `.git/hooks` are denied
    // explicitly by the launch (launch/prepare.ts), so nothing depends on scanning the workspace.
    process.chdir(privateHome)
    const privateTmp = childTempDir(writeRoots, privateHome)
    // SRT otherwise defaults TMPDIR to the shared host /tmp/claude path.
    process.env.HOME = privateHome
    process.env.TMPDIR = privateTmp
    process.env.CLAUDE_CODE_TMPDIR = privateTmp
    process.env.CLAUDE_TMPDIR = privateTmp
    // Node's fetch/http ignore HTTP(S)_PROXY unless told to (v22.21+/v24+); otherwise corepack has no route out of SRT's netns.
    process.env.NODE_USE_ENV_PROXY = '1'
    // Network policy is out of scope for this rollout: approve every domain; local-port/client gaps stay in issue #312.
    await SandboxManager.initialize(config, async () => opts.offline !== true)

    const command = argv
      .slice(separator + 1)
      .map(shellQuote)
      .join(' ')
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, sandboxCwd)
    // The runtime's own cwd: bwrap runs where this process stands (SRT passes no --chdir), so move only now, after the scan.
    process.chdir(sandboxCwd)
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      env: wrapped.env,
      shell: false,
      stdio: 'inherit'
    })

    // bwrap dies with this provider, but the provider also needs to die with the
    // daemon. The source launcher adds a tsx process between them, so poll the
    // Linux process ancestry rather than requiring the daemon to be our direct
    // parent. This covers abrupt daemon death where no shutdown signal reaches
    // the detached ACP process group.
    let escalation: NodeJS.Timeout | undefined
    const ownerWatch = setInterval(() => {
      const ownerAlive =
        process.platform === 'linux'
          ? isAncestorProcess(ownerPid)
          : (() => {
              try {
                process.kill(ownerPid, 0)
                return true
              } catch {
                return false
              }
            })()
      if (ownerAlive) return
      clearInterval(ownerWatch)
      child.kill('SIGTERM')
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000)
    }, 250)
    ownerWatch.unref()

    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)))
    })
    clearInterval(ownerWatch)
    clearTimeout(escalation)
    SandboxManager.cleanupAfterCommand()
    await SandboxManager.reset()
    return code
  } catch (error) {
    console.error(`agentconnect sandbox-runtime: ${error instanceof Error ? error.message : String(error)}`)
    try {
      SandboxManager.cleanupAfterCommand()
    } catch {
      // Initialization may have failed before per-command state existed.
    }
    await SandboxManager.reset().catch(() => undefined)
    return 1
  }
}

async function waitForStartGate(): Promise<boolean> {
  return new Promise((resolveGate) => {
    let body = ''
    let settled = false
    const finish = (allowed: boolean): void => {
      if (settled) return
      settled = true
      process.stdin.pause()
      process.stdin.removeAllListeners('data')
      process.stdin.removeAllListeners('end')
      process.stdin.removeAllListeners('error')
      resolveGate(allowed)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 16) finish(false)
      else if (body.includes('\n')) finish(body === 'GO\n')
    })
    process.stdin.once('end', () => finish(false))
    process.stdin.once('error', () => finish(false))
    process.stdin.resume()
  })
}
