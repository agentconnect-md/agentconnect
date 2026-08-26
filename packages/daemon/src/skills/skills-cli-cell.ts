import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync
} from 'node:fs'
import { basename, isAbsolute, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { offlineSandboxLaunch, probeOfflineSandboxHost } from './offline-sandbox.js'

export const PINNED_SKILLS_CLI_VERSION = '1.5.21'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024

const moduleRequire = createRequire(import.meta.url)

export interface ResolvedSkillsCli {
  version: typeof PINNED_SKILLS_CLI_VERSION
  binPath: string
  /** Exact package roots needed by an unbundled source/dev execution. */
  readRoots?: string[]
}

export interface SkillsCliRunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  /** Immutable files/directories the kernel sandbox may read. */
  readRoots: string[]
}

export interface SkillsCliRunResult {
  exitCode: number
  stdout: string
  stderr: string
  isolation?: 'kernel' | 'process'
  isolationReason?: string
}

export type SkillsCliRunner = (
  executable: string,
  args: string[],
  options: SkillsCliRunOptions
) => Promise<SkillsCliRunResult>

export interface SkillsCliCellLimits {
  maxBundles: number
  maxEntries: number
  maxDepth: number
  maxFilesPerBundle: number
  maxFileBytes: number
  maxBytesPerBundle: number
  maxTotalBytes: number
  maxLockBytes: number
}

export const DEFAULT_SKILLS_CLI_CELL_LIMITS: Readonly<SkillsCliCellLimits> = {
  maxBundles: 64,
  maxEntries: 1_024,
  maxDepth: 16,
  maxFilesPerBundle: 64,
  maxFileBytes: 512 * 1024,
  maxBytesPerBundle: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxLockBytes: 1024 * 1024
}

export interface SkillsCliBundle {
  /** Path below the cell cwd, using `/` separators on every platform. */
  relativePath: string
  absolutePath: string
  /** Safe path prefix before `skills`, or empty for `skills/<bundle>`. */
  root: string
  name: string
  fileCount: number
  totalBytes: number
}

export interface SkillsCliCellResult {
  cellRoot: string
  cwd: string
  bundles: SkillsCliBundle[]
  lockFile?: string
  execution: SkillsCliRunResult
  /** Removes the complete cell. Safe to call more than once. */
  cleanup: () => void
}

export interface StageSkillsCliCellOptions {
  sourceSnapshot: string
  agentId: string
  selectedSkills?: string[]
  runner?: SkillsCliRunner
  resolveCli?: () => ResolvedSkillsCli
  timeoutMs?: number
  maxOutputBytes?: number
  limits?: Partial<SkillsCliCellLimits>
  /** Test/embedding seam. The newly-created cell is still private and unique. */
  tempParent?: string
  /** Only PATH is inherited; all other child variables are constructed afresh. */
  hostEnv?: NodeJS.ProcessEnv
}

export class SkillsCliCellError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillsCliCellError'
  }
}

type PackageResolver = (specifier: string) => string

/** Resolve the installed package itself, then enforce the audited version before
 * any of its code executes. The bin must be a regular file contained by that
 * package directory. */
export function resolvePinnedSkillsCli(resolvePackage?: PackageResolver): ResolvedSkillsCli {
  // A published daemon has zero runtime dependencies. tsdown emits this
  // separately bundled executable beside dist/index.js; source/dev execution
  // falls back to the exact package dependency below.
  if (!resolvePackage) {
    const bundled = bundledSkillsCli()
    if (bundled) {
      return {
        version: PINNED_SKILLS_CLI_VERSION,
        binPath: bundled,
        readRoots: [cliReadRoot(bundled)]
      }
    }
  }

  let packageJsonPath: string
  try {
    packageJsonPath = (resolvePackage ?? ((specifier) => moduleRequire.resolve(specifier)))('skills/package.json')
  } catch {
    throw new SkillsCliCellError('the pinned skills CLI package is not installed')
  }

  let manifest: { version?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown; bin?: unknown }
  } catch {
    throw new SkillsCliCellError('the skills CLI package manifest is unreadable')
  }
  if (manifest.version !== PINNED_SKILLS_CLI_VERSION) {
    throw new SkillsCliCellError(
      `skills CLI version mismatch: expected ${PINNED_SKILLS_CLI_VERSION}, got ${String(manifest.version)}`
    )
  }

  const relativeBin =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : isStringRecord(manifest.bin) && typeof manifest.bin.skills === 'string'
        ? manifest.bin.skills
        : undefined
  if (!relativeBin || isAbsolute(relativeBin)) {
    throw new SkillsCliCellError('the skills CLI package has no valid skills bin')
  }

  let packageRoot: string
  let binPath: string
  try {
    packageRoot = realpathSync(dirname(packageJsonPath))
    binPath = realpathSync(resolve(packageRoot, relativeBin))
  } catch {
    throw new SkillsCliCellError('the skills CLI bin is unreadable')
  }
  if (!isPathInside(packageRoot, binPath) || !lstatSync(binPath).isFile()) {
    throw new SkillsCliCellError('the skills CLI bin is not a contained regular file')
  }

  return {
    version: PINNED_SKILLS_CLI_VERSION,
    binPath,
    readRoots: packageDependencyClosure(packageJsonPath)
  }
}

function packageDependencyClosure(rootManifest: string): string[] {
  const pending = [realpathSync(rootManifest)]
  const manifests = new Set<string>()
  const roots = new Set<string>()
  while (pending.length > 0) {
    const manifestPath = pending.pop()!
    if (manifests.has(manifestPath)) continue
    if (manifests.size >= 64) throw new SkillsCliCellError('the skills CLI dependency closure is too large')
    manifests.add(manifestPath)
    const packageRoot = realpathSync(dirname(manifestPath))
    roots.add(packageRoot)
    // pnpm resolves declared dependencies through symlinks in the package's
    // virtual-store `node_modules` parent. The package root admits the link;
    // this exact parent admits traversal to its already-enumerated targets.
    roots.add(realpathSync(dirname(packageRoot)))

    let manifest: { dependencies?: unknown; optionalDependencies?: unknown }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    } catch {
      throw new SkillsCliCellError('the skills CLI dependency manifest is unreadable')
    }
    const names = new Set<string>()
    for (const value of [manifest.dependencies, manifest.optionalDependencies]) {
      if (!isStringRecord(value)) continue
      for (const name of Object.keys(value)) names.add(name)
    }
    const localRequire = createRequire(manifestPath)
    for (const name of [...names].sort()) {
      try {
        pending.push(realpathSync(localRequire.resolve(`${name}/package.json`)))
      } catch {
        throw new SkillsCliCellError(`the skills CLI dependency ${name} is unavailable`)
      }
    }
  }
  return [...roots].sort()
}

function bundledSkillsCli(): string | undefined {
  const modulePath = realpathSync(fileURLToPath(import.meta.url))
  const candidates = [
    // Published bundle: this module and the CLI both live below dist/.
    join(dirname(modulePath), 'skills', 'dist', 'cli.js'),
    // Source/dev after `pnpm build`: prefer the exact self-contained artifact
    // so its transitive dependency graph remains inside the read sandbox.
    join(dirname(modulePath), '..', '..', 'dist', 'skills', 'dist', 'cli.js')
  ]
  for (const unresolved of candidates) {
    try {
      const candidate = realpathSync(unresolved)
      const stat = lstatSync(candidate)
      // Published package managers may legitimately hard-link immutable
      // artifacts into a content-addressed store; nlink is not an input trust
      // boundary here.
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const manifest = JSON.parse(readFileSync(join(dirname(candidate), '..', 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (manifest.version !== PINNED_SKILLS_CLI_VERSION) continue
      return candidate
    } catch {
      // Try the next fixed, daemon-owned layout.
    }
  }
  return undefined
}

/** Run the exact local-source CLI inside a fresh, private staging cell. The live
 * workspace is never the CLI cwd; callers inspect the returned bundles and then
 * publish them using their own safe reconciler. */
export async function stageSkillsCliCell(options: StageSkillsCliCellOptions): Promise<SkillsCliCellResult> {
  const sourceSnapshot = canonicalSnapshotPath(options.sourceSnapshot)
  assertSafeToken(options.agentId, 'agent id')
  const selectedSkills = options.selectedSkills ?? []
  for (const skill of selectedSkills) assertSafeSelection(skill)

  const cli = (options.resolveCli ?? resolvePinnedSkillsCli)()
  if (cli.version !== PINNED_SKILLS_CLI_VERSION) {
    throw new SkillsCliCellError(`skills CLI version mismatch: expected ${PINNED_SKILLS_CLI_VERSION}`)
  }

  // SRT creates private Unix sockets below the cell, and the AF_UNIX path is
  // capped on both macOS (~104 bytes) and Linux (108 bytes) while daemon state
  // paths are often much longer. Use the short, sticky system temp root for real
  // sandboxed runs on either platform, or the SRT mux socket fails with EINVAL.
  // Injected test runners keep their requested parent because they do not start SRT.
  const cell = createCell(options.runner ? options.tempParent : tmpdir())
  const cleanup = (): void => {
    try {
      rmSync(cell.root, { recursive: true, force: true })
    } catch {
      // Best effort. A caller can retry because cleanup is deliberately idempotent.
    }
  }

  try {
    const env = isolatedEnvironment(cell, options.hostEnv ?? process.env)
    // SRT protects .claude/agents and .claude/commands by also denying
    // creation of their missing ancestor. The audited CLI may legitimately
    // create the sibling .claude/skills tree, so pre-create only that neutral
    // ancestor outside the child and remove it again when unused. This is a
    // sandbox compatibility detail, not a runtime destination map.
    const srtClaudeAncestor = join(cell.cwd, '.claude')
    if (!options.runner) mkdirSync(srtClaudeAncestor, { mode: 0o700 })
    const args = [
      'add',
      sourceSnapshot,
      '-a',
      options.agentId,
      '-y',
      '--copy',
      ...selectedSkills.flatMap((skill) => ['-s', skill])
    ]
    const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
    const execution = await (options.runner ?? execFileSkillsCliRunner)(process.execPath, [cli.binPath, ...args], {
      cwd: cell.cwd,
      env,
      timeoutMs: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
      maxOutputBytes,
      readRoots: [sourceSnapshot, ...(cli.readRoots ?? (existsSync(cli.binPath) ? [cliReadRoot(cli.binPath)] : []))]
    })
    assertBoundedOutput(execution, maxOutputBytes)
    if (execution.exitCode !== 0) {
      const detail = boundedFailureDetail(execution.stderr || execution.stdout)
      throw new SkillsCliCellError(`skills CLI exited with status ${execution.exitCode}${detail ? `: ${detail}` : ''}`)
    }
    if (/failed\s+to\s+install/i.test(stripAnsi(`${execution.stdout}\n${execution.stderr}`))) {
      const detail = boundedFailureDetail(execution.stderr || execution.stdout)
      throw new SkillsCliCellError(`skills CLI reported an install failure${detail ? `: ${detail}` : ''}`)
    }

    if (!options.runner && readdirSync(srtClaudeAncestor).length === 0) rmdirSync(srtClaudeAncestor)

    const scanned = scanSkillsCliCell(cell.cwd, options.limits)
    return {
      cellRoot: cell.root,
      cwd: cell.cwd,
      bundles: scanned.bundles,
      ...(scanned.lockFile === undefined ? {} : { lockFile: scanned.lockFile }),
      execution,
      cleanup
    }
  } catch (error) {
    cleanup()
    if (error instanceof SkillsCliCellError) throw error
    throw new SkillsCliCellError(error instanceof Error ? error.message : 'skills CLI staging failed')
  }
}

export async function execFileSkillsCliRunner(
  executable: string,
  args: string[],
  options: SkillsCliRunOptions
): Promise<SkillsCliRunResult> {
  const home = options.env.HOME
  if (!home) throw new SkillsCliCellError('skills CLI private HOME is missing')
  const scopeRoot = dirname(options.cwd)
  let launch: { cmd: string; args: string[] }
  let isolation: 'kernel' | 'process' = 'kernel'
  let isolationReason: string | undefined
  const sandboxProbe = probeOfflineSandboxHost()
  const shouldFallback = !sandboxProbe.available
  if (shouldFallback) {
    launch = { cmd: executable, args }
    isolation = 'process'
    isolationReason = sandboxProbe.reason || 'the offline kernel sandbox probe failed'
  } else {
    try {
      launch = offlineSandboxLaunch({
        command: executable,
        args,
        scopeRoot,
        cwd: options.cwd,
        home,
        readRoots: options.readRoots,
        writeRoots: [scopeRoot]
      })
    } catch (error) {
      launch = { cmd: executable, args }
      isolation = 'process'
      isolationReason = error instanceof Error ? error.message : 'the kernel sandbox launch failed'
    }
  }
  // Source/dev launches the trusted SRT provider through tsx. Keep tsx's own
  // IPC socket in a short private path (macOS limits Unix socket path length);
  // the provider resets the sandboxed child's TMPDIR back into private HOME.
  const providerTmp = mkdtempSync(join(tmpdir(), 'agentconnect-srt-'))
  chmodSync(providerTmp, 0o700)
  try {
    return await new Promise<SkillsCliRunResult>((resolveRun, rejectRun) => {
      execFile(
        launch.cmd,
        launch.args,
        {
          cwd: options.cwd,
          env: { ...options.env, TMPDIR: providerTmp, TMP: providerTmp, TEMP: providerTmp },
          encoding: 'utf8',
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: options.maxOutputBytes,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolveRun({ exitCode: 0, stdout, stderr, isolation, ...(isolationReason ? { isolationReason } : {}) })
            return
          }
          if (error.killed) {
            rejectRun(new SkillsCliCellError('skills CLI timed out'))
            return
          }
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            rejectRun(new SkillsCliCellError('skills CLI output exceeded its limit'))
            return
          }
          if (typeof error.code === 'number') {
            resolveRun({
              exitCode: error.code,
              stdout,
              stderr,
              isolation,
              ...(isolationReason ? { isolationReason } : {})
            })
            return
          }
          rejectRun(new SkillsCliCellError('skills CLI could not be started'))
        }
      )
    })
  } finally {
    rmSync(providerTmp, { recursive: true, force: true })
  }
}

function cliReadRoot(binPath: string): string {
  const binDir = dirname(realpathSync(binPath))
  // Published layout: <daemon-dist>/skills/dist/cli.js may share rolled-up
  // chunks with <daemon-dist>. Source/dev package layout keeps every chunk in
  // the CLI's own dist directory.
  if (basename(binDir) === 'dist' && basename(dirname(binDir)) === 'skills') return dirname(dirname(binDir))
  return basename(binDir) === 'bin' ? dirname(binDir) : binDir
}

/** Validate and inventory only the filesystem grammar the audited CLI is allowed
 * to produce: an optional root lockfile plus one or more directories shaped like
 * `[safe-prefix/]skills/<bundle>`. Prefixes are discovered from output rather
 * than inferred from a runtime-to-path map. */
export function scanSkillsCliCell(
  cwd: string,
  limitOverrides: Partial<SkillsCliCellLimits> = {}
): { bundles: SkillsCliBundle[]; lockFile?: string } {
  const limits = mergeLimits(limitOverrides)
  let entryCount = 0
  let totalBytes = 0
  let lockFile: string | undefined
  const bundles: SkillsCliBundle[] = []

  const countEntry = (): void => {
    entryCount += 1
    if (entryCount > limits.maxEntries) throw new SkillsCliCellError('skills CLI cell has too many entries')
  }

  const assertDepth = (depth: number): void => {
    if (depth > limits.maxDepth) throw new SkillsCliCellError('skills CLI cell exceeds its depth limit')
  }

  const scanSkillsDirectory = (skillsPath: string, prefix: string[], depth: number): number => {
    let found = 0
    for (const bundleName of sortedNames(skillsPath)) {
      countEntry()
      assertDepth(depth + 1)
      assertSafeLayoutSegment(bundleName, 'bundle name')
      const bundlePath = join(skillsPath, bundleName)
      const bundleStat = lstatSync(bundlePath)
      if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
        throw new SkillsCliCellError(`skills CLI bundle is not a directory: ${bundleName}`)
      }
      if (bundles.length >= limits.maxBundles) {
        throw new SkillsCliCellError('skills CLI cell has too many bundles')
      }

      const inventory = scanBundle(bundlePath, limits, countEntry, depth + 1)
      totalBytes += inventory.totalBytes
      if (totalBytes > limits.maxTotalBytes) throw new SkillsCliCellError('skills CLI cell exceeds its byte limit')
      const relativePath = [...prefix, 'skills', bundleName].join('/')
      bundles.push({
        relativePath,
        absolutePath: bundlePath,
        root: prefix.join('/'),
        name: bundleName,
        fileCount: inventory.fileCount,
        totalBytes: inventory.totalBytes
      })
      found += 1
    }
    if (found === 0) throw new SkillsCliCellError(`skills CLI output has no bundles below ${skillsPath}`)
    return found
  }

  const scanLayoutDirectory = (directory: string, prefix: string[], depth: number): number => {
    let found = 0
    for (const name of sortedNames(directory)) {
      countEntry()
      assertDepth(depth + 1)
      const path = join(directory, name)
      const stat = lstatSync(path)

      if (depth === 0 && name === 'skills-lock.json') {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limits.maxLockBytes) {
          throw new SkillsCliCellError('skills CLI lockfile is not a bounded regular file')
        }
        lockFile = path
        continue
      }

      assertSafeLayoutSegment(name, 'layout segment')
      if (depth === 0 && (name.toLowerCase() === '.git' || name.toLowerCase() === '.agentconnect')) {
        throw new SkillsCliCellError(`reserved skills CLI first segment: ${name}`)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new SkillsCliCellError(`unexpected skills CLI file outside a bundle: ${[...prefix, name].join('/')}`)
      }

      if (name === 'skills') {
        found += scanSkillsDirectory(path, prefix, depth + 1)
        continue
      }

      const branchFound = scanLayoutDirectory(path, [...prefix, name], depth + 1)
      if (branchFound === 0) {
        throw new SkillsCliCellError(`unexpected skills CLI output below ${[...prefix, name].join('/')}`)
      }
      found += branchFound
    }
    return found
  }

  scanLayoutDirectory(cwd, [], 0)

  if (bundles.length === 0) throw new SkillsCliCellError('skills CLI produced no skill bundles')
  bundles.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { bundles, ...(lockFile === undefined ? {} : { lockFile }) }
}

function scanBundle(
  bundlePath: string,
  limits: SkillsCliCellLimits,
  countEntry: () => void,
  bundleDepth: number
): { fileCount: number; totalBytes: number } {
  let fileCount = 0
  let totalBytes = 0
  let hasManifest = false
  const pending: Array<{ path: string; depth: number }> = [{ path: bundlePath, depth: bundleDepth }]

  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of sortedNames(current.path)) {
      countEntry()
      if (current.depth + 1 > limits.maxDepth) throw new SkillsCliCellError('skills CLI cell exceeds its depth limit')
      assertSafeBundleSegment(name)
      const path = join(current.path, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new SkillsCliCellError('skills CLI bundle contains a link or special file')
      }
      if (stat.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 })
        continue
      }
      if (stat.nlink !== 1) throw new SkillsCliCellError('skills CLI bundle contains a hard-linked file')
      fileCount += 1
      totalBytes += stat.size
      if (fileCount > limits.maxFilesPerBundle) throw new SkillsCliCellError('skills CLI bundle has too many files')
      if (stat.size > limits.maxFileBytes) throw new SkillsCliCellError('skills CLI bundle contains an oversized file')
      if (totalBytes > limits.maxBytesPerBundle)
        throw new SkillsCliCellError('skills CLI bundle exceeds its byte limit')
      if (current.depth === bundleDepth && name === 'SKILL.md') hasManifest = true
    }
  }
  if (!hasManifest) throw new SkillsCliCellError('skills CLI bundle is missing SKILL.md')
  return { fileCount, totalBytes }
}

function createCell(tempParent: string | undefined): {
  root: string
  cwd: string
  home: string
  xdgConfig: string
  xdgCache: string
  xdgData: string
  xdgState: string
  xdgRuntime: string
  temp: string
  codexHome: string
  claudeConfig: string
} {
  const root = mkdtempSync(join(tempParent ?? tmpdir(), 'agentconnect-skills-cell-'))
  chmodSync(root, 0o700)
  const dirs = {
    root,
    cwd: join(root, 'workspace'),
    home: join(root, 'home'),
    xdgConfig: join(root, 'xdg-config'),
    xdgCache: join(root, 'xdg-cache'),
    xdgData: join(root, 'xdg-data'),
    xdgState: join(root, 'xdg-state'),
    xdgRuntime: join(root, 'xdg-runtime'),
    temp: join(root, 'tmp'),
    codexHome: join(root, 'codex-home'),
    claudeConfig: join(root, 'claude-config')
  }
  for (const path of Object.values(dirs)) {
    if (path !== root) mkdirSync(path, { mode: 0o700 })
  }
  return dirs
}

function isolatedEnvironment(cell: ReturnType<typeof createCell>, hostEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(typeof hostEnv.PATH === 'string' ? { PATH: hostEnv.PATH } : {}),
    HOME: cell.home,
    XDG_CONFIG_HOME: cell.xdgConfig,
    XDG_CACHE_HOME: cell.xdgCache,
    XDG_DATA_HOME: cell.xdgData,
    XDG_STATE_HOME: cell.xdgState,
    XDG_RUNTIME_DIR: cell.xdgRuntime,
    TMPDIR: cell.temp,
    TMP: cell.temp,
    TEMP: cell.temp,
    CODEX_HOME: cell.codexHome,
    CLAUDE_CONFIG_DIR: cell.claudeConfig,
    CI: '1',
    DO_NOT_TRACK: '1',
    DISABLE_TELEMETRY: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
}

function canonicalSnapshotPath(path: string): string {
  if (!isAbsolute(path)) throw new SkillsCliCellError('skills CLI source snapshot must be absolute')
  const normalized = resolve(path)
  let canonical: string
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(normalized)
    canonical = realpathSync(normalized)
  } catch {
    throw new SkillsCliCellError('skills CLI source snapshot is unreadable')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillsCliCellError('skills CLI source snapshot must be a directory, not a link')
  }
  return canonical
}

function assertSafeToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new SkillsCliCellError(`invalid ${label}`)
  }
}

function assertSafeSelection(value: string): void {
  // A selection is matched by the CLI against SKILL.md frontmatter names
  // (case-insensitively), which need not be canonical leaf names — the
  // installer resolves wire-canonical selections to those names first
  // (skill-cli-selection.ts) and compares the audited output receipt against
  // the resolved leaf set itself. This boundary only refuses values that
  // could be parsed as options or garble the argv.
  if (value.length === 0 || value.length > 255 || value.startsWith('-') || !/^[\x20-\x7e]+$/.test(value)) {
    throw new SkillsCliCellError('invalid selected skill')
  }
}

function assertSafeLayoutSegment(value: string, label: string): void {
  if (
    value.length > 128 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    !/^\.?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(value)
  ) {
    throw new SkillsCliCellError(`unsafe skills CLI ${label}: ${value}`)
  }
}

function assertSafeBundleSegment(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new SkillsCliCellError('skills CLI bundle contains an unsafe path segment')
  }
}

function assertBoundedOutput(result: SkillsCliRunResult, maxOutputBytes: number): void {
  if (
    Buffer.byteLength(result.stdout, 'utf8') > maxOutputBytes ||
    Buffer.byteLength(result.stderr, 'utf8') > maxOutputBytes
  ) {
    throw new SkillsCliCellError('skills CLI output exceeded its limit')
  }
}

function mergeLimits(overrides: Partial<SkillsCliCellLimits>): SkillsCliCellLimits {
  const merged = { ...DEFAULT_SKILLS_CLI_CELL_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(merged)) positiveInteger(value, name)
  return merged
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SkillsCliCellError(`${name} must be a positive integer`)
  return value
}

function sortedNames(path: string): string[] {
  return readdirSync(path).sort((a, b) => a.localeCompare(b))
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

function boundedFailureDetail(value: string): string {
  return stripAnsi(value).split(/\r?\n/, 1)[0]!.trim().slice(0, 512)
}
