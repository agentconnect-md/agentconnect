/**
 * Install an agent's enabled skills into its workspace via `npx skills`
 * (docs/designs/shared-skills.md §6). Runs after the workspace is ready and
 * before the ACP session starts, so the runtime discovers the skills in its
 * project-scope directory (Claude: `<cwd>/.claude/skills`). The CLI owns the
 * per-runtime target layout — we only name the agent (`-a`).
 *
 * Non-blocking by contract: any failure (offline, missing CLI, bad source, a
 * runtime with no `npx skills` mapping) degrades to "no skill installed" and the
 * session still starts. Idempotent: a fingerprint marker in the workspace skips
 * the whole `npx` pass when the enabled set + runtime are unchanged, so the
 * common case costs one stat, not a network round-trip.
 *
 * Reconciling: `npx skills add` only ADDS, so disabling or narrowing a source
 * would leave stale skill copies the runtime keeps auto-discovering. The marker
 * records exactly the skill directories THIS daemon created; a changed run removes
 * those first (never touching manually-authored skills) before re-installing the
 * desired set — including the zero-desired case.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { skillsAgentId } from './runtime-agent-map.js'

const execFileAsync = promisify(execFile)

// The `npx skills` package spec. Left unpinned for now; centralize the pin here
// once a version is chosen (design §6.2 — pinning guards against CLI drift).
const SKILLS_CLI_SPEC = 'skills'
// Per-source install budget. A wedged network fetch must not hold the session.
const INSTALL_TIMEOUT_MS = 20_000
const MARKER_DIR = '.agentconnect'
const MARKER_FILE = 'skills-install.json'
// Project-scope skill roots the CLI writes into, relative to the ACP cwd: Claude
// uses `.claude/skills`, the other supported agents (codex/cursor/opencode/gemini)
// use `.agents/skills`. Both are watched for reconcile + git-excluded.
const SKILL_ROOTS = ['.claude/skills', '.agents/skills']

interface Marker {
  fingerprint?: string
  /** cwd-relative skill dirs this daemon created (for reconcile removal). */
  installed: string[]
}

/** Compose the string handed to `npx skills add` from a skill entry, folding an
 *  optional ref/subDir into the GitHub `tree/<ref>/<subdir>` path form (design §5).
 *  A source that already carries a `tree/` path, or a non-GitHub URL, passes
 *  through untouched. */
export function composeSource(entry: AgentSkillEntry): string {
  const { source, ref, subDir } = entry
  if (/\/tree\//.test(source)) return source // already pinned to a ref/path
  if (!ref && !subDir) return source
  const shorthand = /^[^/\s]+\/[^/\s]+$/.test(source)
  const base = shorthand ? `https://github.com/${source}` : source
  if (!/^https?:\/\/github\.com\//i.test(base)) return source // only github supports the tree path form
  const suffix = subDir ? `/${subDir.replace(/^\/+/, '')}` : ''
  return `${base.replace(/\/+$/, '')}/tree/${ref ?? 'main'}${suffix}`
}

function fingerprint(runtime: string, agentId: string, entries: AgentSkillEntry[]): string {
  return createHash('sha256').update(JSON.stringify({ runtime, agentId, entries })).digest('hex')
}

function markerPath(cwd: string): string {
  return join(cwd, MARKER_DIR, MARKER_FILE)
}

function readMarker(cwd: string): Marker {
  try {
    const raw = JSON.parse(readFileSync(markerPath(cwd), 'utf8')) as { fingerprint?: unknown; installed?: unknown }
    return {
      ...(typeof raw.fingerprint === 'string' ? { fingerprint: raw.fingerprint } : {}),
      installed: Array.isArray(raw.installed) ? raw.installed.filter((p): p is string => typeof p === 'string') : []
    }
  } catch {
    return { installed: [] }
  }
}

function writeMarker(cwd: string, marker: Marker): void {
  try {
    mkdirSync(join(cwd, MARKER_DIR), { recursive: true })
    writeFileSync(markerPath(cwd), JSON.stringify(marker) + '\n')
  } catch {
    // A missing/stale marker only costs a redundant re-install next session — never fatal.
  }
}

/** cwd-relative paths of the skill directories currently present under the CLI's
 *  project-scope roots. Used to diff before/after an install (what WE created) and
 *  to remove exactly our own copies on a later change. */
function listSkillDirs(cwd: string): string[] {
  const out: string[] = []
  for (const root of SKILL_ROOTS) {
    const abs = join(cwd, root)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue // root absent
    }
    for (const e of entries) if (e.isDirectory()) out.push(`${root}/${e.name}`)
  }
  return out
}

/** Walk up from `cwd` to the repository root (the dir holding `.git`), so exclude
 *  patterns land in the real repo even when the ACP cwd is a nested `agentDir`.
 *  Returns undefined for a from-scratch workspace (no `.git` above cwd). */
function findRepoRoot(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Keep installed skill dirs (and the marker) out of a git-repo workspace's tracked
 *  tree so the agent's `git status` stays clean. Excludes at the repo root (not the
 *  possibly-nested cwd), covering both `.claude/skills` and `.agents/skills`.
 *  Best-effort; from-scratch workspaces have no `.git` and are skipped. */
function excludeFromGit(cwd: string): void {
  const repoRoot = findRepoRoot(cwd)
  if (repoRoot === undefined) return
  const gitPath = join(repoRoot, '.git')
  // A linked worktree has `.git` as a file pointing elsewhere; skip (cosmetic only).
  try {
    if (!statSync(gitPath).isDirectory()) return
  } catch {
    return
  }
  const exclude = join(gitPath, 'info', 'exclude')
  // Patterns are repo-root-relative — anchor them under the (possibly nested) cwd.
  const rel = cwd === repoRoot ? '' : `${cwd.slice(repoRoot.length + 1)}/`
  const want = [...SKILL_ROOTS.map((r) => `${rel}${r}/`), `${rel}${MARKER_DIR}/`]
  try {
    mkdirSync(dirname(exclude), { recursive: true })
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    const missing = want.filter((p) => !current.includes(p))
    if (missing.length)
      appendFileSync(exclude, (current === '' || current.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n')
  } catch {
    // ignore — a dirty status is cosmetic, not correctness
  }
}

export interface InstallSkillsResult {
  installed: string[]
  removed: string[]
  skipped: 'unchanged' | null
  errors: Array<{ source: string; error: string }>
}

/**
 * Install `agent.skills` into `cwd`, reconciling away skill copies this daemon
 * previously created but that are no longer desired. Never throws. `env` is merged
 * into the child (git credential helper vars for private sources,
 * GIT_TERMINAL_PROMPT=0, etc.); `warn` receives non-fatal diagnostics.
 */
export async function installSkills(
  agent: Pick<Agent, 'id' | 'runtime' | 'skills'>,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {}
): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = { installed: [], removed: [], skipped: null, errors: [] }
  const entries = agent.skills ?? []
  const agentId = skillsAgentId(agent.runtime)
  // Include the mapped agent id in the fingerprint so a runtime switch re-runs
  // (the target dir changes); an unmapped runtime installs nothing but must still
  // reconcile away copies from a prior mapped runtime.
  const fp = fingerprint(agent.runtime, agentId ?? '', entries)

  const prior = readMarker(cwd)
  if (prior.fingerprint === fp) {
    result.skipped = 'unchanged'
    return result
  }

  // Reconcile: remove exactly the dirs we created last time (disable / narrow /
  // runtime change / zero-desired all pass through here). Manually-authored skills
  // are never in `prior.installed`, so they survive.
  for (const rel of prior.installed) {
    try {
      rmSync(join(cwd, rel), { recursive: true, force: true })
      result.removed.push(rel)
    } catch {
      // best-effort
    }
  }

  if (entries.length === 0 || !agentId) {
    if (!agentId && entries.length > 0) {
      // P1: no native installer for this runtime; prompt-fallback is P2 (§6.5).
      opts.warn?.(`skills: no npx-skills mapping for runtime "${agent.runtime}"; skipping install`)
    }
    // Nothing to install, but the reconcile above happened — record the empty state.
    writeMarker(cwd, { fingerprint: fp, installed: [] })
    return result
  }

  const before = new Set(listSkillDirs(cwd))
  const env = { GIT_TERMINAL_PROMPT: '0', ...process.env, ...opts.env }
  for (const entry of entries) {
    const composed = composeSource(entry)
    const args = [
      '--yes',
      SKILLS_CLI_SPEC,
      'add',
      composed,
      '-a',
      agentId,
      '-y',
      '--copy',
      ...entry.skills.flatMap((s) => ['-s', s])
    ]
    try {
      await execFileAsync('npx', args, { cwd, env, timeout: INSTALL_TIMEOUT_MS })
      result.installed.push(entry.name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push({ source: entry.name, error: msg })
      opts.warn?.(`skills: install failed for "${entry.name}" (${composed}): ${msg}`)
    }
  }

  // Whatever appeared under the skill roots is ours to track (and later remove).
  const created = listSkillDirs(cwd).filter((p) => !before.has(p))
  excludeFromGit(cwd)
  // Record the created set always (so a later change can clean them up); commit the
  // fingerprint only on a fully-clean pass so a partial failure retries next session.
  writeMarker(cwd, { ...(result.errors.length === 0 ? { fingerprint: fp } : {}), installed: created })
  return result
}
