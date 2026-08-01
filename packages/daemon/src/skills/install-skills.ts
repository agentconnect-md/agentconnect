/**
 * Install an agent's enabled skills into its workspace with the exact-pinned
 * `skills` CLI bundled into the daemon (docs/designs/shared-skills.md §6).
 * Runs after the workspace is ready and before the ACP session starts, so the
 * runtime discovers skills in its project-scope directory.
 *
 * The workspace is agent-writable across sessions while this installer runs
 * with daemon authority. Consequently:
 *
 * - the CLI is launched through the daemon's own hidden entry, never `npx` or
 *   project-local package resolution;
 * - reconciliation state lives below the daemon-owned agent root, not `cwd`;
 * - every workspace path the daemon removes or the CLI writes is checked with
 *   no-follow containment first.
 *
 * Non-blocking by contract: a refused path, offline source, or unsupported
 * runtime degrades to no newly installed skill and the session still starts.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { ContainedPathError, containedRemoveDir, containedTarget } from '../fs/contained-path.js'
import { skillsAgentId } from './runtime-agent-map.js'
import { SKILLS_CLI_VERSION } from './version.js'

export { SKILLS_CLI_VERSION } from './version.js'

type SkillsExec = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
) => Promise<unknown>

const execFileAsync = promisify(execFile) as SkillsExec

const INSTALL_TIMEOUT_MS = 20_000
const MARKER_DIR = '.agentconnect'
const MARKER_FILE = 'skills-install.json'
const MAX_MARKER_BYTES = 64 * 1024
const LOCAL_LOCK_FILE = 'skills-lock.json'
const MAX_LOCAL_LOCK_BYTES = 1024 * 1024
const MAX_WORKSPACE_RECORDS = 16
const WORKSPACE_ID = /^[0-9a-f]{64}$/
const WORKSPACE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SKILL_ROOTS = ['.claude/skills', '.agents/skills'] as const

interface WorkspaceRecord {
  fingerprint?: string
  /** Canonical cwd used to confirm that this directory instance still exists. */
  workspacePath?: string
  /** Kernel replacement witness for the actual ACP cwd, including agentDir. */
  workspaceWitness?: string
  /** cwd-relative skill dirs this daemon created (for reconcile removal). */
  installed: string[]
}

interface Marker {
  /** Daemon-issued identity for the currently materialized workspace tree. */
  generation?: string
  /** Ownership records keyed by daemon-computed workspace directory identity. */
  workspaces: Record<string, WorkspaceRecord>
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** Compose the string handed to `skills add` from a skill entry, folding an
 * optional ref/subDir into the GitHub `tree/<ref>/<subdir>` path form. */
export function composeSource(entry: AgentSkillEntry): string {
  const { source, ref, subDir } = entry
  if (/\/tree\//.test(source)) return source
  if (!ref && !subDir) return source
  const shorthand = /^[^/\s]+\/[^/\s]+$/.test(source)
  const base = shorthand ? `https://github.com/${source}` : source
  if (!/^https?:\/\/github\.com\//i.test(base)) return source
  const suffix = subDir ? `/${subDir.replace(/^\/+/, '')}` : ''
  return `${base.replace(/\/+$/, '')}/tree/${ref ?? 'main'}${suffix}`
}

function fingerprint(runtime: string, agentId: string, entries: AgentSkillEntry[], workspaceId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ runtime, agentId, entries, cliVersion: SKILLS_CLI_VERSION, workspaceId }))
    .digest('hex')
}

/** Bind private ownership state to one cwd within a daemon-issued workspace
 * generation. The agent cannot forge the generation in this private marker. */
interface WorkspaceIdentity {
  id: string
  path: string
  witness: string
}

function workspaceId(generation: string, path: string): string {
  return createHash('sha256').update(JSON.stringify({ generation, path })).digest('hex')
}

async function directoryWitness(path: string): Promise<string | null> {
  let stat: import('node:fs').BigIntStats
  try {
    stat = await fsp.lstat(path, { bigint: true })
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null
    throw err
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  // birthtime is stable across writes but changes when a directory is replaced.
  // Some filesystems expose no birthtime; ctime is a conservative fail-closed
  // fallback there (ordinary top-level edits may invalidate ownership early).
  const born = stat.birthtimeNs > 0n ? ['birth', stat.birthtimeNs] : ['ctime', stat.ctimeNs]
  return createHash('sha256')
    .update(JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), born: born.map(String) }))
    .digest('hex')
}

async function workspaceIdentity(cwd: string, generation: string): Promise<WorkspaceIdentity> {
  const canonical = await fsp.realpath(cwd)
  const witness = await directoryWitness(canonical)
  if (!witness) throw new ContainedPathError('skills workspace is not a real directory')
  return { id: workspaceId(generation, canonical), path: canonical, witness }
}

function markerPath(stateDir: string): string {
  return join(stateDir, MARKER_DIR, MARKER_FILE)
}

async function atomicContainedWrite(
  boundary: string,
  root: string,
  destination: string,
  body: string,
  label: string,
  mode = 0o600
): Promise<void> {
  const target = await containedTarget(boundary, root, destination, { create: true, label })
  if (!target) throw new ContainedPathError(`${label} could not be resolved`)
  const temp = join(dirname(target), `.agentconnect-${randomUUID()}.tmp`)
  try {
    const handle = await fsp.open(temp, 'wx', mode)
    try {
      await handle.writeFile(body, 'utf8')
    } finally {
      await handle.close()
    }
    await fsp.rename(temp, target)
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function readMarker(stateDir: string): Promise<Marker> {
  const target = await containedTarget(stateDir, join(stateDir, MARKER_DIR), markerPath(stateDir), {
    create: false,
    label: 'skills marker'
  })
  if (!target) return { workspaces: {} }
  let stat: import('node:fs').Stats
  try {
    stat = await fsp.lstat(target)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { workspaces: {} }
    throw err
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ContainedPathError('skills marker is not a regular file')
  }
  if (stat.size > MAX_MARKER_BYTES) throw new ContainedPathError('skills marker exceeds its size cap')
  const raw = JSON.parse(await fsp.readFile(target, 'utf8')) as { generation?: unknown; workspaces?: unknown }
  const generation =
    typeof raw.generation === 'string' && WORKSPACE_GENERATION.test(raw.generation) ? raw.generation : undefined
  if (!raw.workspaces || typeof raw.workspaces !== 'object' || Array.isArray(raw.workspaces)) {
    return { ...(generation ? { generation } : {}), workspaces: {} }
  }
  const workspaces: Record<string, WorkspaceRecord> = {}
  for (const [workspaceId, value] of Object.entries(raw.workspaces)) {
    if (!WORKSPACE_ID.test(workspaceId) || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as {
      fingerprint?: unknown
      workspacePath?: unknown
      workspaceWitness?: unknown
      installed?: unknown
    }
    workspaces[workspaceId] = {
      ...(typeof record.fingerprint === 'string' ? { fingerprint: record.fingerprint } : {}),
      ...(typeof record.workspacePath === 'string' &&
      isAbsolute(record.workspacePath) &&
      !record.workspacePath.includes('\0')
        ? { workspacePath: record.workspacePath }
        : {}),
      ...(typeof record.workspaceWitness === 'string' && WORKSPACE_ID.test(record.workspaceWitness)
        ? { workspaceWitness: record.workspaceWitness }
        : {}),
      installed: Array.isArray(record.installed)
        ? record.installed.filter((path): path is string => typeof path === 'string')
        : []
    }
    if (Object.keys(workspaces).length > MAX_WORKSPACE_RECORDS) {
      throw new ContainedPathError('skills marker has too many workspace records')
    }
  }
  return { ...(generation ? { generation } : {}), workspaces }
}

async function writeMarker(stateDir: string, marker: Marker): Promise<void> {
  await atomicContainedWrite(
    stateDir,
    join(stateDir, MARKER_DIR),
    markerPath(stateDir),
    JSON.stringify(marker) + '\n',
    'skills marker'
  )
}

/** Invalidate every deletion grant before the daemon replaces a workspace
 * tree. A random generation cannot alias a later directory through inode reuse. */
export async function rotateSkillsWorkspaceGeneration(stateDir: string): Promise<void> {
  await readMarker(stateDir)
  await writeMarker(stateDir, { generation: randomUUID(), workspaces: {} })
}

/** Reserve one bounded private-state slot before invoking the CLI. A record is
 * reclaimable when it owns nothing or its exact directory instance no longer
 * exists. Refuse a new workspace rather than evict ownership from a live one. */
async function ensureWorkspaceCapacity(marker: Marker, workspace: WorkspaceIdentity): Promise<Marker> {
  if (marker.workspaces[workspace.id]) return marker
  const workspaces = { ...marker.workspaces }
  let size = Object.keys(workspaces).length
  for (const [id, record] of Object.entries(workspaces)) {
    if (size < MAX_WORKSPACE_RECORDS) break
    let reclaimable = record.installed.length === 0
    if (!reclaimable && record.workspacePath) {
      if (record.workspacePath === workspace.path) {
        reclaimable = true
      } else {
        const witness = await directoryWitness(record.workspacePath)
        reclaimable = !witness || witness !== record.workspaceWitness
      }
    }
    if (!reclaimable) continue
    delete workspaces[id]
    size -= 1
  }
  if (size >= MAX_WORKSPACE_RECORDS) {
    throw new ContainedPathError('skills ownership state is full')
  }
  return { ...marker, workspaces }
}

function withWorkspaceRecord(marker: Marker, workspaceId: string, record: WorkspaceRecord): Marker {
  return { ...marker, workspaces: { ...marker.workspaces, [workspaceId]: record } }
}

/** Only a direct child of a known project skill root can be daemon-owned. */
function isTrackedSkillDir(rel: string): boolean {
  const match = /^(\.claude\/skills|\.agents\/skills)\/([^/]+)$/.exec(rel)
  return match !== null && match[2] !== '.' && match[2] !== '..' && !match[2]!.includes('\0')
}

function trackedPath(cwd: string, rel: string): { root: string; target: string } {
  const rootRel = rel.slice(0, rel.lastIndexOf('/'))
  return {
    root: join(cwd, ...rootRel.split('/')),
    target: join(cwd, ...rel.split('/'))
  }
}

/** Resolve a skill root by walking every parent with lstat. Passing a synthetic
 * child makes the root itself part of that walk, so a symlink at `.claude`,
 * `.agents`, or `skills` is refused rather than followed. */
async function safeSkillRoot(cwd: string, rootRel: (typeof SKILL_ROOTS)[number], create: boolean) {
  const root = join(cwd, ...rootRel.split('/'))
  const probe = await containedTarget(cwd, root, join(root, '.agentconnect-path-check'), {
    create,
    label: 'skill root'
  })
  return probe ? dirname(probe) : null
}

async function skillDirSnapshot(cwd: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const rootRel of SKILL_ROOTS) {
    const root = await safeSkillRoot(cwd, rootRel, false)
    if (!root) continue
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch (err) {
      if (isErrno(err, 'ENOENT')) continue
      throw err
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const stat = await fsp.lstat(join(root, entry.name))
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      // The pinned CLI replaces a target directory before copying. Tracking the
      // inode/timestamps as well as new names lets the first private-marker pass
      // adopt copies installed by an older daemon without reading its untrusted
      // workspace marker.
      out.set(`${rootRel}/${entry.name}`, `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}`)
    }
  }
  return out
}

async function validateSkillRoots(cwd: string): Promise<void> {
  for (const rootRel of SKILL_ROOTS) await safeSkillRoot(cwd, rootRel, false)
}

async function trackedTargetIntact(cwd: string, rel: string): Promise<boolean> {
  const { root, target } = trackedPath(cwd, rel)
  const resolved = await containedTarget(cwd, root, target, { create: false, label: 'skill path' })
  if (!resolved) return false
  try {
    const stat = await fsp.lstat(resolved)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

/** `skills add` writes this project lock alongside the skill roots. Refuse a
 * symlink, special file, hard link, or unbounded file before handing the path to
 * the trusted CLI; the agent is not running concurrently with this prep step. */
async function assertSafeLocalLock(cwd: string): Promise<void> {
  const target = join(cwd, LOCAL_LOCK_FILE)
  let stat: import('node:fs').Stats
  try {
    stat = await fsp.lstat(target)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return
    throw err
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ContainedPathError(`${LOCAL_LOCK_FILE} is not a private regular file`)
  }
  if (stat.size > MAX_LOCAL_LOCK_BYTES) throw new ContainedPathError(`${LOCAL_LOCK_FILE} exceeds its size cap`)
}

/** Remove the obsolete workspace marker only by unlinking its final entry. Its
 * contents never influence ownership; a symlink parent is refused and ignored. */
async function removeLegacyMarker(cwd: string): Promise<void> {
  try {
    const root = join(cwd, MARKER_DIR)
    const target = await containedTarget(cwd, root, join(root, MARKER_FILE), {
      create: false,
      label: 'legacy skills marker'
    })
    if (!target) return
    const stat = await fsp.lstat(target)
    if (stat.isFile() || stat.isSymbolicLink()) await fsp.unlink(target)
  } catch {
    // Private state is already authoritative; legacy cleanup is cosmetic.
  }
}

/** Source/dev runs through tsx; the published self-contained daemon re-enters
 * its dist entry directly. Neither path consults the workspace's node_modules. */
function skillsCliLauncher(): { cmd: string; args: string[] } {
  const sourceEntry = fileURLToPath(new URL('../index.ts', import.meta.url))
  if (existsSync(sourceEntry)) {
    const req = createRequire(import.meta.url)
    return { cmd: process.execPath, args: [req.resolve('tsx/cli'), sourceEntry] }
  }
  const entry = process.argv[1]
  if (!entry) throw new Error('cannot locate the AgentConnect skills CLI entry')
  return { cmd: process.execPath, args: [entry] }
}

/** Walk up to the repository root so exclude patterns work for a nested ACP cwd. */
function findRepoRoot(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Cosmetic only, but still a daemon-authority write into an agent-writable repo.
 * Use the same no-follow + atomic publish discipline as correctness state. */
async function excludeFromGit(cwd: string): Promise<void> {
  const repoRoot = findRepoRoot(cwd)
  if (!repoRoot) return
  const gitPath = join(repoRoot, '.git')
  try {
    const gitStat = await fsp.lstat(gitPath)
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) return // linked worktree or refused link
    const info = join(gitPath, 'info')
    const exclude = join(info, 'exclude')
    const target = await containedTarget(repoRoot, info, exclude, { create: true, label: 'git exclude' })
    if (!target) return
    let current = ''
    try {
      const stat = await fsp.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_LOCAL_LOCK_BYTES) return
      current = await fsp.readFile(target, 'utf8')
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) return
    }
    const prefix = relative(repoRoot, cwd)
    const rooted = prefix ? `${prefix}/` : ''
    const want = [...SKILL_ROOTS.map((root) => `${rooted}${root}/`), `${rooted}${MARKER_DIR}/`]
    const lines = new Set(current.split(/\r?\n/))
    const missing = want.filter((entry) => !lines.has(entry))
    if (missing.length === 0) return
    const next = current + (current === '' || current.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n'
    await atomicContainedWrite(repoRoot, info, exclude, next, 'git exclude')
  } catch {
    // A dirty status is cosmetic; path refusal must not block the session.
  }
}

export interface InstallSkillsResult {
  installed: string[]
  removed: string[]
  skipped: 'unchanged' | null
  errors: Array<{ source: string; error: string }>
}

export interface InstallSkillsOptions {
  /** Trusted loader-derived agent root; never derive this from workspace config. */
  stateDir: string
  env?: NodeJS.ProcessEnv
  warn?: (msg: string) => void
  /** Test seam; production always uses Node + the daemon's hidden CLI entry. */
  execFile?: SkillsExec
}

/** Install and reconcile agent skills. Never throws. */
export async function installSkills(
  agent: Pick<Agent, 'id' | 'runtime' | 'skills'>,
  cwd: string,
  opts: InstallSkillsOptions
): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = { installed: [], removed: [], skipped: null, errors: [] }
  const entries = agent.skills ?? []
  const agentId = skillsAgentId(agent.runtime)
  // The bundled upstream module cannot discover its own package.json after
  // bundling; disable its optional telemetry rather than reporting the daemon's
  // package version as the CLI version.
  const env = { GIT_TERMINAL_PROMPT: '0', ...process.env, ...opts.env, DISABLE_TELEMETRY: '1' }

  try {
    const loadedMarker = await readMarker(opts.stateDir)
    const generation = loadedMarker.generation ?? randomUUID()
    // Pre-generation records used reusable filesystem identities. Forget their
    // deletion grants rather than risk applying one to a fresh materialization.
    const generatedMarker = loadedMarker.generation
      ? loadedMarker
      : { generation, workspaces: {} as Record<string, WorkspaceRecord> }
    const workspace = await workspaceIdentity(cwd, generation)
    const fp = fingerprint(agent.runtime, agentId ?? '', entries, workspace.id)
    const marker = await ensureWorkspaceCapacity(generatedMarker, workspace)
    // Create/validate the private marker parent before mutating the workspace.
    await containedTarget(opts.stateDir, join(opts.stateDir, MARKER_DIR), markerPath(opts.stateDir), {
      create: true,
      label: 'skills marker'
    })
    const prior = marker.workspaces[workspace.id] ?? { installed: [] }
    const priorMatchesWorkspace = prior.workspaceWitness === workspace.witness
    const priorTracked = priorMatchesWorkspace ? prior.installed.filter(isTrackedSkillDir) : []

    // Validate existing roots before any reconcile operation. This rejects a
    // planted root symlink even when it is unrelated to the first tracked path.
    if (priorTracked.length > 0 || entries.length > 0) await validateSkillRoots(cwd)

    const intact = await Promise.all(priorTracked.map((rel) => trackedTargetIntact(cwd, rel)))
    const targetsIntact = priorTracked.length === prior.installed.length && intact.every(Boolean)
    const cacheCoversDesired = entries.length === 0 || priorTracked.length > 0
    if (priorMatchesWorkspace && prior.fingerprint === fp && targetsIntact && cacheCoversDesired) {
      if (prior.workspacePath !== workspace.path) {
        await writeMarker(
          opts.stateDir,
          withWorkspaceRecord(marker, workspace.id, { ...prior, workspacePath: workspace.path })
        )
      }
      await removeLegacyMarker(cwd)
      result.skipped = 'unchanged'
      return result
    }

    // Failed removals stay owned in the private marker so a later prep retries.
    const retained: string[] = []
    for (const rel of priorTracked) {
      const { root, target } = trackedPath(cwd, rel)
      try {
        await containedRemoveDir(cwd, root, target)
        result.removed.push(rel)
      } catch (err) {
        retained.push(rel)
        opts.warn?.(`skills: could not remove stale skill "${rel}" — ${err instanceof Error ? err.message : ''}`)
      }
    }

    if (entries.length === 0 || !agentId) {
      if (!agentId && entries.length > 0) {
        opts.warn?.(`skills: no installer mapping for runtime "${agent.runtime}"; skipping install`)
      }
      await writeMarker(
        opts.stateDir,
        withWorkspaceRecord(marker, workspace.id, {
          ...(retained.length === 0 ? { fingerprint: fp } : {}),
          workspacePath: workspace.path,
          workspaceWitness: (await workspaceIdentity(cwd, generation)).witness,
          installed: retained
        })
      )
      await removeLegacyMarker(cwd)
      return result
    }

    const rootRel = agentId === 'claude-code' ? '.claude/skills' : '.agents/skills'
    await safeSkillRoot(cwd, rootRel, true)
    await assertSafeLocalLock(cwd)
    const before = await skillDirSnapshot(cwd)
    const launch = skillsCliLauncher()
    const run = opts.execFile ?? execFileAsync

    for (const entry of entries) {
      const composed = composeSource(entry)
      if (composed.startsWith('-')) {
        result.errors.push({ source: entry.name, error: 'source resolves to an option-like argument' })
        opts.warn?.(`skills: skipping option-like source for "${entry.name}": ${composed}`)
        continue
      }
      const skillFlags = entry.skills.filter((skill) => !skill.startsWith('-'))
      if (skillFlags.length !== entry.skills.length) {
        opts.warn?.(`skills: dropped option-like skill name(s) for "${entry.name}"`)
      }
      const args = [
        ...launch.args,
        '__skills-cli',
        'add',
        composed,
        '-a',
        agentId,
        '-y',
        '--copy',
        ...skillFlags.flatMap((skill) => ['-s', skill])
      ]
      try {
        await run(launch.cmd, args, { cwd, env, timeout: INSTALL_TIMEOUT_MS })
        result.installed.push(entry.name)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push({ source: entry.name, error: message })
        opts.warn?.(`skills: install failed for "${entry.name}" (${composed}): ${message}`)
      }
    }

    const after = await skillDirSnapshot(cwd)
    const created = [...after].filter(([path, signature]) => before.get(path) !== signature).map(([path]) => path)
    await excludeFromGit(cwd)
    const effective = retained.length === 0 && result.errors.length === 0 && created.length > 0
    await writeMarker(
      opts.stateDir,
      withWorkspaceRecord(marker, workspace.id, {
        ...(effective ? { fingerprint: fp } : {}),
        workspacePath: workspace.path,
        workspaceWitness: (await workspaceIdentity(cwd, generation)).witness,
        installed: [...new Set([...retained, ...created])]
      })
    )
    await removeLegacyMarker(cwd)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors.push({ source: '*', error: message })
    opts.warn?.(
      err instanceof ContainedPathError
        ? `skills: refused workspace installation — ${message}`
        : `skills: could not prepare workspace installation — ${message}`
    )
    return result
  }
}
