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
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function readMarker(cwd: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(markerPath(cwd), 'utf8')) as { fingerprint?: unknown }
    return typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined
  } catch {
    return undefined
  }
}

function writeMarker(cwd: string, fp: string): void {
  try {
    mkdirSync(join(cwd, MARKER_DIR), { recursive: true })
    writeFileSync(markerPath(cwd), JSON.stringify({ fingerprint: fp }) + '\n')
  } catch {
    // A missing marker only costs a redundant re-install next session — never fatal.
  }
}

/** Keep installed skill dirs out of a git-repo workspace's tracked tree so the
 *  agent's `git status` stays clean. Best-effort; from-scratch workspaces have no
 *  `.git` and are skipped. */
function excludeFromGit(cwd: string): void {
  const exclude = join(cwd, '.git', 'info', 'exclude')
  if (!existsSync(exclude)) return
  try {
    const current = readFileSync(exclude, 'utf8')
    const want = ['.claude/skills/', '.agentconnect/'].filter((p) => !current.includes(p))
    if (want.length) appendFileSync(exclude, (current.endsWith('\n') ? '' : '\n') + want.join('\n') + '\n')
  } catch {
    // ignore — a dirty status is cosmetic, not correctness
  }
}

export interface InstallSkillsResult {
  installed: string[]
  skipped: 'unchanged' | 'no-skills' | 'no-runtime-mapping' | null
  errors: Array<{ source: string; error: string }>
}

/**
 * Install `agent.skills` into `cwd`. Never throws. `env` is merged into the child
 * (git credential helper vars for private sources, GIT_TERMINAL_PROMPT=0, etc.);
 * `warn` receives non-fatal diagnostics.
 */
export async function installSkills(
  agent: Pick<Agent, 'id' | 'runtime' | 'skills'>,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {}
): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = { installed: [], skipped: null, errors: [] }
  const entries = agent.skills ?? []
  if (entries.length === 0) {
    result.skipped = 'no-skills'
    return result
  }

  const agentId = skillsAgentId(agent.runtime)
  if (!agentId) {
    // P1: no native installer for this runtime; prompt-fallback is P2 (§6.5).
    opts.warn?.(`skills: no npx-skills mapping for runtime "${agent.runtime}"; skipping install`)
    result.skipped = 'no-runtime-mapping'
    return result
  }

  const fp = fingerprint(agent.runtime, agent.id, entries)
  if (readMarker(cwd) === fp) {
    result.skipped = 'unchanged'
    return result
  }

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

  excludeFromGit(cwd)
  // Only fingerprint a fully-clean pass — a partial failure should retry next session.
  if (result.errors.length === 0) writeMarker(cwd, fp)
  return result
}
