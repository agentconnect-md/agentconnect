import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, promises as fsp, realpathSync, rmSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { under } from '../fs/contained-path.js'
import { offlineSandboxLaunch, probeOfflineSandboxHost } from './offline-sandbox.js'
import { currentSkillMutationHelperLease } from './skill-workspace-lock-lease.js'

const MAX_MUTATION_OUTPUT = 64 * 1024
const MUTATION_TIMEOUT_MS = 20_000
/** Steps one helper run may carry. The helper's own spec cap (2 MiB) bounds the bytes; this bounds the time. */
export const MAX_MUTATION_BATCH_STEPS = 64

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

/** One mutation's paths in the form the helper checks them against: the real workspace, a real
 *  candidate source, and a contained alias resolved to its canonical root. */
async function normalizeMutationSpec<T extends object>(spec: T & { cwd: string }): Promise<Record<string, unknown>> {
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
    typeof relativeRoot === 'string' ? await canonicalSkillMutationRoot(canonicalWorkspace, relativeRoot) : relativeRoot
  return {
    ...spec,
    cwd: canonicalWorkspace,
    ...(normalizedCandidate === undefined ? {} : { candidate: normalizedCandidate }),
    ...(normalizedRelativeRoot === undefined ? {} : { relativeRoot: normalizedRelativeRoot })
  }
}

/** Run one audited workspace mutation with kernel confinement when the host supports it. */
export async function runSkillWorkspaceMutation<T extends object>(
  spec: T & { cwd: string },
  readRoots: string[] = [],
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  return await runHelper(await normalizeMutationSpec(spec), readRoots, signal, 1)
}

/**
 * Run several mutations of ONE workspace in a single confined helper. Steps for the same path run
 * in their given order; different paths run side by side. Each step is exactly what
 * {@link runSkillWorkspaceMutation} would have run on its own — same normalization, same checks in
 * the helper — so a batch changes how many processes are started and how much waiting overlaps, not
 * what any step may do. After a failure no further path starts and the batch fails, leaving each
 * path done or untouched for this batch: states a crash between single mutations leaves too, and
 * which recovery settles path by path.
 */
export async function runSkillWorkspaceMutations<T extends object>(
  specs: Array<T & { cwd: string }>,
  readRoots: string[] = [],
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  if (specs.length === 0) return []
  if (specs.length > MAX_MUTATION_BATCH_STEPS) throw new Error('skill workspace mutation batch has too many steps')
  const steps = []
  for (const spec of specs) steps.push(await normalizeMutationSpec(spec))
  const cwd = steps[0]!.cwd
  if (steps.some((step) => step.cwd !== cwd)) throw new Error('skill workspace mutation batch spans workspaces')
  const value = await runHelper({ action: 'batch', cwd, steps }, readRoots, signal, steps.length)
  const results = value.results
  if (
    !Array.isArray(results) ||
    results.length !== steps.length ||
    results.some((result) => !result || typeof result !== 'object' || Array.isArray(result))
  ) {
    throw new Error('skill workspace mutation batch returned an invalid result')
  }
  return results as Record<string, unknown>[]
}

/** `steps` scales the time and output budget: a batch gets what its steps would have had one by one. */
async function runHelper(
  normalizedSpec: Record<string, unknown>,
  readRoots: string[],
  signal: AbortSignal | undefined,
  steps: number
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-skill-mutation-'))
  chmodSync(root, 0o700)
  try {
    const canonicalWorkspace = normalizedSpec.cwd as string
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
    const directLaunch = { cmd: process.execPath, args: [helper, canonicalSpecPath] }
    const sandboxProbe = probeOfflineSandboxHost()
    let launch = directLaunch
    if (sandboxProbe.available) {
      try {
        launch = offlineSandboxLaunch({
          command: process.execPath,
          args: [helper, canonicalSpecPath],
          scopeRoot: root,
          cwd: runnerCwd,
          home,
          readRoots: [helper, canonicalSpecPath, canonicalWorkspace, ...readRoots],
          writeRoots: [root, canonicalWorkspace],
          startGated: true
        })
      } catch {
        launch = directLaunch
      }
    }
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
        },
        signal,
        timeoutMs: MUTATION_TIMEOUT_MS * steps,
        maxOutput: MAX_MUTATION_OUTPUT * steps
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
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number; maxOutput: number }
): Promise<string> {
  const lease = currentSkillMutationHelperLease()
  if (!lease) throw new Error('confined skill workspace mutation requires the external workspace lock')
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
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
    const abortHelper = (): void => {
      failure ??= new Error('confined skill workspace mutation aborted')
      killHelper()
    }
    if (options.signal?.aborted) abortHelper()
    else options.signal?.addEventListener('abort', abortHelper, { once: true })
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > options.maxOutput) {
        failure ??= new Error('confined skill workspace mutation output exceeded its limit')
        killHelper()
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    // stdin only carries the start gate, which an ungated helper can outrun; close() kills whatever survives.
    child.stdin.on('error', () => {})
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
    }, options.timeoutMs)
    child.once('close', (code) => {
      void (async () => {
        options.signal?.removeEventListener('abort', abortHelper)
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
