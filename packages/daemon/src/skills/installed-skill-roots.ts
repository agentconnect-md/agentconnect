import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { MAX_SKILL_LEDGER_BYTES } from './skill-install-ledger.js'

// The runtime skill roots the daemon installs into and the harnesses load from (shared-skills.md §6); one is
// commonly a link to another, so a bundle is named under each root that reaches it.
const SKILL_ROOTS = ['.claude/skills', '.agents/skills', '.opencode/skills'] as const

/**
 * Every daemon state root a workspace's skill ledger can live under: the daemon's own `skill-installs`, the
 * agent-local installer default, and the sandbox shim's in-workspace state.
 */
export function skillLedgerStateDirs(cwd: string, scopeDir: string, daemonRoot?: string): string[] {
  return [
    ...(daemonRoot ? [join(daemonRoot, 'skill-installs')] : []),
    join(scopeDir, '.agentconnect', 'skill-installer'),
    join(cwd, '.agentconnect', 'cluster-skill-state')
  ]
}

/**
 * The skill bundles the daemon's ledger owns in `cwd`, as absolute paths. The model's tools read and run them and
 * never change them: an edit is lost at the next publication, and a directory left behind in one (a bytecode cache,
 * an editor's staging dir) makes its receipt walk refuse that publication. Read-only, so a missing or unreadable
 * ledger yields no roots. The ledger's own integrity checks stay with its owner (`readSkillLedger`); this read
 * only decides which paths the launch names read-only.
 */
export function installedSkillRoots(cwd: string, stateDirs: readonly string[]): string[] {
  let key: string
  let cwdReal: string
  try {
    const lexical = resolve(cwd)
    const stat = lstatSync(lexical, { bigint: true })
    if (!stat.isDirectory()) return []
    cwdReal = realpathSync(lexical)
    key = createHash('sha256')
      .update(cwdReal)
      .update('\0')
      .update(stat.dev.toString())
      .update('\0')
      .update(stat.ino.toString())
      .digest('hex')
  } catch {
    return []
  }
  const roots = new Set<string>()
  for (const stateDir of stateDirs) {
    for (const relativeRoot of ownedRelativeRoots(join(stateDir, 'workspace-skills', `${key}.json`))) {
      const canonical = join(cwdReal, ...relativeRoot.split('/'))
      if (!existsSync(canonical)) continue
      roots.add(canonical)
      let target: string
      try {
        target = realpathSync(canonical)
      } catch {
        continue
      }
      for (const root of SKILL_ROOTS) {
        const alias = join(cwdReal, root, basename(relativeRoot))
        if (alias === canonical || !existsSync(alias)) continue
        try {
          if (realpathSync(alias) === target) roots.add(alias)
        } catch {
          // An alias that cannot be resolved is not one.
        }
      }
    }
  }
  return [...roots].sort()
}

function ownedRelativeRoots(file: string): string[] {
  let ledger: unknown
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_SKILL_LEDGER_BYTES) return []
    ledger = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!ledger || typeof ledger !== 'object') return []
  const { phase, owned, prior } = ledger as { phase?: unknown; owned?: unknown; prior?: unknown }
  // A publication interrupted mid-way still owns the set it set out from.
  const bundles = phase === 'ready' ? owned : phase === 'applying' ? prior : undefined
  if (!Array.isArray(bundles)) return []
  return bundles.flatMap((bundle) => {
    const relativeRoot = (bundle as { relativeRoot?: unknown })?.relativeRoot
    return typeof relativeRoot === 'string' && safeRelativeRoot(relativeRoot) ? [relativeRoot] : []
  })
}

function safeRelativeRoot(value: string): boolean {
  if (isAbsolute(value) || value.includes('\0') || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.length >= 2 && parts.every((part) => part !== '' && part !== '.' && part !== '..')
}
