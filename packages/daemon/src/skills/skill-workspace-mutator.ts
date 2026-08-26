import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, promises as fsp, realpathSync, rmSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { under } from '../fs/contained-path.js'
import { offlineSandboxLaunch } from './offline-sandbox.js'
import { currentSkillMutationHelperLease } from './skill-workspace-lock-lease.js'

const MAX_MUTATION_OUTPUT = 64 * 1024
const MUTATION_TIMEOUT_MS = 20_000

// Resolve a contained CLI-owned alias before the confined helper walks the mutation path.
export async function canonicalSkillMutationRoot(cwd: string, relativeRoot: string): Promise<string> {
  const workspace = await fsp.realpath(cwd)
  const lexicalTarget = resolve(workspace, relativeRoot)
  if (isAbsolute(relativeRoot) || !under(workspace, lexicalTarget)) return relativeRoot

  const parts = relativeRoot.split('/')
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return relativeRoot
  let sawLink = false
  let current = workspace
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    let stat: Stats
    try {
      stat = await fsp.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return relativeRoot
      throw error
    }
    if (stat.isSymbolicLink()) sawLink = true
    else if (!stat.isDirectory()) return relativeRoot
  }
  if (!sawLink) return relativeRoot

  const canonicalParent = await fsp.realpath(dirname(lexicalTarget))
  if (!under(workspace, canonicalParent)) throw new Error('skill mutation alias resolves outside workspace')
  const canonical = relative(workspace, join(canonicalParent, basename(lexicalTarget)))
    .split(sep)
    .join('/')
  if (!canonical || canonical.startsWith('../') || isAbsolute(canonical)) {
    throw new Error('skill mutation alias resolves outside workspace')
  }
  return canonical
}

function helperPath(): string {
  const modulePath = realpathSync(fileURLToPath(import.meta.url))
  const candidates = [
    // Published daemon bundle: this module is rolled into dist/index.js while
    // the audited helper is emitted as dist/skills/workspace-mutation.js.
    join(dirname(modulePath), 'skills', 'workspace-mutation.js'),
    join(dirname(modulePath), 'workspace-mutation.js'),
    // Source tests must exercise the current helper rather than a possibly
    // stale artifact from an earlier local build.
    join(dirname(modulePath), 'skill-workspace-mutation-cli.ts'),
    join(dirname(modulePath), '..', '..', 'dist', 'skills', 'workspace-mutation.js')
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return realpathSync(candidate)
  throw new Error('skill workspace mutation helper is unavailable')
}

/** Run one audited workspace mutation under SRT/Seatbelt or SRT/bwrap. The
 * helper can read the receipts/source and mutate the selected workspace, but
 * the kernel denies every write outside that workspace and all network/socket
 * access. */
export async function runSkillWorkspaceMutation<T extends object>(
  spec: T & { cwd: string },
  readRoots: string[] = []
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-skill-mutation-'))
  chmodSync(root, 0o700)
  try {
    const canonicalWorkspace = realpathSync(spec.cwd)
    const candidate = (spec as Record<string, unknown>).candidate
    const normalizedCandidate =
      candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).sourceDir === 'string'
        ? {
            ...(candidate as Record<string, unknown>),
            sourceDir: realpathSync((candidate as Record<string, unknown>).sourceDir as string)
          }
        : candidate
    const relativeRoot = (spec as Record<string, unknown>).relativeRoot
    const normalizedRelativeRoot =
      typeof relativeRoot === 'string'
        ? await canonicalSkillMutationRoot(canonicalWorkspace, relativeRoot)
        : relativeRoot
    const normalizedSpec = {
      ...spec,
      cwd: canonicalWorkspace,
      ...(normalizedCandidate === undefined ? {} : { candidate: normalizedCandidate }),
      ...(normalizedRelativeRoot === undefined ? {} : { relativeRoot: normalizedRelativeRoot })
    }
    const home = join(root, 'home')
    const runnerCwd = join(root, 'workspace')
    await fsp.mkdir(home, { mode: 0o700 })
    await fsp.mkdir(runnerCwd, { mode: 0o700 })
    const specPath = join(root, 'mutation.json')
    const handle = await fsp.open(specPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(normalizedSpec)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }

    const helper = helperPath()
    const canonicalSpecPath = realpathSync(specPath)
    // SRT has no Windows provider. The audited helper still enforces workspace
    // identity, containment, no-link traversal, receipts, and journal authority.
    const launch =
      process.platform === 'win32'
        ? { cmd: process.execPath, args: [helper, canonicalSpecPath] }
        : offlineSandboxLaunch({
            command: process.execPath,
            args: [helper, canonicalSpecPath],
            scopeRoot: root,
            cwd: runnerCwd,
            home,
            readRoots: [helper, canonicalSpecPath, canonicalWorkspace, ...readRoots],
            writeRoots: [root, canonicalWorkspace],
            startGated: true
          })
    const providerTmp = mkdtempSync(join(tmpdir(), 'agentconnect-srt-'))
    chmodSync(providerTmp, 0o700)
    try {
      const output = await runConfinedHelper(launch.cmd, launch.args, {
        cwd: runnerCwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TMPDIR: providerTmp,
          TMP: providerTmp,
          TEMP: providerTmp,
          CI: '1',
          GIT_TERMINAL_PROMPT: '0'
        }
      })
      const value = JSON.parse(output) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('skill workspace mutation returned an invalid result')
      }
      return value as Record<string, unknown>
    } finally {
      rmSync(providerTmp, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runConfinedHelper(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<string> {
  const lease = currentSkillMutationHelperLease()
  if (!lease) throw new Error('confined skill workspace mutation requires the external workspace lock')
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, {
      ...options,
      detached: grouped,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const helperId = child.pid
    if (!helperId) {
      child.kill('SIGKILL')
      reject(new Error('confined skill workspace mutation has no process-group id'))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    let leaseRegistered = false
    const killHelper = (): void => {
      try {
        if (grouped) process.kill(-helperId, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error
      }
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > MAX_MUTATION_OUTPUT) {
        failure ??= new Error('confined skill workspace mutation output exceeded its limit')
        killHelper()
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.stdin.on('error', (error) => {
      failure ??= error
      killHelper()
    })
    child.once('error', (error) => {
      failure ??= error
      killHelper()
    })
    const registration = (async () => {
      try {
        await lease.registerHelper(helperId)
        leaseRegistered = true
        child.stdin.end('GO\n')
      } catch (error) {
        failure ??= error as Error
        child.stdin.destroy()
        killHelper()
      }
    })()
    const timer = setTimeout(() => {
      failure ??= new Error('confined skill workspace mutation timed out')
      killHelper()
    }, MUTATION_TIMEOUT_MS)
    child.once('close', (code) => {
      void (async () => {
        clearTimeout(timer)
        await registration
        if (helperAlive(helperId, grouped)) {
          killHelper()
          if (!(await waitForHelperExit(helperId, grouped))) {
            failure ??= new Error('confined skill workspace mutation helper did not exit')
          }
        }
        if (leaseRegistered) {
          try {
            await lease.clearHelper(helperId)
          } catch (error) {
            failure ??= error as Error
          }
        }
        if (code === 0 && !failure) {
          resolve(Buffer.concat(stdout).toString('utf8'))
          return
        }
        const detail = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/, 1)[0]!.slice(0, 512)
        reject(failure ?? new Error(`confined skill workspace mutation failed${detail ? `: ${detail}` : ''}`))
      })().catch(reject)
    })
  })
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function helperAlive(id: number, grouped: boolean): boolean {
  return grouped ? processGroupAlive(id) : processAlive(id)
}

async function waitForHelperExit(id: number, grouped: boolean): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (helperAlive(id, grouped)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return true
}
