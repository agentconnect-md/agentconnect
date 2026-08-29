/**
 * Keep the daemon's own installed content out of `git status`.
 *
 * Skill bundles are written INTO the checkout (`.claude/skills/<bundle>/`) and are untracked, so
 * every session worktree reports dirty forever — and the session-retention GC, which promises never
 * to auto-delete untracked work, then refuses to reclaim any of them. The registrations accumulate
 * until the runtime's own sandbox profile (one deny path per registered worktree) overflows the OS
 * exec argument limit and no command can spawn at all. These are the daemon's files, not a user's,
 * so it is the daemon's job to declare them uninteresting.
 *
 * The patterns go in `info/exclude` of the COMMON directory — Git resolves that path there rather
 * than per worktree, which is what we want: every worktree of a clone installs the same bundles.
 */
import { promises as fsp } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const BEGIN = '# BEGIN agentconnect-managed skills'
const END = '# END agentconnect-managed skills'

/**
 * Re-express bundle roots, which the installer reports relative to the ACP cwd, against the
 * checkout root that an exclude pattern anchors to. The two differ for an `agentDir` agent, whose
 * cwd sits below the checkout. A root that escapes the checkout is dropped rather than anchored
 * wrong — the worktree stays dirty, which is the behaviour we already had.
 */
export function bundlePathsFromCheckoutRoot(checkoutRoot: string, cwd: string, relativeRoots: string[]): string[] {
  return relativeRoots
    .map((root) => relative(checkoutRoot, join(cwd, root)).split(sep).join('/'))
    .filter((root) => root !== '' && !root.startsWith('../'))
}

/** Escape the gitignore metacharacters so a bundle directory can never act as a pattern. */
function excludePattern(relativeRoot: string): string {
  return `/${relativeRoot.replace(/[\\!#*?[\]]/g, (char) => `\\${char}`)}/`
}

/** Everything outside our marked block, which the daemon must preserve verbatim. */
function stripBlock(content: string): string {
  const begin = content.indexOf(BEGIN)
  if (begin < 0) return content
  const end = content.indexOf(END, begin)
  if (end < 0) return content.slice(0, begin)
  return content.slice(0, begin) + content.slice(end + END.length).replace(/^\r?\n/, '')
}

/**
 * Declare `relativeRoots` (checkout-relative bundle directories) daemon-owned in `commonDir`.
 *
 * Idempotent and total: the block is REPLACED, so a bundle the agent no longer installs stops being
 * excluded. Written through a rename so a concurrent reader never sees a partial file; two sessions
 * of one agent write identical content, and a lost update self-heals on the next preparation.
 */
export async function excludeManagedSkillBundles(commonDir: string, relativeRoots: string[]): Promise<void> {
  const file = join(commonDir, 'info', 'exclude')
  const current = await fsp.readFile(file, 'utf8').catch(() => '')
  const kept = stripBlock(current)
  const patterns = [...new Set(relativeRoots.map(excludePattern))].sort()
  const block = patterns.length === 0 ? '' : `${[BEGIN, ...patterns, END].join('\n')}\n`
  const head = kept === '' || kept.endsWith('\n') ? kept : `${kept}\n`
  const next = block === '' ? kept : `${head}${block}`
  if (next === current) return
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.agentconnect-${process.pid}`
  await fsp.writeFile(tmp, next, { mode: 0o644 })
  await fsp.rename(tmp, file).catch(async (err: unknown) => {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  })
}
